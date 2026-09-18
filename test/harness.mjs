import { createStreamParser } from "../patches/cli-stream-parser.js";
import { createResponsesNativeStream } from "../patches/responses-native.js";
import { parseSse, assertResponsesTerminal } from "../patches/sse-contract.js";

export function mockRes() {
    let buf = "";
    return {
        writableEnded: false,
        destroyed: false,
        write(chunk) {
            buf += chunk;
            return true;
        },
        end() {
            this.writableEnded = true;
        },
        dump() {
            return buf;
        },
    };
}

export function collectWrite(res) {
    return (type, data) => {
        res.write(`event: ${type}\n`);
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };
}

/** cursor-agent --output-format stream-json lines we already handle. */
export const KNOWN_STREAM_JSON_TYPES = new Set([
    "system",
    "user",
    "thinking",
    "tool_call",
    "assistant",
    "result",
    "error",
]);

/**
 * Replay real cursor-agent NDJSON through the overlay the way handleResponses does.
 */
export function playCursorNdjson(ndjson, { responseId = "resp_pipe", model = "auto" } = {}) {
    const res = mockRes();
    const native = createResponsesNativeStream({
        res,
        writeEvent: collectWrite(res),
        responseId,
        body: { model, stream: true },
        displayModel: model,
        createdAt: 1,
        promptTokens: 1,
    });
    collectWrite(res)("response.created", {
        response: { id: responseId, object: "response", status: "in_progress", output: [] },
    });
    const inbound = [];
    const parse = createStreamParser(
        (delta) => native.onText(delta),
        () => native.finish(),
        () => {},
        (ev) => {
            inbound.push(ev);
            if (ev.type === "thinking")
                native.onThinking(ev.text);
            if (ev.type === "tool")
                native.onTool(ev);
        },
    );
    const types = [];
    for (const line of String(ndjson).split(/\n/)) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        const obj = JSON.parse(trimmed);
        types.push(`${obj.type || "?"}${obj.subtype ? ` ${obj.subtype}` : ""}`);
        parse(trimmed);
    }
    if (!native.isFinished())
        native.finish();
    res.write("data: [DONE]\n\n");
    return {
        inbound,
        types,
        sse: parseSse(res.dump()),
        text: native.getText(),
        responseId,
    };
}

export function assertDesktopSse(played) {
    const { sse, responseId, inbound, types } = played;
    assertResponsesTerminal(sse, responseId);
    const unknown = types
        .map((t) => t.split(" ")[0])
        .filter((t) => !KNOWN_STREAM_JSON_TYPES.has(t));
    if (unknown.length)
        throw new Error(`unmapped stream-json types: ${unknown.join(",")}`);
    if (sse.some((e) => String(e.event || "").includes("function_call_arguments")))
        throw new Error("Desktop cannot decode function_call_arguments events");
    const itemTypes = sse
        .map((e) => e.data?.item?.type)
        .filter(Boolean);
    const forbidden = itemTypes.filter((t) => t === "local_shell_call" || t === "custom_tool_call");
    if (forbidden.length)
        throw new Error(`Desktop has no widget for ${forbidden.join(",")}`);
    const tools = inbound.filter((e) => e.type === "tool");
    const exec = sse.filter((e) => e.data?.item?.type === "function_call" && e.data.item.name === "exec_command");
    const search = sse.filter((e) => e.data?.item?.type === "web_search_call");
    const jsonRan = exec.filter((e) => {
        let cmd = "";
        try {
            cmd = JSON.parse(e.data?.item?.arguments || "{}").cmd || "";
        }
        catch {
            cmd = String(e.data?.item?.arguments || "");
        }
        const s = String(cmd).trim();
        return s.startsWith("{") || s.startsWith("[") || /: ['"]\{/.test(s);
    });
    if (jsonRan.length)
        throw new Error("JSON tool args must not become a Ran exec_command");
    for (const tool of tools) {
        const name = String(tool.name || "").toLowerCase();
        if (name.includes("websearch") || name.includes("webfetch") || name === "fetch") {
            if (!search.length)
                throw new Error(`${tool.name} must become web_search_call`);
            continue;
        }
        if (name.includes("updategoal") || name.includes("creategoal") || name === "mcp") {
            if (exec.some((e) => /UpdateGoal|mcp|CreateGoal/i.test(String(e.data?.item?.arguments || ""))))
                throw new Error("Cursor UpdateGoal/MCP must not become a Ran exec_command");
        }
    }
    if (inbound.some((e) => e.type === "thinking")) {
        if (!sse.some((e) => e.data?.item?.type === "reasoning"))
            throw new Error("thinking must become native reasoning Thought");
        if (!sse.some((e) => e.data?.item?.phase === "commentary"))
            throw new Error("thinking must also stream as visible commentary");
    }
    return { exec, itemTypes };
}
