#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";

/** Restart cursor-api-proxy only when no in-flight --print agent is attached. */
function printLines() {
    try {
        return execFileSync("pgrep", ["-fl", "cursor-agent"], { encoding: "utf8" })
            .split("\n")
            .filter((line) => line.includes("--print"))
            .map((line) => line.replace(/--api-key\s+\S+/g, "--api-key [redacted]"));
    }
    catch {
        return [];
    }
}

const live = printLines();
if (live.length) {
    console.error(`not restarting: ${live.length} cursor-agent --print still running`);
    for (const line of live)
        console.error(`  ${line.slice(0, 180)}`);
    process.exit(2);
}

const uid = process.getuid?.() ?? execFileSync("id", ["-u"], { encoding: "utf8" }).trim();
const r = spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/com.belief.cursor-api-proxy`], {
    stdio: "inherit",
});
process.exit(r.status ?? 1);
