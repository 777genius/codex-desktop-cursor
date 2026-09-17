import { execFileSync } from "node:child_process";
export const DETACH_CHILDREN = false;
function killPidTree(pid, signal) {
    try {
        const kids = execFileSync("pgrep", ["-P", String(pid)], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        })
            .trim()
            .split("\n")
            .filter(Boolean);
        for (const kid of kids)
            killPidTree(Number(kid), signal);
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
export function killProcessTree(child, signal, opts = {}) {
    const detached = opts.detached ?? DETACH_CHILDREN;
    if (detached && typeof child.pid === "number") {
        try {
            process.kill(-child.pid, signal);
            return;
        }
        catch {
            /* group already gone — fall through */
        }
    }
    if (typeof child.pid === "number") {
        killPidTree(child.pid, signal);
        return;
    }
    try {
        child.kill(signal);
    }
    catch {
        /* already exited */
    }
}
//# sourceMappingURL=process-tree-kill.js.map
