import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveAgentCommand } from "./env.js";
import { DETACH_CHILDREN, killProcessTree } from "./process-tree-kill.js";
import { runMaxModePreflight } from "./max-mode-preflight.js";
const activeChildren = new Set();
// Never wall-clock SIGKILL cursor-agent. LaunchAgent
// CURSOR_BRIDGE_TIMEOUT_MS=900000 and the old 45m floor killed 01a0719d
// mid-turn while stdout was still flowing (14:15Z spawn → exit -1 14:59Z).
// AbortSignal still SIGTERMs on explicit cancel.
export function killAllChildProcesses() {
    for (const child of activeChildren) {
        killProcessTree(child, "SIGTERM");
    }
    activeChildren.clear();
}
export function trackChildProcess(child) {
    activeChildren.add(child);
    child.once("close", () => {
        activeChildren.delete(child);
    });
}
function sanitizeAgentEnv(base, extra) {
    const env = {
        HOME: base.HOME || os.homedir(),
        USER: base.USER || extra?.USER,
        LOGNAME: base.LOGNAME || base.USER,
        PATH: base.PATH || "/usr/bin:/bin",
        SHELL: base.SHELL || "/bin/zsh",
        TMPDIR: base.TMPDIR || os.tmpdir(),
        LANG: base.LANG || "en_US.UTF-8",
        SSH_AUTH_SOCK: base.SSH_AUTH_SOCK,
        CURSOR_CONFIG_DIR: extra?.CURSOR_CONFIG_DIR || base.CURSOR_CONFIG_DIR,
        CURSOR_API_KEY: base.CURSOR_API_KEY,
        TERM: "xterm-256color",
    };
    for (const key of Object.keys(env)) {
        if (env[key] == null || env[key] === "")
            delete env[key];
    }
    if (extra) {
        for (const [key, value] of Object.entries(extra)) {
            if (key.startsWith("CURSOR_BRIDGE_") || key.startsWith("XPC_"))
                continue;
            if (value != null && value !== "")
                env[key] = value;
        }
    }
    return env;
}
function cleanPtyChunk(chunk) {
    return chunk
        .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
        .replace(/\r/g, "\n");
}
function followStdoutFile(file, onChunk) {
    let pos = 0;
    const readNew = () => {
        let st;
        try {
            st = fs.statSync(file);
        }
        catch {
            return;
        }
        if (st.size <= pos)
            return;
        const len = st.size - pos;
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(file, "r");
        try {
            fs.readSync(fd, buf, 0, len, pos);
        }
        finally {
            fs.closeSync(fd);
        }
        pos = st.size;
        onChunk(cleanPtyChunk(buf.toString("utf8")));
    };
    const iv = setInterval(readNew, 40);
    return () => {
        clearInterval(iv);
        readNew();
    };
}
function pythonPtyBin() {
    for (const candidate of [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/opt/miniconda3/bin/python3",
    ]) {
        if (fs.existsSync(candidate))
            return candidate;
    }
    // /usr/bin/python3 on this Mac execs Xcode Python.app — unusable from launchd.
    return "/opt/homebrew/bin/python3";
}
const PROMPT_ARGV_LIMIT = 64 * 1024;
const PROMPT_INJECT = "/Users/belief/.codex/cursor-proxy/inject-prompt.cjs";
function offloadLargePromptArg(args) {
    if (!Array.isArray(args) || args.length === 0) {
        return { args, promptDir: "", promptFile: "" };
    }
    const last = args[args.length - 1];
    if (typeof last !== "string") {
        return { args, promptDir: "", promptFile: "" };
    }
    const bytes = Buffer.byteLength(last, "utf8");
    if (bytes <= PROMPT_ARGV_LIMIT) {
        return { args, promptDir: "", promptFile: "" };
    }
    const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-proxy-prompt-"));
    const promptFile = path.join(promptDir, "prompt.txt");
    fs.writeFileSync(promptFile, last, { encoding: "utf8", mode: 0o600 });
    console.log(`[prompt-inject] ${bytes} bytes -> ${promptFile}`);
    return { args: args.slice(0, -1), promptDir, promptFile };
}
function cleanupPromptDir(promptDir) {
    if (!promptDir)
        return;
    try {
        fs.rmSync(promptDir, { recursive: true, force: true });
    }
    catch {
        /* ignore */
    }
}
function spawnChild(cmd, args, opts) {
    const offloaded = offloadLargePromptArg(args);
    const resolved = resolveAgentCommand(cmd, offloaded.args);
    if (opts?.maxMode) {
        runMaxModePreflight(resolved.agentScriptPath, opts?.configDir);
    }
    const extraEnv = {
        ...(opts?.envOverrides ?? {}),
        ...(opts?.configDir ? { CURSOR_CONFIG_DIR: opts.configDir } : {}),
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
    };
    if (offloaded.promptFile) {
        extraEnv.CURSOR_PROXY_PROMPT_FILE = offloaded.promptFile;
        const prevNodeOptions = extraEnv.NODE_OPTIONS || resolved.env?.NODE_OPTIONS || "";
        extraEnv.NODE_OPTIONS = `${prevNodeOptions} --require ${PROMPT_INJECT}`.trim();
    }
    const env = sanitizeAgentEnv(resolved.env, extraEnv);
    const useStdin = typeof opts?.stdinContent === "string";
    let child;
    let stdoutPath = "";
    if (process.platform === "darwin") {
        // launchd pipes/files deadlock cursor-agent stdout. `script` allocates a
        // PTY but treats stdin EOF (/dev/null from LaunchAgent) as ^D and never
        // copies live output. Python pty.spawn keeps the slave open and writes
        // master bytes unbuffered to our pipe.
        child = spawn(pythonPtyBin(), [
            "-c",
            "import os, pty, sys\nsys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))\n",
            resolved.command,
            ...resolved.args,
        ], {
            cwd: opts?.cwd,
            env,
            stdio: useStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
            windowsVerbatimArguments: resolved.windowsVerbatimArguments,
            detached: false,
        });
    }
    else {
        stdoutPath = path.join(os.tmpdir(), `cursor-proxy-stdout-${randomUUID()}.jsonl`);
        fs.writeFileSync(stdoutPath, "");
        const stdoutFd = fs.openSync(stdoutPath, "w");
        child = spawn(resolved.command, resolved.args, {
            cwd: opts?.cwd,
            env,
            stdio: useStdin ? ["pipe", stdoutFd, "pipe"] : ["ignore", stdoutFd, "pipe"],
            windowsVerbatimArguments: resolved.windowsVerbatimArguments,
            detached: DETACH_CHILDREN,
        });
        const closeParentStdoutFd = () => {
            try {
                fs.closeSync(stdoutFd);
            }
            catch {
                /* already closed */
            }
        };
        child.once("spawn", closeParentStdoutFd);
        child.once("error", closeParentStdoutFd);
    }
    if (useStdin && opts.stdinContent !== undefined && child.stdin) {
        child.stdin.write(opts.stdinContent, "utf8");
        child.stdin.end();
    }
    return { child, stdoutPath, promptDir: offloaded.promptDir };
}
function consumeStdoutFile(stdoutPath) {
    if (!stdoutPath)
        return "";
    try {
        return fs.readFileSync(stdoutPath, "utf8");
    }
    catch {
        return "";
    }
}
function cleanupStdoutFile(stdoutPath) {
    if (!stdoutPath)
        return;
    try {
        fs.unlinkSync(stdoutPath);
    }
    catch {
        /* ignore */
    }
}
function attachLineConsumer(stream, onLine) {
    let lineBuffer = "";
    const consume = (chunk) => {
        lineBuffer += cleanPtyChunk(chunk);
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
            if (line.trim())
                onLine(line);
        }
    };
    if (stream) {
        stream.setEncoding("utf8");
        stream.on("data", consume);
    }
    return {
        consume,
        flush() {
            if (lineBuffer.trim())
                onLine(lineBuffer.trim());
        },
    };
}
export function runStreaming(cmd, args, opts) {
    return new Promise((resolve, reject) => {
        const { child, stdoutPath, promptDir } = spawnChild(cmd, args, {
            cwd: opts.cwd,
            maxMode: opts.maxMode,
            stdinContent: opts.stdinContent,
            envOverrides: opts.envOverrides,
            configDir: opts.configDir,
        });
        activeChildren.add(child);
        const onAbort = () => killProcessTree(child, "SIGTERM");
        if (opts.signal) {
            if (opts.signal.aborted) {
                killProcessTree(child, "SIGTERM");
            }
            else {
                opts.signal.addEventListener("abort", onAbort, { once: true });
            }
        }
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (c) => (stderr += c));
        const lines = attachLineConsumer(child.stdout, opts.onLine);
        const stopFollow = stdoutPath
            ? followStdoutFile(stdoutPath, lines.consume)
            : () => { };
        child.on("error", (err) => {
            opts.signal?.removeEventListener("abort", onAbort);
            activeChildren.delete(child);
            stopFollow();
            cleanupStdoutFile(stdoutPath);
            cleanupPromptDir(promptDir);
            if (err?.code === "ENOENT") {
                reject(new Error(`Command not found: ${cmd}. Install Cursor CLI (agent) or set CURSOR_AGENT_BIN to its path.`));
                return;
            }
            reject(err);
        });
        child.on("close", (code, signal) => {
            opts.signal?.removeEventListener("abort", onAbort);
            activeChildren.delete(child);
            killProcessTree(child, "SIGKILL");
            stopFollow();
            lines.flush();
            cleanupStdoutFile(stdoutPath);
            cleanupPromptDir(promptDir);
            if (signal) {
                const signalNote = `terminated by signal ${signal}`;
                stderr = stderr.trim() ? `${stderr.trim()}\n${signalNote}` : signalNote;
            }
            resolve({ code: code ?? (signal ? -1 : 0), stderr });
        });
    });
}
export function run(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const { child, stdoutPath, promptDir } = spawnChild(cmd, args, {
            cwd: opts.cwd,
            maxMode: opts.maxMode,
            stdinContent: opts.stdinContent,
            envOverrides: opts.envOverrides,
            configDir: opts.configDir,
        });
        activeChildren.add(child);
        const onAbort = () => killProcessTree(child, "SIGTERM");
        if (opts.signal) {
            if (opts.signal.aborted) {
                killProcessTree(child, "SIGTERM");
            }
            else {
                opts.signal.addEventListener("abort", onAbort, { once: true });
            }
        }
        let stderr = "";
        let stdout = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (c) => (stderr += c));
        if (child.stdout) {
            child.stdout.setEncoding("utf8");
            child.stdout.on("data", (c) => (stdout += cleanPtyChunk(c)));
        }
        child.on("error", (err) => {
            opts.signal?.removeEventListener("abort", onAbort);
            activeChildren.delete(child);
            cleanupStdoutFile(stdoutPath);
            cleanupPromptDir(promptDir);
            if (err?.code === "ENOENT") {
                reject(new Error(`Command not found: ${cmd}. Install Cursor CLI (agent) or set CURSOR_AGENT_BIN to its path.`));
                return;
            }
            reject(err);
        });
        child.on("close", (code, signal) => {
            opts.signal?.removeEventListener("abort", onAbort);
            activeChildren.delete(child);
            killProcessTree(child, "SIGKILL");
            stdout = stdout || consumeStdoutFile(stdoutPath);
            cleanupStdoutFile(stdoutPath);
            cleanupPromptDir(promptDir);
            if (signal) {
                const signalNote = `terminated by signal ${signal}`;
                stderr = stderr.trim() ? `${stderr.trim()}\n${signalNote}` : signalNote;
            }
            resolve({ code: code ?? (signal ? -1 : 0), stdout, stderr });
        });
    });
}
export function killDescendants(pid, signal) {
    try {
        const kids = execFileSync("pgrep", ["-P", String(pid)], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        })
            .trim()
            .split("\n")
            .filter(Boolean);
        for (const kid of kids)
            killDescendants(Number(kid), signal);
    }
    catch {
        /* no children */
    }
    try {
        process.kill(pid, signal);
    }
    catch {
        /* already gone */
    }
}
//# sourceMappingURL=process.js.map
