import { mapCodexOrCursorMode, inferCodexDesktopMode } from "./codex-desktop.js";

export function resolveRequestMode(config, headerMode, bodyMode, sourceText) {
    const fromBody = mapCodexOrCursorMode(bodyMode);
    if (fromBody) {
        return fromBody;
    }
    const fromHeader = mapCodexOrCursorMode(headerMode);
    if (fromHeader) {
        return fromHeader;
    }
    const inferred = inferCodexDesktopMode(sourceText);
    if (inferred) {
        return inferred;
    }
    return config.mode;
}
