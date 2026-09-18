import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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

function textPart(text) {
    return { text: { text: String(text) } };
}

/**
 * cursor-agent --conversation-history-file JSON (protobuf ConversationHistory).
 * Hidden CLI: "Import prior conversation history from the given file".
 * Cursor then owns compaction (ConversationSummaryArchive), instead of a 3MB seed prompt.
 */
export function toConversationHistory(messages) {
    const out = [];
    for (const message of messages || []) {
        const role = message?.role;
        const text = messageText(message).trim();
        if (!text)
            continue;
        if (role === "user") {
            out.push({ user: { content: [textPart(text)] } });
            continue;
        }
        if (role === "assistant") {
            out.push({ assistant: { content: [textPart(text)] } });
            continue;
        }
        if (role === "tool" || role === "function") {
            out.push({ assistant: { content: [textPart(`Tool: ${text}`)] } });
        }
    }
    return { messages: out };
}

export function splitHistoryAndLastUser(messages, lastUser) {
    const list = Array.isArray(messages) ? messages : [];
    if (!lastUser)
        return { prior: [], prompt: "" };
    let cut = -1;
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]?.role !== "user")
            continue;
        if (messageText(list[i]).trim() === lastUser) {
            cut = i;
            break;
        }
    }
    if (cut < 0)
        return { prior: list, prompt: lastUser };
    return { prior: list.slice(0, cut), prompt: lastUser };
}

function historyDir() {
    return process.env.CURSOR_BRIDGE_HISTORY_DIR
        || path.join(os.homedir(), ".cursor-api-proxy", "history");
}

export function writeConversationHistoryFile(threadKey, messages) {
    const body = toConversationHistory(messages);
    if (!body.messages.length)
        return undefined;
    const dir = historyDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${String(threadKey || "thread").replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`);
    writeFileSync(file, `${JSON.stringify(body)}\n`, { encoding: "utf8", mode: 0o600 });
    return file;
}
