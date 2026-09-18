process.env.CURSOR_BRIDGE_TRACE = "0";

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKIP = process.env.CURSOR_LIVE === "0";
const TIMEOUT_MS = Number(process.env.CURSOR_LIVE_TIMEOUT_MS || 180000);
const TOKEN = "WOLVERINE-91";

function run(args, { stdin } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn("cursor-agent", args, { stdio: ["pipe", "pipe", "pipe"] });
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
            resolve({
                code,
                stdout,
                stderr: stderr.replace(/crsr_[A-Za-z0-9]+/g, "crsr_[redacted]"),
            });
        });
        if (stdin)
            child.stdin.end(stdin);
        else
            child.stdin.end();
    });
}

function sessionIdFromStream(stdout) {
    for (const line of String(stdout).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{"))
            continue;
        let obj;
        try {
            obj = JSON.parse(trimmed);
        }
        catch {
            continue;
        }
        const id = obj.session_id || obj.sessionId || obj.chat_id || obj.chatId;
        if (typeof id === "string" && id)
            return id;
    }
    return undefined;
}

function listModels(raw) {
    const names = new Set();
    for (const line of String(raw).split("\n")) {
        const m = line.match(/^\s*([a-z0-9][a-z0-9._:-]*)(?:\s+-|\s*$)/i);
        if (m && m[1] !== "available")
            names.add(m[1]);
    }
    try {
        const obj = JSON.parse(raw);
        const arr = Array.isArray(obj) ? obj : obj?.models || obj?.data || [];
        for (const item of arr) {
            const id = typeof item === "string" ? item : item?.id || item?.name;
            if (id)
                names.add(String(id));
        }
    }
    catch {
        /* text catalog */
    }
    return [...names];
}

if (SKIP) {
    console.log("skip live model-switch (CURSOR_LIVE=0)");
    process.exit(0);
}

let listed;
try {
    listed = await run(["--list-models"]);
}
catch (err) {
    if (err && err.code === "ENOENT") {
        console.log("skip live model-switch (cursor-agent not on PATH)");
        process.exit(0);
    }
    throw err;
}

const models = listModels(`${listed.stdout}\n${listed.stderr}`);
const first = process.env.CURSOR_LIVE_MODEL || models.find((m) => m === "auto") || models[0];
const second = process.env.CURSOR_LIVE_MODEL_B
    || models.find((m) => m === "composer-2.5-fast")
    || models.find((m) => m !== first && /composer-2|gemini-.*flash/i.test(m))
    || models.find((m) => m !== first);
if (!first || !second) {
    console.log(`skip live model-switch (need two models, got ${models.slice(0, 8).join(",") || "none"})`);
    process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "cdc-live-switch-"));
const common = [
    "--print",
    "--mode", "ask",
    "--trust",
    "--sandbox", "enabled",
    "--workspace", workspace,
    "--output-format", "stream-json",
    "--stream-partial-output",
];

const seeded = await run([
    ...common,
    "--model", first,
    "--",
    `The passphrase is ${TOKEN}. Reply with only the word ok.`,
]);
if (seeded.code !== 0)
    throw new Error(`seed exit ${seeded.code}: ${seeded.stderr.slice(-400)}`);
const chatId = sessionIdFromStream(seeded.stdout);
if (!chatId)
    throw new Error("seed turn must print a session_id for --resume");

const resumed = await run([
    ...common,
    "--resume", chatId,
    "--model", second,
    "--",
    "What is the passphrase from the previous turn? Reply with only the passphrase.",
]);
if (resumed.code !== 0)
    throw new Error(`resume exit ${resumed.code}: ${resumed.stderr.slice(-400)}`);
if (!resumed.stdout.includes(TOKEN))
    throw new Error(`--resume ${chatId} with --model ${second} lost history (no ${TOKEN} in stream)`);

console.log(`ok live model-switch ${first} → ${second} resume ${chatId}`);
