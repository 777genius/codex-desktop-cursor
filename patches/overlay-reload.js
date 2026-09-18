import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Hot-load Thought/Ran mapping without restarting the proxy process.
 *
 * ESM caches modules by URL. Importing `responses-native.js?v=<mtime>` gets
 * new mapping code. `thread-replay.js` / `thread-session.js` stay on their
 * canonical URLs (static imports from handlers), so live Cursor chats and
 * in-flight `--print` children keep the same Maps.
 *
 * Changes to those singleton files, or to this handler, still need a process
 * restart — wait until no `cursor-agent --print` is running.
 */
const NATIVE = new URL("./responses-native.js", import.meta.url);
const PARSER = new URL("./cli-stream-parser.js", import.meta.url);
const WATCH = [
    NATIVE,
    PARSER,
    new URL("./stream-trace.js", import.meta.url),
    new URL("./sse-contract.js", import.meta.url),
];

let cache = { stamp: "", native: null, parser: null };

function fileStamp(url) {
    try {
        const st = statSync(fileURLToPath(url));
        return `${st.mtimeMs}:${st.size}`;
    }
    catch {
        return "0";
    }
}

function overlayStamp() {
    return WATCH.map(fileStamp).join("|");
}

export async function loadOverlayMapping() {
    const stamp = overlayStamp();
    if (cache.native && cache.parser && cache.stamp === stamp)
        return cache;
    const q = encodeURIComponent(stamp);
    const native = await import(`${NATIVE.href}?v=${q}`);
    const parser = await import(`${PARSER.href}?v=${q}`);
    cache = { stamp, native, parser };
    console.log("[overlay] reloaded mapping from disk");
    return cache;
}
