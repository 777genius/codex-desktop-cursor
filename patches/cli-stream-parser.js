import { readSessionIdFromObject } from "./cursor-turn.js";
import { traceInbound } from "./stream-trace.js";

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function contentParts(obj) {
    if (!obj || typeof obj !== "object")
        return [];
    const direct = obj.message?.content ?? obj.content;
    if (Array.isArray(direct))
        return direct;
    if (direct && typeof direct === "object")
        return [direct];
    return [];
}

function partText(part) {
    if (!part || typeof part !== "object")
        return "";
    if (part.type === "text" && typeof part.text === "string")
        return part.text;
    if (typeof part.text === "string" && (!part.type || part.type === "output_text" || part.type === "input_text"))
        return part.text;
    return "";
}

export function assistantTextFromEvent(obj) {
    if (!obj || typeof obj !== "object")
        return "";
    if (typeof obj.text === "string" && obj.type === "assistant")
        return obj.text;
    if (typeof obj.delta === "string" && obj.type !== "thinking" && obj.type !== "tool_call")
        return obj.delta;
    if (obj.delta && typeof obj.delta.text === "string" && obj.type !== "thinking")
        return obj.delta.text;
    if (obj.type && obj.type !== "assistant" && obj.type !== "text")
        return "";
    return asArray(contentParts(obj)).map(partText).filter(Boolean).join("");
}

function prettyToolName(key) {
    const base = String(key || "").replace(/ToolCall$/i, "").trim();
    if (!base)
        return "";
    return base
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/^./, (c) => c.toUpperCase());
}

function looksLikeJsonBlob(value) {
    const s = String(value || "").trim();
    return s.startsWith("{") || s.startsWith("[");
}

function jsonish(value) {
    if (value == null)
        return "";
    if (typeof value === "string")
        return value;
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}

function resultText(value) {
    if (value == null)
        return "";
    if (typeof value === "string")
        return value;
    const nested = value.success || value.failure || value.output || value.stdout;
    if (typeof nested === "string")
        return nested;
    if (nested && typeof nested === "object") {
        const stdout = nested.stdout ?? nested.output ?? nested.text;
        if (typeof stdout === "string")
            return stdout;
        const stderr = nested.stderr ?? nested.error;
        if (typeof stderr === "string")
            return stderr;
    }
    return jsonish(value);
}

function firstToolCallBlob(obj) {
    const candidates = [obj?.tool_call, obj?.toolCall, obj?.call, obj];
    for (const blob of candidates) {
        if (!blob || typeof blob !== "object")
            continue;
        for (const [key, value] of Object.entries(blob)) {
            if (/ToolCall$/i.test(key) && value && typeof value === "object") {
                return { key, value };
            }
        }
    }
    return undefined;
}

export function resultAssistantText(obj) {
    if (!obj || typeof obj !== "object")
        return "";
    if (typeof obj.result === "string")
        return obj.result;
    if (typeof obj.error === "string")
        return obj.error;
    if (typeof obj.message === "string" && obj.type === "error")
        return obj.message;
    const nested = obj.result;
    if (nested && typeof nested === "object") {
        if (typeof nested.text === "string")
            return nested.text;
        if (typeof nested.result === "string")
            return nested.result;
        if (typeof nested.content === "string")
            return nested.content;
        if (Array.isArray(nested.content))
            return nested.content.map(partText).filter(Boolean).join("");
        const parts = nested.message?.content;
        if (Array.isArray(parts))
            return parts.map(partText).filter(Boolean).join("");
    }
    return "";
}

export function parseToolCallEvent(obj) {
    if (!obj || typeof obj !== "object")
        return undefined;
    const type = String(obj.type || "");
    const subtype = String(obj.subtype || "");
    if (subtype === "delta" || subtype === "partial" || type === "tool_call_delta")
        return undefined;
    const parts = contentParts(obj);
    const toolParts = parts.filter((p) => {
        const t = String(p?.type || "");
        return t === "tool-call" || t === "tool_call" || t === "tool_use" || t === "function_call";
    });
    const isToolEvent = type === "tool_call" || type === "tool-call" || type === "tool_use" || toolParts.length > 0;
    if (!isToolEvent)
        return undefined;
    const phase = subtype === "completed" || subtype === "error" || subtype === "failed"
        || type === "tool_result" || type === "tool-result"
        ? "completed"
        : "started";
    const nested = firstToolCallBlob(obj);
    const part = toolParts[0];
    const data = nested?.value || part || obj;
    let args = data.args || data.arguments || data.input || part?.args || part?.input || {};
    if (typeof args === "string") {
        try {
            args = JSON.parse(args);
        }
        catch {
            args = { raw: args };
        }
    }
    if (args && typeof args === "object" && !Array.isArray(args)) {
        const inner = args.args ?? args.arguments;
        const mcpName = args.toolName || args.tool_name || args.name;
        if (mcpName && inner != null) {
            let parsed = inner;
            if (typeof inner === "string") {
                try {
                    parsed = JSON.parse(inner);
                }
                catch {
                    parsed = { raw: inner };
                }
            }
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
                args = { ...args, ...parsed };
        }
    }
    const callId = String(obj.call_id || obj.callId || part?.toolCallId || args.toolCallId || args.tool_call_id || obj.id || "");
    const name = args.toolName || args.tool_name || prettyToolName(nested?.key) ||
        part?.toolName ||
        part?.name ||
        obj.name ||
        obj.toolName ||
        "";
    return {
        phase,
        callId,
        name: name || "tool",
        args,
        result: resultText(data.result ?? obj.result ?? data.output ?? args.result),
        argsJson: typeof args === "string" ? args : jsonish(args),
    };
}

