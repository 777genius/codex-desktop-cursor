process.env.CURSOR_BRIDGE_TRACE = "0";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fingerprintsEqual, putThreadSession, resetStoreForTest } from "../patches/thread-session.js";
import { prepareAgentInvocation } from "../patches/cursor-turn.js";
import { buildAgentFixedArgs, resolveAgentCliTurn } from "../patches/agent-cmd-args.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

{
    const src = readFileSync(join(ROOT, "patches/thread-session.js"), "utf8");
    if (/a\.model\s*!==\s*b\.model/.test(src) || /rec\.model\s*!==\s*fp\.model/.test(src))
        throw new Error("fingerprintsEqual must not require the same Desktop model");
    if (!fingerprintsEqual(
        { model: "gemini-3.8-flash-high", mode: "agent", workspace: "/proj" },
        { model: "cursor-grok-4.6-xhigh", mode: "ask", workspace: "/proj" },
    ))
        throw new Error("same workspace must resume across model and mode");
    if (fingerprintsEqual(
        { workspace: "/a" },
        { workspace: "/b" },
    ))
        throw new Error("different workspace must not resume");
}

process.env.CURSOR_BRIDGE_THREAD_SESSIONS = `/tmp/cdc-e2e-model-switch-${process.pid}.json`;
process.env.CURSOR_BRIDGE_HISTORY_DIR = `/tmp/cdc-e2e-history-${process.pid}`;
resetStoreForTest();

const thread = "019fc3aa-bd72-7ea1-b807-4b9c18ec48bf";
const chatId = "ef3284a8-c62a-40e0-b7d0-5f4bbde3c1db";
const workspace = "/Users/belief/dev/projects/ai/social-monitor";
const lastUser = "switch to grok and keep the ranking e2e";
const blob = "ranking-e2e context dump\n".repeat(40000); // ~1MB, same class as the 6MB seed
const messages = [
    { role: "user", content: blob },
    { role: "assistant", content: "we already shipped soak" },
    { role: "user", content: lastUser },
];
const fullPrompt = `User: ${blob}\n\nAssistant: we already shipped soak\n\nUser: ${lastUser}`;
if (fullPrompt.length < 500000)
    throw new Error(`fixture must be huge like Desktop's seed dump, got ${fullPrompt.length}`);

putThreadSession(`thread:${thread}`, {
    chatId,
    model: "gemini-3.8-flash-high",
    mode: "agent",
    workspace,
    ready: true,
});

const turn = prepareAgentInvocation({
    headers: { "x-codex-thread-id": thread },
    body: { model: "cursor-grok-4.6-xhigh" },
    messages,
    fullPrompt,
    model: "cursor-grok-4.6-xhigh",
    mode: "agent",
    workspaceDir: workspace,
}, { silent: true });

if (!turn.resumed || turn.resumeChatId !== chatId)
    throw new Error(`model switch must --resume ${chatId}, got resumed=${turn.resumed} chat=${turn.resumeChatId}`);
if (turn.agentPrompt !== lastUser)
    throw new Error(`resume prompt must be last user (${lastUser.length}b), got ${turn.agentPrompt.length}b`);
if (turn.historyMessages?.length)
    throw new Error("resume must not import history file; Cursor chat already has it");

const { historyFile, agentPrompt } = resolveAgentCliTurn(turn, fullPrompt);
const args = buildAgentFixedArgs(
    { force: true },
    workspace,
    "grok-4.6-xhigh",
    true,
    "agent",
    false,
    turn.resumeChatId,
    historyFile,
);
if (historyFile)
    throw new Error("resume must not pass --conversation-history-file");
if (agentPrompt !== lastUser)
    throw new Error("handler must send last user, not the 1MB Desktop dump");
if (!args.includes("--resume") || args[args.indexOf("--resume") + 1] !== chatId)
    throw new Error(`argv must --resume ${chatId}, got ${args.join(" ")}`);
if (args.includes("--conversation-history-file"))
    throw new Error("argv must not re-import history on resume");
if (args[args.indexOf("--model") + 1] !== "grok-4.6-xhigh")
    throw new Error("argv must pass the new Cursor --model");

const modeSwitch = prepareAgentInvocation({
    headers: { "x-codex-thread-id": thread },
    body: { model: "composer-2" },
    messages,
    fullPrompt,
    model: "composer-2",
    mode: "ask",
    workspaceDir: workspace,
}, { silent: true });
if (!modeSwitch.resumed || modeSwitch.resumeChatId !== chatId)
    throw new Error("ask ↔ agent must keep the same Cursor chat");

console.log(`ok model-switch e2e resume ${chatId} prompt=${agentPrompt.length} dump=${fullPrompt.length}`);
