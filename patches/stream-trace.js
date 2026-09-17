import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import os from "node:os";

const MAX_BYTES = 8 * 1024 * 1024;

function enabled() {
    return process.env.CURSOR_BRIDGE_TRACE !== "0";
}

function tracePath() {
    return process.env.CURSOR_BRIDGE_TRACE_PATH
        || join(os.homedir(), ".cursor-api-proxy", "contract-trace.jsonl");
}

function rotateIfNeeded(file) {
    try {
        if (statSync(file).size < MAX_BYTES)
            return;
        renameSync(file, `${file}.old`);
    }
    catch {
        /* first write or race */
    }
}

function keysOf(value) {
    if (!value || typeof value !== "object")
        return [];
    return Object.keys(value).sort().slice(0, 40);
}

function textLen(value) {
    if (typeof value === "string")
        return value.length;
    if (typeof value?.text === "string")
        return value.text.length;
    if (typeof value?.delta === "string")
        return value.delta.length;
    if (typeof value?.delta?.text === "string")
        return value.delta.text.length;
    return 0;
}

/** Schema-only inbound cursor-agent stream-json. Never writes payloads. */
export function traceInbound(obj, mapped) {
    if (!enabled() || !obj || typeof obj !== "object")
        return;
    write({
        at: new Date().toISOString(),
        dir: "in",
        type: obj.type ?? null,
        subtype: obj.subtype ?? null,
        keys: keysOf(obj),
        nested: keysOf(obj.message || obj.tool_call || obj.delta || null),
        mapped,
        textLen: textLen(obj),
    });
}

export function traceOutbound(sseType, extra = {}) {
    if (!enabled() || !sseType)
        return;
    write({
        at: new Date().toISOString(),
        dir: "out",
        type: sseType,
        mapped: extra.mapped ?? "sse",
        item: extra.itemType ?? null,
    });
}

function write(rec) {
    try {
        const file = tracePath();
        mkdirSync(dirname(file), { recursive: true });
        rotateIfNeeded(file);
        appendFileSync(file, `${JSON.stringify(rec)}\n`, "utf8");
    }
    catch {
        /* tracing must never break the proxy */
    }
}