export function thinkingDeltaFromEvent(obj) {
    if (!obj || typeof obj !== "object")
        return "";
    if (obj.type !== "thinking" && obj.type !== "reasoning") {
        return asArray(contentParts(obj))
            .filter((p) => p?.type === "thinking" || p?.type === "reasoning")
            .map((p) => (typeof p.text === "string" ? p.text : typeof p.thinking === "string" ? p.thinking : ""))
            .filter(Boolean)
            .join("");
    }
    if (obj.subtype === "completed")
        return "";
    if (typeof obj.text === "string")
        return obj.text;
    if (typeof obj.delta === "string")
        return obj.delta;
    if (obj.delta && typeof obj.delta.text === "string")
        return obj.delta.text;
    if (typeof obj.thinking === "string")
        return obj.thinking;
    return "";
}

/**
 * Cursor CLI stream-json parser.
 *
 * onEvent receives structured thinking/tool events for the Codex Responses
 * contract. Assistant prose still goes through onText.
 */
export function createStreamParser(onText, onDone, onSessionId, onEvent) {
    let accumulated = "";
    let thinkingAccumulated = "";
    let done = false;
    let sessionNoted = false;
    const seenTools = new Set();
    let loggedTypes = 0;
    const seenTypes = new Set();
    return (line) => {
        if (done)
            return;
        try {
            const obj = JSON.parse(line);
            const typeKey = `${obj.type || "?"} ${obj.subtype || ""}`.trim();
            if (loggedTypes < 12 && !seenTypes.has(typeKey)) {
                seenTypes.add(typeKey);
                loggedTypes += 1;
                console.log(`[stream-json] ${typeKey}`);
            }
            if (!sessionNoted && onSessionId) {
                const sessionId = readSessionIdFromObject(obj);
                if (sessionId) {
                    sessionNoted = true;
                    onSessionId(sessionId);
                }
            }
            const tool = parseToolCallEvent(obj);
            if (tool) {
                const key = tool.callId
                    ? `${tool.phase}:${tool.callId}`
                    : `${tool.phase}:${tool.name}:${tool.argsJson.slice(0, 80)}`;
                if (!seenTools.has(key)) {
                    seenTools.add(key);
                    if (onEvent)
                        onEvent({ type: "tool", ...tool });
                }
                traceInbound(obj, "tool");
            }
            const thinking = thinkingDeltaFromEvent(obj);
            if (thinking && onEvent) {
                if (obj.subtype === "delta") {
                    onEvent({ type: "thinking", text: thinking });
                }
                else if (thinking !== thinkingAccumulated) {
                    const delta = thinking.startsWith(thinkingAccumulated)
                        ? thinking.slice(thinkingAccumulated.length)
                        : thinking;
                    if (delta)
                        onEvent({ type: "thinking", text: delta });
                    thinkingAccumulated = thinking.startsWith(thinkingAccumulated)
                        ? thinking
                        : thinkingAccumulated + thinking;
                }
                if (!tool)
                    traceInbound(obj, "thinking");
            }
            const text = assistantTextFromEvent(obj);
            if (text && (obj.type === "assistant" || obj.type === "text")) {
                if (text === accumulated)
                    return;
                if (text.startsWith(accumulated) && accumulated.length > 0) {
                    const delta = text.slice(accumulated.length);
                    if (delta)
                        onText(delta);
                    accumulated = text;
                }
                else {
                    onText(text);
                    accumulated += text;
                }
                if (!tool && !thinking)
                    traceInbound(obj, "text");
            }
            else if (!tool && !thinking) {
                let mapped = "ignored";
                if (obj.type === "result")
                    mapped = "result";
                else if (obj.type === "error")
                    mapped = "error";
                else if (obj.type === "system" || obj.type === "user")
                    mapped = "meta";
                else if (obj.type === "thinking" || obj.type === "reasoning")
                    mapped = "thinking_done";
                else if (obj.type === "assistant" || obj.type === "text")
                    mapped = "text_empty";
                else if (obj.type === "tool_call" && (obj.subtype === "delta" || obj.subtype === "partial"))
                    mapped = "tool_delta";
                traceInbound(obj, mapped);
            }
            if (obj.type === "result" || obj.type === "error") {
                const full = resultAssistantText(obj);
                if (full && full !== accumulated && !looksLikeJsonBlob(full)) {
                    if (!accumulated) {
                        onText(full);
                        accumulated = full;
                    }
                    else if (full.startsWith(accumulated)) {
                        const delta = full.slice(accumulated.length);
                        if (delta)
                            onText(delta);
                        accumulated = full;
                    }
                }
                done = true;
                onDone();
            }
        }
        catch {
            /* ignore parse errors for non-JSON lines */
        }
    };
}
