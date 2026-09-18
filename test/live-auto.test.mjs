process.env.CURSOR_BRIDGE_TRACE = "0";

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { playCursorNdjson, assertDesktopSse } from "./harness.mjs";

const SKIP = process.env.CURSOR_LIVE === "0";
const MODEL = process.env.CURSOR_LIVE_MODEL || "auto";
const TIMEOUT_MS = Number(process.env.CURSOR_LIVE_TIMEOUT_MS || 120000);

function runAgent(workspace, prompt) {
    return new Promise((resolve, reject) => {
        const child = spawn("cursor-agent", [
            "--print",
            "--mode", "ask",
            "--model", MODEL,
            "--trust",
            "--sandbox", "enabled",
            "--workspace", workspace,
            "--output-format", "stream-json",
            "--stream-partial-output",
            "--",
            prompt,
        ], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (c) => { stdout += c; });
        child.stderr.on("data", (c) => { stderr += c; });
        const t = setTimeout(() => {
            child.kill("SIGTERM");
            reject(new Error(`cursor-agent timed out after ${TIMEOUT_MS}ms`));
        }, TIMEOUT_MS);
        child.on("error", (err) => {
            clearTimeout(t);
            reject(err);
        });
        child.on("close", (code) => {
            clearTimeout(t);
            resolve({ code, stdout, stderr: stderr.replace(/crsr_[A-Za-z0-9]+/g, "crsr_[redacted]") });
        });
    });
}

if (SKIP) {
    console.log("skip live Auto (CURSOR_LIVE=0)");
    process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "cdc-live-auto-"));
writeFileSync(join(workspace, "hello.txt"), "hello-from-fixture\n");
const prompt = "Read hello.txt using a tool, then reply with only the file contents. No extra prose.";
let ran;
try {
    ran = await runAgent(workspace, prompt);
}
catch (err) {
    if (err && err.code === "ENOENT") {
        console.log("skip live Auto (cursor-agent not on PATH)");
        process.exit(0);
    }
    throw err;
}
if (ran.code !== 0) {
    throw new Error(`cursor-agent exit ${ran.code}: ${ran.stderr.slice(-400)}`);
}
const played = playCursorNdjson(ran.stdout, { responseId: "resp_live_auto", model: MODEL });
assertDesktopSse(played);
if (!played.types.includes("result success"))
    throw new Error(`Auto turn did not complete: ${played.types.join(" | ")}`);
if (!/hello-from-fixture/.test(played.text))
    throw new Error(`expected file contents in assistant text, got ${JSON.stringify(played.text)}`);
if (played.types.includes("tool_call started") && !played.sse.some((e) => e.data?.item?.name === "exec_command"))
    throw new Error("live Read/tool must surface as exec_command");
console.log(`ok live Auto ${MODEL} stream-json → Desktop SSE`);
