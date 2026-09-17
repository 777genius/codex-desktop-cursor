#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OVERLAY = join(ROOT, "patches");

/** Overlay file → path under cursor-api-proxy/dist */
const FILES = [
  ["codex-desktop.js", "lib/codex-desktop.js"],
  ["resolve-mode.js", "lib/resolve-mode.js"],
  ["workspace.js", "lib/workspace.js"],
  ["agent-cmd-args.js", "lib/agent-cmd-args.js"],
  ["thread-session.js", "lib/thread-session.js"],
  ["cursor-chat.js", "lib/cursor-chat.js"],
  ["thread-lock.js", "lib/thread-lock.js"],
  ["thread-replay.js", "lib/thread-replay.js"],
  ["cursor-turn.js", "lib/cursor-turn.js"],
  ["cli-stream-parser.js", "lib/cli-stream-parser.js"],
  ["responses-native.js", "lib/responses-native.js"],
  ["sse-contract.js", "lib/sse-contract.js"],
  ["process.js", "lib/process.js"],
  ["process-tree-kill.js", "lib/process-tree-kill.js"],
  ["openai.js", "lib/openai.js"],
  ["tool-types.js", "lib/tool-types.js"],
  ["models.js", "lib/handlers/models.js"],
  ["responses.js", "lib/handlers/responses.js"],
  ["chat-completions.js", "lib/handlers/chat-completions.js"],
  ["anthropic-messages.js", "lib/handlers/anthropic-messages.js"],
];

function npmRoot() {
  try {
    return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function distDir() {
  const fromEnv = process.env.CURSOR_API_PROXY_DIST;
  if (fromEnv) return fromEnv;
  const candidates = [
    join(npmRoot(), "cursor-api-proxy", "dist"),
    join(ROOT, "node_modules", "cursor-api-proxy", "dist"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const dist = distDir();
if (!dist) {
  console.error(
    "cursor-api-proxy dist/ not found. Install: npm i -g cursor-api-proxy@1.4.0",
  );
  process.exit(1);
}

for (const [srcName, rel] of FILES) {
  const src = join(OVERLAY, srcName);
  const dest = join(dist, rel);
  if (!existsSync(src)) {
    console.error(`missing overlay file: ${srcName}`);
    process.exit(1);
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`applied ${srcName} → ${rel}`);
}

console.log(`overlay on ${dist}`);
