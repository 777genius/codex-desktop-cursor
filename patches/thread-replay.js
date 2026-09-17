import { createHash } from "node:crypto";

const DUP_WINDOW_MS = 10 * 60 * 1000;
const MAX_EVENTS = 8000;
const THINKING_CAP = 32000;
const live = new Map();

export function promptHash(text) {
    return createHash("sha256").update(text || "").digest("hex").slice(0, 32);
}

export function rewriteResponseId(data, fromId, toId) {
    if (data == null || !fromId || !toId || fromId === toId)
        return data;
    const walk = (value) => {
        if (Array.isArray(value))
            return value.map(walk);
        if (value && typeof value === "object") {
            const out = {};
            for (const [key, val] of Object.entries(value)) {
                if ((key === "id" || key === "response_id") && val === fromId)
                    out[key] = toId;
                else
                    out[key] = walk(val);
            }
            return out;
        }
        return value;
    };
    return walk(data);
}

export function peekLiveTurn(threadKey) {
    if (!threadKey)
        return undefined;
    const rec = live.get(threadKey);
    if (!rec || rec.done)
        return undefined;
    return rec;
}

export function getLiveTurn(threadKey, hash) {
    if (!threadKey || !hash)
        return undefined;
    const rec = live.get(threadKey);
    if (!rec || rec.hash !== hash)
        return undefined;
    // In-flight turns stay visible past DUP_WINDOW so a 5-minute Desktop
    // retry can reattach instead of spawning a second --resume.
    if (rec.done && Date.now() - rec.startedAt > DUP_WINDOW_MS)
        return undefined;
    return rec;
}

export function beginLiveTurn(threadKey, hash, meta = {}) {
    if (!threadKey || !hash)
        return undefined;
    let resolveFinished;
    const rec = {
        hash,
        events: [],
        done: false,
        startedAt: Date.now(),
        primaryId: meta.responseId,
        sinks: meta.res && meta.responseId ? [{ res: meta.res, id: meta.responseId }] : [],
        finished: new Promise((resolve) => {
            resolveFinished = resolve;
        }),
        _resolveFinished: () => resolveFinished(rec),
    };
    live.set(threadKey, rec);
    return rec;
}

export function addLiveSink(threadKey, sink) {
    const rec = live.get(threadKey);
    if (!rec || rec.done || !sink?.res || !sink.id)
        return false;
    rec.sinks = (rec.sinks || []).filter((s) => s?.res && !s.res.writableEnded && !s.res.destroyed);
    rec.sinks.push(sink);
    return true;
}

export function waitLiveTurn(threadKey) {
    const rec = live.get(threadKey);
    if (!rec)
        return Promise.resolve(undefined);
    return rec.finished;
}

export function getLiveRecord(threadKey) {
    return threadKey ? live.get(threadKey) : undefined;
}

export function bufferEvent(threadKey, type, data) {
    const rec = live.get(threadKey);
    if (!rec || rec.events.length >= MAX_EVENTS)
        return;
    rec.events.push({ type, data });
}

export function completeLiveTurn(threadKey) {
    const rec = live.get(threadKey);
    if (!rec)
        return;
    rec.done = true;
    rec.finalText = extractFinalText(rec);
    rec._resolveFinished?.(rec);
}

function commentaryIdsFrom(rec) {
    const ids = new Set();
    for (const ev of rec?.events || []) {
        const item = ev.data?.item;
        if (item?.type === "message" && item.phase === "commentary" && item.id)
            ids.add(item.id);
    }
    return ids;
}

function itemText(item) {
    if (!item)
        return "";
    if (typeof item.summary?.[0]?.text === "string")
        return item.summary[0].text;
    const parts = item.content;
    if (!Array.isArray(parts))
        return "";
    return parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
}

export function extractFinalText(rec) {
    if (!rec)
        return "";
    if (typeof rec.finalText === "string" && rec.finalText)
        return rec.finalText;
    const skip = commentaryIdsFrom(rec);
    let text = "";
    for (const ev of rec.events || []) {
        if (ev.type === "response.output_text.delta" && typeof ev.data?.delta === "string") {
            if (skip.has(ev.data.item_id))
                continue;
            text += ev.data.delta;
        }
        if (ev.type === "response.completed") {
            const done = ev.data?.response?.output_text;
            if (typeof done === "string" && done)
                text = done;
        }
    }
    rec.finalText = text;
    return text;
}

