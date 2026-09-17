#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
);
const expected = pkg.codexDesktop ?? {};

const app =
  process.env.CODEX_DESKTOP_APP ??
  "/Applications/ChatGPT.app";
const plist = join(app, "Contents/Info.plist");

function plutil(key) {
  if (!existsSync(plist)) return null;
  try {
    return execFileSync("plutil", ["-extract", key, "raw", "--", plist], {
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

const version = plutil("CFBundleShortVersionString");
const build = plutil("CFBundleVersion");
const bundleId = plutil("CFBundleIdentifier");

const ok =
  Boolean(version) &&
  Array.isArray(expected.compatible) &&
  expected.compatible.includes(version);

console.log(
  JSON.stringify(
    {
      app,
      bundleId,
      version,
      build,
      overlay: pkg.version,
      compatible: expected.compatible,
      match: ok,
    },
    null,
    2,
  ),
);
process.exit(ok || !version ? 0 : 2);
