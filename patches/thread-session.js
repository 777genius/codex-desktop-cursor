import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_STORE_PATH = path.join(os.homedir(), ".cursor-api-proxy", "thread-sessions.json");
let memoryStore;
let memoryStoreMtime = 0;

function storePath() {
    return process.env.CURSOR_BRIDGE_THREAD_SESSIONS || DEFAULT_STORE_PATH;
}

function storeMtime() {
    try {
        return fs.statSync(storePath()).mtimeMs;
    }
    catch {
        return 0;
    }
}

function readStore() {
    const mtime = storeMtime();
    if (memoryStore && mtime && mtime === memoryStoreMtime)
        return memoryStore;
    try {
        const raw = fs.readFileSync(storePath(), "utf8");
        const parsed = JSON.parse(raw);
        memoryStore = parsed && typeof parsed === "object" ? parsed : {};
        memoryStoreMtime = mtime;
    }
    catch {
        memoryStore = memoryStore && typeof memoryStore === "object" ? memoryStore : {};
        memoryStoreMtime = mtime;
    }
    return memoryStore;
}

function writeStore(store) {
    memoryStore = store;
    const dest = storePath();
    const dir = path.dirname(dest);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, dest);
    memoryStoreMtime = storeMtime();
}

/**
 * Desktop model picker must keep the same Cursor chat. `--resume` plus a
 * new `--model` is how history survives a switch. Mode can change with the
 * picker too (ask ↔ agent). Only a different workspace is a different chat.
 */
export function fingerprintsEqual(a, b) {
    if (!a || !b)
        return false;
    if (a.workspace && b.workspace && a.workspace !== b.workspace)
        return false;
    return true;
}

function indexMap(store, name) {
    const raw = store[name];
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return {};
    return raw;
}

function capIndex(map, max = 800) {
    const keys = Object.keys(map);
    if (keys.length <= max)
        return map;
    const keep = keys.slice(keys.length - max);
    const out = {};
    for (const key of keep)
        out[key] = map[key];
    return out;
}

export function resetStoreForTest() {
    memoryStore = undefined;
    memoryStoreMtime = 0;
}

export function rememberResponse(threadKey, responseId) {
    if (!threadKey || !responseId)
        return;
    const store = readStore();
    const responses = indexMap(store, "_responseIndex");
    responses[responseId] = threadKey;
    store._responseIndex = capIndex(responses);
    const rec = store[threadKey];
    if (rec && typeof rec === "object")
        rec.lastResponseId = responseId;
    writeStore(store);
}

export function rememberCall(threadKey, callId) {
    if (!threadKey || !callId)
        return;
    const store = readStore();
    const calls = indexMap(store, "_callIndex");
    calls[callId] = threadKey;
    store._callIndex = capIndex(calls);
    writeStore(store);
}

export function threadKeyFromResponseId(responseId) {
    if (!responseId)
        return undefined;
    const key = indexMap(readStore(), "_responseIndex")[responseId];
    return typeof key === "string" && key ? key : undefined;
}

export function threadKeyFromCallId(callId) {
    if (!callId)
        return undefined;
    const key = indexMap(readStore(), "_callIndex")[callId];
    return typeof key === "string" && key ? key : undefined;
}

export function threadKeyFromFollowUp(body, outputs) {
    const fromResp = threadKeyFromResponseId(body?.previous_response_id || body?.previousResponseId);
    if (fromResp)
        return fromResp;
    if (Array.isArray(outputs)) {
        for (const out of outputs) {
            const key = threadKeyFromCallId(out?.callId);
            if (key)
                return key;
        }
    }
    const input = body?.input;
    if (Array.isArray(input)) {
        for (const item of input) {
            const callId = item?.call_id || item?.callId;
            const key = threadKeyFromCallId(callId);
            if (key)
                return key;
        }
    }
    return undefined;
}

export function getThreadSession(threadKey) {
    if (!threadKey)
        return undefined;
    const rec = readStore()[threadKey];
    if (!rec || typeof rec !== "object" || typeof rec.chatId !== "string" || !rec.chatId.trim()) {
        return undefined;
    }
    return rec;
}

export function putThreadSession(threadKey, rec) {
    if (!threadKey || !rec?.chatId)
        return;
    const store = readStore();
    const prev = store[threadKey];
    const sameChat = prev?.chatId === rec.chatId;
    const ready = rec.ready === true || (sameChat && prev?.ready === true);
    store[threadKey] = {
        chatId: rec.chatId,
        model: rec.model,
        mode: rec.mode,
        workspace: rec.workspace,
        ready,
        lastPromptHash: rec.lastPromptHash ?? (sameChat ? prev?.lastPromptHash : undefined),
        lastPromptAt: rec.lastPromptAt ?? (sameChat ? prev?.lastPromptAt : undefined),
        lastOutputText: rec.lastOutputText === ""
            ? undefined
            : (rec.lastOutputText ?? (sameChat ? prev?.lastOutputText : undefined)),
        lastResponseId: rec.lastResponseId ?? (sameChat ? prev?.lastResponseId : undefined),
        updatedAt: Date.now(),
    };
    writeStore(store);
}

export function markThreadOutput(threadKey, text) {
    const rec = getThreadSession(threadKey);
    if (!rec)
        return;
    putThreadSession(threadKey, {
        ...rec,
        lastOutputText: (typeof text === "string" && text) ? text.slice(0, 32000) : rec.lastOutputText,
    });
}

export function markThreadPrompt(threadKey, prompt) {
    const rec = getThreadSession(threadKey);
    if (!rec || !prompt)
        return;
    const lastPromptHash = createHash("sha256").update(prompt).digest("hex").slice(0, 32);
    putThreadSession(threadKey, {
        ...rec,
        lastPromptHash,
        lastPromptAt: Date.now(),
        lastOutputText: "",
    });
}

export function deleteThreadSession(threadKey) {
    if (!threadKey)
        return;
    const store = readStore();
    if (!(threadKey in store))
        return;
    delete store[threadKey];
    writeStore(store);
}

export function toolsFingerprint(toolsText) {
    if (!toolsText)
        return "none";
    return createHash("sha256").update(toolsText).digest("hex").slice(0, 12);
}
