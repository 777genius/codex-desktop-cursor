import { randomUUID } from "node:crypto";

const RESULT_LIMIT = 8000;

function compactId(prefix) {
    return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function clip(text) {
    if (typeof text !== "string")
        return "";
    if (text.length <= RESULT_LIMIT)
        return text;
    return `${text.slice(0, RESULT_LIMIT)}\n…`;
}

function shellArgs(args) {
    if (!args || typeof args !== "object")
        return args;
    const command = args.command ?? args.cmd ?? args.commandChars;
    const workingDirectory = args.working_directory ?? args.workingDirectory ?? args.cwd;
    const timeoutMs = args.timeout_ms ?? args.timeoutMs ?? args.timeout;
    const out = {};
    if (command != null)
        out.command = command;
    if (workingDirectory)
        out.working_directory = workingDirectory;
    if (timeoutMs != null)
        out.timeout_ms = timeoutMs;
    return Object.keys(out).length ? out : args;
}

function toolKey(cursorName) {
    return String(cursorName || "tool").replace(/\s+/g, "").toLowerCase();
}

export function codexToolName(cursorName, args) {
    const key = toolKey(cursorName);
    if (key === "shell" || key === "pibash" || key === "shellcommand" || key === "shell_command")
        return "shell";
    if (key === "edit" || key === "delete" || key === "strreplace" || key === "write" || key === "applyagentdiff" || key === "piwrite" || key === "piedit")
        return "apply_patch";
    if (key === "grep" || key === "rg" || key === "glob" || key === "globfile" || key === "websearch" || key === "webfetch" || key === "codesearch")
        return "web_search";
    if (key === "mcp")
        return args?.toolName || args?.name || args?.tool || "mcp";
    return String(cursorName || "tool").replace(/\s+/g, "_");
}

export function isWebSearchTool(cursorName) {
    const key = toolKey(cursorName);
    return key === "websearch" || key === "webfetch" || key === "web_search" || key === "web_fetch";
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function clipCmd(cmd, max = 220) {
    const s = String(cmd || "").replace(/\s+/g, " ").trim();
    if (s.length <= max)
        return s;
    return `${s.slice(0, max - 1)}…`;
}

/** Commands parse_command classifies as Read/Search/ListFiles — native exec titles. */
const LOCAL_PARSE_CMD = /^(cat|sed|head|tail|bat|batcat|less|more|awk|rg|rga|grep|egrep|fgrep|ag|ack|find|ls|tree|fd|eza|exa|git)\b/;

/**
 * Unified exec `cmd` for Desktop's one commandExecution widget.
 * Read/rg/ls stay literal so parsedCmd becomes Read/Search/ListFiles.
 * ssh and other shell stay visible in a Ran card but run as `: '…'` so
 * Desktop does not re-execute production commands.
 */
export function displayExecCmd(cursorName, args, viewText) {
    const key = toolKey(cursorName);
    const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const filePath = String(a.path || a.target_directory || a.targetDirectory || a.file_path || a.filePath || "");
    if (["read", "readfile"].includes(key) && filePath) {
        const offset = Number(a.offset);
        const limit = Number(a.limit);
        if (Number.isFinite(offset) && Number.isFinite(limit) && limit > 0) {
            const from = Math.max(1, Math.floor(offset));
            const to = from + Math.floor(limit) - 1;
            return clipCmd(`sed -n ${shellQuote(`${from},${to}p`)} ${shellQuote(filePath)}`);
        }
        return clipCmd(`cat ${shellQuote(filePath)}`);
    }
    if (["grep", "rg", "codesearch"].includes(key)) {
        const q = String(a.pattern || a.query || "");
        return clipCmd(filePath ? `rg -n ${shellQuote(q)} ${shellQuote(filePath)}` : `rg -n ${shellQuote(q)}`);
    }
    if (["glob", "globfile"].includes(key)) {
        const glob = String(a.glob_pattern || a.globPattern || a.pattern || a.glob || "*");
        return clipCmd(`find ${shellQuote(filePath || ".")} -name ${shellQuote(glob)}`);
    }
    const raw = a.command ?? a.cmd ?? a.commandChars ?? viewText ?? key;
    const cmd = Array.isArray(raw) ? raw.map(String).join(" ") : String(raw || "true").trim();
    if (LOCAL_PARSE_CMD.test(cmd))
        return clipCmd(cmd);
    return clipCmd(`: ${shellQuote(cmd)}`);
}

/** Map a Cursor tool into a native Responses item (web search vs local shell). */
export function describeCursorTool(cursorName, args) {
    const key = toolKey(cursorName);
    const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const filePath = a.path || a.target_directory || a.targetDirectory || a.file_path || a.filePath || "";
    if (isWebSearchTool(cursorName)) {
        const query = a.pattern || a.search_term || a.searchTerm || a.query || a.url || "";
        return { kind: "search", text: [query, filePath].filter(Boolean).join(" ").trim() };
    }
    if (a.command != null || a.cmd != null || a.commandChars != null) {
        const cmd = a.command ?? a.cmd ?? a.commandChars;
        return { kind: "command", text: Array.isArray(cmd) ? cmd.map(String).join(" ") : String(cmd || "") };
    }
    if (["grep", "rg", "glob", "globfile", "codesearch", "search"].includes(key)) {
        const query = a.pattern || a.search_term || a.searchTerm || a.query || a.glob_pattern || a.globPattern || a.glob || "";
        return { kind: "command", text: [query, filePath].filter(Boolean).join(" ").trim() };
    }
    if (["read", "readfile"].includes(key)) {
        const offset = a.offset;
        const limit = a.limit;
        if (filePath && offset != null && limit != null)
            return { kind: "command", text: `${filePath}:${offset}-${Number(offset) + Number(limit)}` };
        return { kind: "command", text: filePath || "read" };
    }
    if (["edit", "delete", "strreplace", "write", "applyagentdiff", "piwrite", "piedit"].includes(key))
        return { kind: "command", text: filePath || "apply_patch" };
    if (typeof args === "string")
        return { kind: "command", text: args };
    return { kind: "command", text: toolInput(codexToolName(cursorName, args), args) };
}

function toolInput(name, args) {
    if (name === "shell") {
        const cmd = args?.command ?? args?.cmd ?? args?.commandChars;
        if (typeof cmd === "string")
            return cmd;
        if (Array.isArray(cmd))
            return cmd.map(String).join(" ");
    }
    if (typeof args === "string")
        return args;
    try {
        return JSON.stringify(args ?? {});
    }
    catch {
        return "";
    }
}

export function createResponsesNativeStream(opts) {
    const { res, writeEvent: writeEventRaw, responseId, body, displayModel, createdAt, promptTokens } = opts;
    const seenSse = new Set();
    const writeEvent = (type, data) => {
        if (seenSse.size < 20 && !seenSse.has(type)) {
            seenSse.add(type);
            console.log(`[sse] ${type}`);
        }
        return writeEventRaw(type, data);
    };
    let outputIndex = 0;
    let commentary;
    let reasoning;
    let message;
    let text = "";
    let finished = false;
    const tools = new Map();
    const output = [];

    const nextIndex = () => outputIndex++;

    const emitMessageItem = (item, { streamText } = {}) => {
        const index = item._index;
        writeEvent("response.output_item.added", {
            response_id: responseId,
            output_index: index,
            item: {
                id: item.id,
                type: "message",
                status: "in_progress",
                role: "assistant",
                phase: item.phase,
                content: [],
            },
        });
        writeEvent("response.content_part.added", {
            response_id: responseId,
            item_id: item.id,
            output_index: index,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
        });
        if (streamText) {
            writeEvent("response.output_text.delta", {
                response_id: responseId,
                item_id: item.id,
                output_index: index,
                content_index: 0,
                delta: streamText,
            });
        }
    };

    const completeMessageItem = (item, body) => {
        const index = item._index;
        const content = [{ type: "output_text", text: body, annotations: [] }];
        writeEvent("response.output_text.done", {
            response_id: responseId,
            item_id: item.id,
            output_index: index,
            content_index: 0,
            text: body,
        });
        writeEvent("response.content_part.done", {
            response_id: responseId,
            item_id: item.id,
            output_index: index,
            content_index: 0,
            part: content[0],
        });
        const done = {
            id: item.id,
            type: "message",
            status: "completed",
            role: "assistant",
            phase: item.phase,
            content,
        };
        writeEvent("response.output_item.done", {
            response_id: responseId,
            output_index: index,
            item: done,
        });
        output.push(done);
    };

    const startCommentary = () => {
        if (commentary)
            return;
        const itemId = compactId("msg");
        const index = nextIndex();
        commentary = { id: itemId, _index: index, phase: "commentary", text: "" };
        emitMessageItem(commentary);
    };

    const closeCommentary = () => {
        if (!commentary)
            return;
        completeMessageItem(commentary, commentary.text);
        commentary = undefined;
    };

    const reasoningItem = (id, summaryText) => ({
        id,
        type: "reasoning",
        summary: summaryText == null ? [] : [{ type: "summary_text", text: summaryText }],
    });

    const startReasoning = () => {
        if (reasoning)
            return;
        const itemId = compactId("rs");
        const index = nextIndex();
        reasoning = { id: itemId, _index: index, text: "", partAdded: false };
        writeEvent("response.output_item.added", {
            response_id: responseId,
            output_index: index,
            item: reasoningItem(itemId),
        });
    };

    const ensureReasoningPart = () => {
        if (!reasoning || reasoning.partAdded)
            return;
        reasoning.partAdded = true;
        writeEvent("response.reasoning_summary_part.added", {
            response_id: responseId,
            item_id: reasoning.id,
            output_index: reasoning._index,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
        });
    };

    const closeReasoning = () => {
        if (!reasoning)
            return;
        ensureReasoningPart();
        const body = reasoning.text;
        writeEvent("response.reasoning_summary_text.done", {
            response_id: responseId,
            item_id: reasoning.id,
            output_index: reasoning._index,
            summary_index: 0,
            text: body,
        });
        writeEvent("response.reasoning_summary_part.done", {
            response_id: responseId,
            item_id: reasoning.id,
            output_index: reasoning._index,
            summary_index: 0,
            part: { type: "summary_text", text: body },
        });
        const done = reasoningItem(reasoning.id, body);
        writeEvent("response.output_item.done", {
            response_id: responseId,
            output_index: reasoning._index,
            item: done,
        });
        output.push(done);
        reasoning = undefined;
    };

    const emitToolCommentary = (line) => {
        const clipped = line.length > 1500 ? `${line.slice(0, 1500)}\n…` : line;
        if (!clipped)
            return;
        const itemId = compactId("msg");
        const index = nextIndex();
        const item = { id: itemId, _index: index, phase: "commentary" };
        emitMessageItem(item, { streamText: clipped });
        completeMessageItem(item, clipped);
    };

    const emitWebSearch = (query) => {
        let q = String(query || "").trim().replace(/\s+/g, " ");
        if (!q)
            return;
        if (q.length > 240)
            q = `${q.slice(0, 240)}…`;
        const itemId = compactId("ws");
        const index = nextIndex();
        const item = {
            id: itemId,
            type: "web_search_call",
            status: "in_progress",
            action: { type: "search", query: q },
        };
        writeEvent("response.output_item.added", {
            response_id: responseId,
            output_index: index,
            item,
        });
        const done = { ...item, status: "completed" };
        writeEvent("response.output_item.done", {
            response_id: responseId,
            output_index: index,
            item: done,
        });
        output.push(done);
        return { itemId, index, kind: "web_search", callId: itemId, input: q, done: true };
    };

    const completeExecCommand = (rec) => {
        if (!rec || rec.done || rec.kind !== "exec_command")
            return;
        const done = {
            id: rec.itemId,
            type: "function_call",
            status: "completed",
            call_id: rec.callId,
            name: "exec_command",
            arguments: rec.argumentsJson,
        };
        writeEvent("response.output_item.done", {
            response_id: responseId,
            output_index: rec.index,
            item: done,
        });
        output.push(done);
        rec.done = true;
    };

    const emitExecCommand = (callId, cmd, cwd) => {
        const itemId = compactId("fc");
        const index = nextIndex();
        const args = { cmd, tty: false, timeout_ms: 8000 };
        if (cwd)
            args.workdir = cwd;
        const argumentsJson = JSON.stringify(args);
        const item = {
            id: itemId,
            type: "function_call",
            status: "in_progress",
            call_id: callId,
            name: "exec_command",
            arguments: argumentsJson,
        };
        writeEvent("response.output_item.added", {
            response_id: responseId,
            output_index: index,
            item,
        });
        const rec = { itemId, index, kind: "exec_command", callId, input: cmd, cmd, cwd, argumentsJson, done: false };
        completeExecCommand(rec);
        return rec;
    };

    const onThinking = (delta) => {
        if (finished || !delta)
            return;
        startReasoning();
        ensureReasoningPart();
        reasoning.text += delta;
        writeEvent("response.reasoning_summary_text.delta", {
            response_id: responseId,
            item_id: reasoning.id,
            output_index: reasoning._index,
            summary_index: 0,
            delta,
        });
    };

    const onTool = (tool) => {
        if (finished)
            return;
        closeReasoning();
        closeCommentary();
        const callId = tool.callId || compactId("call");
        const argsObj = tool.args && typeof tool.args === "object" && !Array.isArray(tool.args) ? tool.args : {};
        let rec = tools.get(callId);
        if (!rec) {
            const view = describeCursorTool(tool.name, tool.args);
            if (isWebSearchTool(tool.name) && view.text) {
                tools.set(callId, emitWebSearch(view.text));
                return;
            }
            const cmd = displayExecCmd(tool.name, tool.args, view.text);
            const cwd = argsObj.working_directory || argsObj.workingDirectory || argsObj.cwd || "";
            rec = emitExecCommand(callId, cmd, cwd);
            tools.set(callId, rec);
        }
        if (rec && !rec.done && rec.kind === "exec_command")
            completeExecCommand(rec);
        else if (rec)
            rec.done = true;
    };

    const onText = (delta) => {
        if (finished || !delta)
            return text;
        closeReasoning();
        closeCommentary();
        if (!message) {
            const itemId = compactId("msg");
            const index = nextIndex();
            message = { id: itemId, _index: index, phase: "final_answer" };
            emitMessageItem(message);
        }
        text += delta;
        writeEvent("response.output_text.delta", {
            response_id: responseId,
            item_id: message.id,
            output_index: message._index,
            content_index: 0,
            delta,
        });
        return text;
    };

    const finish = () => {
        if (finished)
            return text;
        finished = true;
        closeReasoning();
        closeCommentary();
        for (const rec of tools.values()) {
            if (rec.done)
                continue;
            completeExecCommand(rec);
            rec.done = true;
        }
        if (message)
            completeMessageItem(message, text);
        const completionTokens = Math.max(1, Math.round(text.length / 4));
        writeEvent("response.completed", {
            response: {
                id: responseId,
                object: "response",
                created_at: createdAt,
                status: "completed",
                background: false,
                error: null,
                incomplete_details: null,
                instructions: body.instructions ?? null,
                max_output_tokens: body.max_output_tokens ?? null,
                model: displayModel,
                output,
                output_text: text,
                parallel_tool_calls: body.parallel_tool_calls ?? true,
                previous_response_id: body.previous_response_id ?? null,
                reasoning: body.reasoning ?? null,
                service_tier: body.service_tier ?? "default",
                store: body.store ?? false,
                temperature: body.temperature ?? null,
                text: body.text ?? { format: { type: "text" } },
                tool_choice: body.tool_choice ?? "auto",
                tools: body.tools ?? [],
                top_p: body.top_p ?? null,
                truncation: body.truncation ?? "disabled",
                usage: {
                    input_tokens: promptTokens,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens: completionTokens,
                    output_tokens_details: { reasoning_tokens: 0 },
                    total_tokens: promptTokens + completionTokens,
                },
                user: body.user ?? null,
                metadata: body.metadata ?? null,
            },
        });
        try {
            if (!opts.fanoutDone && !res.writableEnded && !res.destroyed)
                res.write("data: [DONE]\n\n");
        }
        catch {
            /* client gone; events may still be buffered for Desktop retry */
        }
        return text;
    };

    return {
        onThinking,
        onTool,
        onText,
        closeReasoning,
        finish,
        getText: () => text,
        isFinished: () => finished,
    };
}

export function emitCompactReplay(opts) {
    const { res, writeEvent, responseId, body, displayModel, createdAt, text, thinking } = opts;
    const native = createResponsesNativeStream({
        res,
        writeEvent,
        responseId,
        body,
        displayModel,
        createdAt,
        promptTokens: 1,
    });
    writeEvent("response.created", {
        response: {
            id: responseId,
            object: "response",
            created_at: createdAt,
            status: "in_progress",
            model: displayModel,
            output: [],
        },
    });
    if (thinking)
        native.onThinking(thinking);
    if (text)
        native.onText(text);
    native.finish();
    return native;
}

/**
 * Desktop reconnect while cursor-agent is still running.
 * Mixin errors on a hanging created-only stream, but response.completed
 * with no assistant text marks the Desktop turn finished (019fc3aa 09:19).
 * Send thinking, keep the HTTP SSE open, complete later via emitCompactContinue.
 */
export function emitInFlightSnapshot(opts) {
    const { writeEvent, responseId, body, displayModel, createdAt, thinking, history } = opts;
    const native = createResponsesNativeStream({
        res: opts.res,
        writeEvent,
        responseId,
        body: body || {},
        displayModel,
        createdAt,
        promptTokens: 1,
        fanoutDone: true,
    });
    writeEvent("response.created", {
        response: {
            id: responseId,
            object: "response",
            created_at: createdAt,
            status: "in_progress",
            model: displayModel,
            output: [],
        },
    });
    const steps = Array.isArray(history) ? history : [];
    if (steps.length) {
        for (const step of steps) {
            if (step.kind === "thought" && step.text)
                native.onThinking(step.text);
            native.closeReasoning();
            // Do not replay tools as exec_command: Desktop re-runs them,
            // then POSTs thousands of function_call_outputs and the turn
            // collapses into Reconnecting / error decoding response body.
        }
        return native;
    }
    native.onThinking(thinking || "Working…");
    native.closeReasoning();
    return native;
}

/** After response.created already went out on a reattached Desktop socket. */
export function emitCompactContinue(opts) {
    const { res, writeEvent, responseId, body, displayModel, createdAt, text, thinking } = opts;
    const native = createResponsesNativeStream({
        res,
        writeEvent,
        responseId,
        body,
        displayModel,
        createdAt,
        promptTokens: 1,
    });
    if (thinking)
        native.onThinking(thinking);
    if (text)
        native.onText(text);
    native.finish();
    return native;
}

export function emitFailed(opts) {
    const { writeEvent, responseId, createdAt, displayModel, message } = opts;
    writeEvent("response.failed", {
        response: {
            id: responseId,
            object: "response",
            created_at: createdAt,
            status: "failed",
            error: { message: message || "stream failed", code: "cursor_cli_error" },
            output: [],
            model: displayModel,
        },
    });
}
