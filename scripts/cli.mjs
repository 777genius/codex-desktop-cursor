#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cmd = process.argv[2] ?? "help";
const rest = process.argv.slice(3);

function run(file) {
  const r = spawnSync(process.execPath, [join(ROOT, file), ...rest], {
    stdio: "inherit",
  });
  process.exit(r.status ?? 1);
}

if (cmd === "apply") run("scripts/apply.mjs");
if (cmd === "test") run("test/sse-contract.test.mjs");
if (cmd === "desktop-version" || cmd === "version") run("scripts/desktop-version.mjs");

console.log(`codex-desktop-cursor

Usage:
  npx codex-desktop-cursor apply             overlay cursor-api-proxy dist/
  npx codex-desktop-cursor test              SSE contract tests
  npx codex-desktop-cursor desktop-version   ChatGPT.app vs release matrix

Patches target cursor-api-proxy, not ChatGPT.app.
`);
