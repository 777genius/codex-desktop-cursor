import { createHash } from "node:crypto";
import { cursorChatUsable } from "./cursor-chat.js";
import { deleteThreadSession, fingerprintsEqual, getThreadSession, putThreadSession, } from "./thread-session.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_CAPTURE = "([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
const VIZ_RE = new RegExp(`/visualizations/\\d{4}/\\d{2}/\\d{2}/${UUID_CAPTURE}`, "gi");
const CODEX_THREAD_RE = new RegExp(`codex://threads/${UUID_CAPTURE}`, "gi");
const THREAD_TAG_RE = /(?<!source_)<thread_id>\s*([0-9a-f-]{20,})\s*<\/thread_id>/i;

function headerValue(headers, name) {
    const raw = headers?.[name] ?? headers?.[name.toLowerCase()];
    const v = Array.isArray(raw) ? raw[0] : raw;
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function looksLikeUuid(value) {
    return typeof value === "string" && UUID_RE.test(value.trim());
}

function mostCommon(ids) {
    if (!ids.length)
        return undefined;
    const counts = new Map();
    for (const id of ids) {
        const key = id.toLowerCase();
        counts.set(key, (counts.get(key) || 0) + 1);
    }
    let best;
    let bestCount = -1;
    for (const [id, count] of counts) {
        if (count > bestCount) {
            best = id;
            bestCount = count;
        }
    }
    return best;
}

function allMatches(regex, text) {
    const out = [];
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)))
        out.push(m[1]);
    return out;
}

export function extractCodexThreadId(headers, body, prompt) {
    const fromHeader = headerValue(headers, "x-codex-thread-id") ||
        headerValue(headers, "x-cursor-thread");
    if (looksLikeUuid(fromHeader))
        return fromHeader;
    const meta = body?.metadata;
    const fromMeta = typeof meta?.thread_id === "string"
        ? meta.thread_id
        : typeof body?.conversation_id === "string"
            ? body.conversation_id
            : undefined;
    if (looksLikeUuid(fromMeta))
        return fromMeta.trim();
    const text = typeof prompt === "string" ? prompt : "";
    const tagged = THREAD_TAG_RE.exec(text);
    if (looksLikeUuid(tagged?.[1]))
        return tagged[1];
    const vizId = mostCommon(allMatches(VIZ_RE, text));
    if (looksLikeUuid(vizId))
        return vizId;
    const linked = mostCommon(allMatches(CODEX_THREAD_RE, text));
    if (looksLikeUuid(linked))
        return linked;
    return undefined;
}

export function isNoiseUserText(text) {
    const t = text.trim();
    if (!t)
        return true;
    if (t.startsWith("<environment_context") || t.startsWith("<cwd>"))
        return true;
    if (t.startsWith("<collaboration_mode>") || t.startsWith("<permissions"))
        return true;
    if (t.startsWith("sandbox_mode is `"))
        return true;
    return false;
}

function messageText(message) {
    const content = message?.content;
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
            if (typeof part === "string")
                return part;
            if (part && typeof part.text === "string")
                return part.text;
            return "";
        })
            .join("");
    }
    return "";
}

export function extractLastUserText(messages) {
    if (!Array.isArray(messages))
        return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.role !== "user")
            continue;
        const text = messageText(msg).trim();
        if (!isNoiseUserText(text))
            return text;
    }
    return undefined;
}

export function lastUserFromPrompt(prompt) {
    if (typeof prompt !== "string" || !prompt)
        return undefined;
    const parts = prompt.split(/\nUser: /);
    if (parts.length < 2)
        return undefined;
    let last = parts[parts.length - 1];
    const assistantAt = last.indexOf("\nAssistant:");
    if (assistantAt >= 0)
        last = last.slice(0, assistantAt);
    last = last.trim();
    return isNoiseUserText(last) ? undefined : last;
}

function firstUserBlock(prompt) {
    if (typeof prompt !== "string" || !prompt)
        return "";
    const idx = prompt.indexOf("\nUser: ");
    const body = idx >= 0 ? prompt.slice(idx + 7) : prompt;
    const next = body.search(/\n(?:User|Assistant): /);
    return (next >= 0 ? body.slice(0, next) : body).trim().slice(0, 4000);
}

function prefixHash(prompt, lastUser, model, mode, workspace) {
    const seed = firstUserBlock(prompt);
    return createHash("sha256")
        .update(seed)
        .update("\0")
        .update(model || "")
        .update("\0")
        .update(mode || "")
        .update("\0")
        .update(workspace || "")
        .digest("hex")
        .slice(0, 32);
}

export function resolveThreadKey(input) {
    const threadId = extractCodexThreadId(input.headers, input.body, input.prompt);
    if (threadId)
        return `thread:${threadId}`;
    return `prefix:${prefixHash(input.prompt, input.lastUser, input.model, input.mode, input.workspace)}`;
}

export function prepareAgentInvocation(input, opts = {}) {
    const lastUser = extractLastUserText(input.messages) || lastUserFromPrompt(input.fullPrompt);
    const fp = {
        model: input.model,
        mode: input.mode,
        workspace: input.workspaceDir,
    };
    const threadKey = resolveThreadKey({
        headers: input.headers,
        body: input.body,
        prompt: input.fullPrompt,
        lastUser,
        model: input.model,
        mode: input.mode,
        workspace: input.workspaceDir,
    });
    const rec = getThreadSession(threadKey);
    const canResume = Boolean(rec?.chatId && lastUser && fingerprintsEqual(rec, fp) &&
        (rec.ready === true || rec.ready === undefined || cursorChatUsable(rec.chatId)));
    const rememberSession = (sessionId, extra = {}) => {
        if (!sessionId)
            return;
        putThreadSession(threadKey, {
            chatId: sessionId,
            ...fp,
            ready: extra.ready === true || cursorChatUsable(sessionId),
        });
    };
    const forgetSession = () => deleteThreadSession(threadKey);
    const commitSession = (code, sessionId) => {
        const id = sessionId || rec?.chatId || getThreadSession(threadKey)?.chatId;
        if (code === 0 && id) {
            rememberSession(id, { ready: true });
            return;
        }
        if (id && cursorChatUsable(id)) {
            rememberSession(id, { ready: true });
            console.log(`[keep] ${threadKey} chat=${id} after exit ${code}`);
            return;
        }
        forgetSession();
    };
    if (canResume) {
        if (!opts.silent)
            console.log(`[resume] ${threadKey} chat=${rec.chatId} bytes=${lastUser.length}`);
        return {
            agentPrompt: lastUser,
            resumeChatId: rec.chatId,
            threadKey,
            resumed: true,
            rememberSession,
            forgetSession,
            commitSession,
        };
    }
    if (!opts.silent)
        console.log(`[seed] ${threadKey} bytes=${input.fullPrompt.length}`);
    return {
        agentPrompt: input.fullPrompt,
        resumeChatId: undefined,
        threadKey,
        resumed: false,
        rememberSession,
        forgetSession,
        commitSession,
    };
}

export function readSessionIdFromObject(obj) {
    if (!obj || typeof obj !== "object")
        return undefined;
    const value = obj.session_id ?? obj.sessionId ?? obj.chat_id ?? obj.chatId;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function sessionIdFromStdout(stdout) {
    if (typeof stdout !== "string" || !stdout)
        return undefined;
    for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{"))
            continue;
        try {
            const sid = readSessionIdFromObject(JSON.parse(trimmed));
            if (sid)
                return sid;
        }
        catch {
            /* ignore */
        }
    }
    return undefined;
}
