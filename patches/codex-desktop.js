const CURSOR_MODES = new Set(["agent", "ask", "plan"]);

const ALIASES = new Map([
    ["agent", "agent"],
    ["ask", "ask"],
    ["plan", "plan"],
    ["planning", "plan"],
    ["read-only", "ask"],
    ["readonly", "ask"],
    ["read_only", "ask"],
    ["ask-mode", "ask"],
    ["workspace-write", "agent"],
    ["workspace_write", "agent"],
    ["danger-full-access", "agent"],
    ["full-access", "agent"],
    ["full_access", "agent"],
    ["yolo", "agent"],
]);

function lastMatch(text, regex) {
    let found;
    let m;
    regex.lastIndex = 0;
    while ((m = regex.exec(text))) {
        found = m;
    }
    return found;
}

export function mapCodexOrCursorMode(raw) {
    if (raw == null) {
        return undefined;
    }
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string") {
        return undefined;
    }
    const token = value.trim().toLowerCase().replace(/\s+/g, "-");
    if (!token) {
        return undefined;
    }
    const mapped = ALIASES.get(token);
    if (mapped && CURSOR_MODES.has(mapped)) {
        return mapped;
    }
    return undefined;
}

export function inferCodexDesktopMode(text) {
    if (typeof text !== "string" || !text) {
        return undefined;
    }
    const collab = lastMatch(text, /<collaboration_mode>\s*#\s*Collaboration Mode:\s*([A-Za-z][A-Za-z0-9 _-]*)/gi);
    if (collab) {
        const name = collab[1].trim().toLowerCase().replace(/\s+/g, "-");
        if (name === "plan" || name === "planning") {
            return "plan";
        }
    }
    const sandboxTick = lastMatch(text, /sandbox_mode is `([^`]+)`/gi);
    const sandboxXml = lastMatch(text, /<sandbox_mode>\s*([^<]+?)\s*<\/sandbox_mode>/gi);
    const sandbox = (sandboxXml?.[1] ?? sandboxTick?.[1] ?? "").trim().toLowerCase();
    return mapCodexOrCursorMode(sandbox);
}

export function inferCodexDesktopWorkspace(text) {
    if (typeof text !== "string" || !text) {
        return undefined;
    }
    const cwd = lastMatch(text, /<cwd>\s*([^<]+?)\s*<\/cwd>/gi);
    const value = cwd?.[1]?.trim();
    if (value && value.startsWith("/")) {
        return value;
    }
    return undefined;
}

export function resolveRequestWorkspaceHeader(headerWs, sourceText) {
    const raw = Array.isArray(headerWs) ? headerWs[0] : headerWs;
    if (typeof raw === "string" && raw.trim()) {
        return raw.trim();
    }
    return inferCodexDesktopWorkspace(sourceText);
}
