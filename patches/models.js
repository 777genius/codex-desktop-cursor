import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { json } from "../http.js";
import { getAnthropicModelAliases } from "../model-map.js";
const FALLBACK_CURSOR_MODELS = [
    { id: "auto", name: "Auto" },
    { id: "composer-2.5", name: "Composer 2.5" },
    { id: "composer-2.5-fast", name: "Composer 2.5 Fast" },
    { id: "cursor-grok-4.6-xhigh", name: "Cursor Grok 4.6 Extra High" },
    { id: "claude-opus-5-high", name: "Claude Opus 5 High" },
    { id: "gpt-5.6-sol-medium", name: "GPT-5.6 Sol Medium" },
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High" },
    { id: "gpt-5.3-codex", name: "Codex 5.3" },
    { id: "gpt-5.4-medium", name: "GPT-5.4 Medium" },
    { id: "claude-4.6-opus-high", name: "Claude Opus 4.6 High" },
];
const SNAPSHOT_CANDIDATES = [
    path.join(os.homedir(), ".codex", "cursor-proxy", "cursor-models.json"),
];
function loadSnapshotModels() {
    for (const file of SNAPSHOT_CANDIDATES) {
        try {
            const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
            const models = Array.isArray(parsed?.models) ? parsed.models : [];
            const cleaned = models.filter((m) => m && typeof m.id === "string" && m.id.trim());
            if (cleaned.length > 0)
                return cleaned.map((m) => ({ id: m.id, name: m.name || m.id }));
        }
        catch {
            /* missing or invalid snapshot — try the next path */
        }
    }
    return FALLBACK_CURSOR_MODELS;
}
export async function getCachedCursorModels(config, modelCacheRef) {
    // Never spawn `cursor-agent --list-models` on the request path. A timed-out
    // list-models SIGKILLs its process group and can take down an in-flight
    // `--print`, which Codex then reports as stream closed before completed.
    if (!modelCacheRef.current?.models?.length) {
        modelCacheRef.current = { at: Date.now(), models: loadSnapshotModels() };
    }
    return modelCacheRef.current.models;
}
export async function handleModels(res, opts) {
    const { config, modelCacheRef } = opts;
    const models = await getCachedCursorModels(config, modelCacheRef);
    const cursorModels = models.map((m) => ({
        id: m.id,
        object: "model",
        owned_by: "cursor",
        name: m.name,
    }));
    const anthropicAliases = getAnthropicModelAliases(models.map((m) => m.id)).map((a) => ({
        id: a.id,
        object: "model",
        owned_by: "cursor",
        name: a.name,
    }));
    json(res, 200, {
        object: "list",
        data: [...cursorModels, ...anthropicAliases],
    });
}
//# sourceMappingURL=models.js.map
