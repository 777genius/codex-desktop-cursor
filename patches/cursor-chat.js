import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const MIN_DB_BYTES = 64 * 1024;

function chatsRoot() {
    return process.env.CURSOR_BRIDGE_CHATS_ROOT || path.join(os.homedir(), ".cursor", "chats");
}

export function findCursorChatDir(chatId) {
    if (!chatId || /[^0-9a-f-]/.test(chatId))
        return undefined;
    const root = chatsRoot();
    let projects;
    try {
        projects = fs.readdirSync(root, { withFileTypes: true });
    }
    catch {
        return undefined;
    }
    for (const proj of projects) {
        if (!proj.isDirectory())
            continue;
        const dir = path.join(root, proj.name, chatId);
        if (fs.existsSync(path.join(dir, "meta.json")))
            return dir;
    }
    return undefined;
}

export function cursorChatUsable(chatId) {
    const dir = findCursorChatDir(chatId);
    if (!dir)
        return false;
    try {
        const db = path.join(dir, "store.db");
        const wal = path.join(dir, "store.db-wal");
        const dbSize = fs.existsSync(db) ? fs.statSync(db).size : 0;
        const walSize = fs.existsSync(wal) ? fs.statSync(wal).size : 0;
        if (dbSize + walSize >= MIN_DB_BYTES)
            return true;
        const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
        return Boolean(meta?.hasConversation) && dbSize > 8192;
    }
    catch {
        return false;
    }
}