export function extractThinkingText(rec) {
    const commentary = commentaryIdsFrom(rec);
    let reasoning = "";
    let comments = "";
    for (const ev of rec.events || []) {
        if (ev.type === "response.reasoning_summary_text.delta" && typeof ev.data?.delta === "string") {
            if (/^\n?(shell_command|shell) (running|done)\n$/.test(ev.data.delta))
                continue;
            reasoning += ev.data.delta;
            continue;
        }
        if (ev.type === "response.output_text.delta" && typeof ev.data?.delta === "string" && commentary.has(ev.data.item_id))
            comments += ev.data.delta;
    }
    const text = reasoning || comments;
    if (text.length > THINKING_CAP)
        return `${text.slice(0, 12000)}\n…\n${text.slice(-12000)}`;
    return text;
}

export function extractTurnHistory(rec) {
    const steps = [];
    let thought = "";
    const isStub = (d) => /^\n?(shell_command|shell) (running|done)\n$/.test(d || "");
    const flushThought = () => {
        const text = thought.trim();
        thought = "";
        if (text)
            steps.push({ kind: "thought", text });
    };
    const absorbTool = (item) => {
        const command = Array.isArray(item.action?.command)
            ? item.action.command.join(" ")
            : "";
        let input = item.input || command || "";
        if (!input && typeof item.arguments === "string") {
            try {
                const parsed = JSON.parse(item.arguments);
                input = typeof parsed?.cmd === "string" ? parsed.cmd : item.arguments;
            }
            catch {
                input = item.arguments;
            }
        }
        else if (!input && item.arguments)
            input = String(item.arguments);
        const last = steps[steps.length - 1];
        if (last?.kind === "thought" && input && (last.text === input || last.text.endsWith(input) || last.text.includes(input)))
            steps.pop();
        steps.push({
            kind: "tool",
            name: item.name || (item.action ? "shell" : "tool"),
            input,
            output: "",
            callId: item.call_id,
        });
    };
    for (const ev of rec.events || []) {
        if (ev.type === "response.reasoning_summary_text.delta" && typeof ev.data?.delta === "string") {
            if (!isStub(ev.data.delta))
                thought += ev.data.delta;
            continue;
        }
        const item = ev.data?.item;
        if (ev.type === "response.output_item.done" && item?.type === "reasoning") {
            const text = (itemText(item) || thought).trim();
            thought = "";
            if (text && !isStub(text))
                steps.push({ kind: "thought", text });
            continue;
        }
        if (ev.type === "response.output_item.done" && item?.type === "message" && item.phase === "commentary") {
            flushThought();
            const text = itemText(item).trim();
            const last = steps[steps.length - 1];
            if (text && last?.kind === "thought" && last.text === text)
                continue;
            if (text && !isStub(text))
                steps.push({ kind: "thought", text });
            continue;
        }
        if (ev.type === "response.output_item.added" && item && (
            item.type === "custom_tool_call" ||
            item.type === "function_call" ||
            item.type === "local_shell_call" ||
            item.type === "web_search_call"
        )) {
            flushThought();
            if (item.type === "web_search_call") {
                const last = steps[steps.length - 1];
                const query = item.action?.query || "";
                if (last?.kind === "thought" && query && last.text.includes(query))
                    steps.pop();
                steps.push({
                    kind: "tool",
                    name: "web_search",
                    input: query,
                    output: "",
                    callId: item.id,
                });
                continue;
            }
            absorbTool(item);
            continue;
        }
        if (item && (item.type === "custom_tool_call_output" || item.type === "function_call_output" || item.type === "local_shell_call_output")) {
            const out = typeof item.output === "string" ? item.output : "";
            for (let i = steps.length - 1; i >= 0; i--) {
                if (steps[i].kind === "tool" && (!item.call_id || steps[i].callId === item.call_id)) {
                    steps[i].output = out;
                    break;
                }
            }
        }
    }
    flushThought();
    return steps;
}

export function isDuplicateLastUser(session, hash) {
    if (!session?.lastPromptHash || !hash)
        return false;
    if (session.lastPromptHash !== hash)
        return false;
    if (!session.lastPromptAt)
        return false;
    return Date.now() - session.lastPromptAt < DUP_WINDOW_MS;
}
