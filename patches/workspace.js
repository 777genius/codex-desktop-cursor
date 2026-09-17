import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
/**
 * Env overrides for chat-only (isolated) workspace so the agent cannot load
 * rules from ~/.cursor or other user config paths.
 *
 * When `authConfigDir` is set (account pool), use it for `CURSOR_CONFIG_DIR` so the
 * CLI loads credentials from that profile.
 *
 * We do **not** override `HOME` / `USERPROFILE` / `XDG_*` in that case: the Cursor CLI
 * still resolves auth relative to the real user profile for `agent --print` / ask, and
 * a fake `HOME` makes login fail even when `CURSOR_CONFIG_DIR` points at the pool.
 * Without a pool, the temp `HOME` keeps rules from the real `~/.cursor` from loading.
 */
export function getChatOnlyEnvOverrides(workspaceDir, authConfigDir) {
    const cursorDir = authConfigDir ?? path.join(workspaceDir, ".cursor");
    const overrides = {
        CURSOR_CONFIG_DIR: cursorDir,
    };
    if (authConfigDir) {
        return overrides;
    }
    overrides.HOME = workspaceDir;
    overrides.USERPROFILE = workspaceDir;
    if (process.platform === "win32") {
        const appDataRoaming = path.join(workspaceDir, "AppData", "Roaming");
        const appDataLocal = path.join(workspaceDir, "AppData", "Local");
        overrides.APPDATA = appDataRoaming;
        overrides.LOCALAPPDATA = appDataLocal;
    }
    else {
        overrides.XDG_CONFIG_HOME = path.join(workspaceDir, ".config");
    }
    return overrides;
}
export function resolveWorkspace(config, workspaceHeader, effectiveChatOnly) {
    const useChatOnly = effectiveChatOnly !== undefined
        ? effectiveChatOnly
        : config.chatOnlyWorkspace;
    if (useChatOnly) {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-"));
        const cursorDir = path.join(tempDir, ".cursor");
        fs.mkdirSync(cursorDir, { recursive: true });
        fs.mkdirSync(path.join(cursorDir, "rules"), { recursive: true });
        const minimalConfig = {
            version: 1,
            editor: { vimMode: false },
            permissions: { allow: [], deny: [] },
        };
        fs.writeFileSync(path.join(cursorDir, "cli-config.json"), JSON.stringify(minimalConfig, null, 0), "utf8");
        if (process.platform === "win32") {
            fs.mkdirSync(path.join(tempDir, "AppData", "Roaming"), { recursive: true });
            fs.mkdirSync(path.join(tempDir, "AppData", "Local"), { recursive: true });
        }
        else {
            fs.mkdirSync(path.join(tempDir, ".config"), { recursive: true });
        }
        return { workspaceDir: tempDir, tempDir };
    }
    const headerWs = typeof workspaceHeader === "string" && workspaceHeader.trim()
        ? workspaceHeader.trim()
        : null;
    const base = path.resolve(config.workspace);
    if (!headerWs) {
        return { workspaceDir: base };
    }
    const candidate = path.resolve(headerWs);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
        return { workspaceDir: base };
    }
    return { workspaceDir: fs.realpathSync(candidate) };
}
