import { randomUUID } from "node:crypto";
import { traceOutbound } from "./stream-trace.js";
import { extractFinalText, extractThinkingText, getLiveRecord } from "./thread-replay.js";
import { getThreadSession, threadKeyFromFollowUp } from "./thread-session.js";

const RESULT_LIMIT = 8000;

function compactId(prefix) {
    return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function clip(text) {
    if (typeof text !== "string")
        return "";
    if (text.length <= RESULT_LIMIT)
        return text;
    return `${text.slice(0, RESULT_LIMIT)}\n…`;
}

function shellArgs(args) {
    if (!args || typeof args !== "object")
        return args;
    const command = args.command ?? args.cmd ?? args.commandChars;
    const workingDirectory = args.working_directory ?? args.workingDirectory ?? args.cwd;
    const timeoutMs = args.timeout_ms ?? args.timeoutMs ?? args.timeout;
    const out = {};
    if (command != null)
        out.command = command;
    if (workingDirectory)
        out.working_directory = workingDirectory;
    if (timeoutMs != null)
        out.timeout_ms = timeoutMs;
    return Object.keys(out).length ? out : args;
}

function toolKey(cursorName) {
    return String(cursorName || "tool").replace(/\s+/g, "").toLowerCase();
}

export function codexToolName(cursorName, args) {
    const key = toolKey(cursorName);
    if (key === "shell" || key === "pibash" || key === "shellcommand" || key === "shell_command")
        return "shell";
    if (key === "edit" || key === "delete" || key === "strreplace" || key === "write" || key === "applyagentdiff" || key === "piwrite" || key === "piedit")
        return "apply_patch";
    if (key === "grep" || key === "rg" || key === "glob" || key === "globfile" || key === "websearch" || key === "webfetch" || key === "codesearch")
        return "web_search";
    if (key === "mcp")
        return args?.toolName || args?.name || args?.tool || "mcp";
    return String(cursorName || "tool").replace(/\s+/g, "_");
}

export function isWebSearchTool(cursorName) {
    const key = toolKey(cursorName);
    return key === "websearch" || key === "webfetch" || key === "web_search" || key === "web_fetch" || key === "fetch";
}

function asRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    return value;
}

/** Desktop thread_goals.status CHECK: active|paused|blocked|usage_limited|budget_limited|complete */
export function normalizeGoalStatus(rawStat) {
    if (rawStat == null || rawStat === "")
        return "";
    if (rawStat === 3 || rawStat === "3")
        return "complete";
    if (rawStat === 1 || rawStat === "1")
        return "active";
    if (rawStat === 2 || rawStat === "2")
        return "paused";
    if (rawStat === 4 || rawStat === "4")
        return "blocked";
    const compact = String(rawStat).toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!compact || compact.includes("incomplete"))
        return "";
    if (compact === "complete" || compact === "completed" || compact === "goalstatuscomplete"
        || compact.endsWith("statuscomplete"))
        return "complete";
    if (compact === "active" || compact === "inprogress" || compact === "goalstatusactive"
        || compact.endsWith("statusactive") || compact.endsWith("statusinprogress"))
        return "active";
    if (compact === "paused" || compact === "goalstatuspaused" || compact.endsWith("statuspaused"))
        return "paused";
    if (compact === "blocked" || compact === "goalstatusblocked" || compact.endsWith("statusblocked"))
        return "blocked";
    return "";
}

function unwrapJsonish(value) {
    if (value && typeof value === "object" && !Array.isArray(value))
        return asRecord(value);
    let s = String(value ?? "").trim();
    const wrapped = /^:\s+['"](\{[\s\S]*\})['"]\s*$/.exec(s);
    if (wrapped)
        s = wrapped[1];
    if (!s.startsWith("{"))
        return undefined;
    try {
        return asRecord(JSON.parse(s));
    }
    catch {
        return undefined;
    }
}

function statusFromArgs(a) {
    const rec = asRecord(a) || {};
    const nested = asRecord(rec.args) || asRecord(rec.arguments) || {};
    return normalizeGoalStatus(rec.status ?? rec.success?.status ?? nested.status ?? nested.success?.status);
}

/** `{status: GOAL_STATUS_COMPLETE}` as MCP args or a fake `: '{…}'` shell. */
export function goalStatusPayload(value) {
    const rec = unwrapJsonish(value);
    if (!rec)
        return normalizeGoalStatus(value);
    const status = statusFromArgs(rec);
    if (!status)
        return "";
    const keys = Object.keys(rec).map((k) => k.toLowerCase());
    const allowed = new Set(["status", "goal_id", "goalid", "id", "success", "args", "arguments"]);
    if (keys.every((k) => allowed.has(k)))
        return status;
    if (keys.some((k) => k.includes("goal")))
        return status;
    return "";
}

/** Cursor MCP envelope and native updateGoalToolCall / createGoalToolCall. */
export function cursorGoalCall(cursorName, args) {
    const a = asRecord(args) || {};
    const key = toolKey(cursorName);
    const toolName = String(a.toolName || a.tool_name || a.name || cursorName || "");
    const toolKeyName = toolKey(toolName);
    const server = String(a.server || a.serverIdentifier || a.server_identifier || a.provider_identifier || "");
    const isMcp = key === "mcp" || Boolean(server) || toolKeyName.startsWith("mcp");
    const isUpdate = toolKeyName === "updategoal" || key === "updategoal";
    const isCreate = toolKeyName === "creategoal" || key === "creategoal";
    const status = statusFromArgs(a) || goalStatusPayload(a) || goalStatusPayload(a.command ?? a.cmd ?? a.raw);
    return { isMcp, isUpdate, isCreate, server, toolName, status };
}

function looksLikeJson(value) {
    const s = String(value || "").trim();
    return s.startsWith("{") || s.startsWith("[");
}

function firstString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    return "";
}

function formatTodos(args) {
    const todos = Array.isArray(args?.todos) ? args.todos : [];
    if (!todos.length)
        return "Todos";
    const mark = (status) => {
        const v = String(status ?? "").toLowerCase();
        if (status === 3 || v === "completed" || v === "complete" || v === "done")
            return "x";
        if (status === 2 || v === "in_progress" || v === "inprogress")
            return "-";
        return " ";
    };
    return todos.slice(0, 16).map((item) => {
        const rec = asRecord(item) || {};
        return `- [${mark(rec.status)}] ${rec.content || rec.text || rec.id || ""}`.trimEnd();
    }).join("\n");
}

function firstPath(args) {
    const a = asRecord(args) || {};
    const nested = Array.isArray(a.paths) ? a.paths.find((p) => typeof p === "string" && p.trim()) : "";
    const dirs = Array.isArray(a.targetDirectories) ? a.targetDirectories[0]
        : Array.isArray(a.target_directories) ? a.target_directories[0]
            : "";
    return firstString(a.path, a.target_directory, a.targetDirectory, a.file_path, a.filePath, nested, dirs);
}

function noteLabel(cursorName, args) {
    const a = asRecord(args) || {};
    const hint = firstString(
        a.objective,
        a.path,
        a.url,
        a.query,
        a.pattern,
        a.description,
        a.title,
        a.name,
        a.overview,
        a.target_mode_id,
        a.targetModeId,
        firstPath(a),
    );
    const name = String(cursorName || "tool").trim() || "tool";
    return hint ? `${name}: ${clipCmd(hint, 160)}` : name;
}

const NOTE_KEYS = new Set([
    "askquestion", "await", "task", "createplan", "updatetodos", "readtodos",
    "getmcptools", "listmcpresources", "readmcpresource", "mcpauth",
    "switchmode", "generateimage", "computeruse", "writeshellstdin",
    "readlints", "searchconversations", "createagent", "getagentstatus",
    "sendtoagent", "stopagent", "sendmessage", "sendtouser", "reflect",
    "reportbug", "prmanagement", "connectscm", "replaceenv", "setupvmenvironment",
    "recordscreen", "readcanvas", "writecanvas", "adopt", "communicateupdate",
    "editprlabels", "getprcodetour", "updateprcodetour", "fetchcloudagentdata",
    "readagenttranscript", "startgrindexecution", "startgrindplanning",
    "recordciinvestigationfindings", "setactivebranch", "sendfinalsummary",
    "reportbugfixresults", "composerenhancer", "aiattribution",
]);

const EDIT_KEYS = new Set(["edit", "delete", "strreplace", "write", "applyagentdiff", "piwrite", "piedit", "searchreplace"]);

const DIFF_CAP = 24000;

function buildV4aDiff(oldText, newText) {
    const oldLines = String(oldText || "").split("\n");
    const newLines = String(newText || "").split("\n");
    const lines = ["@@"];
    if (oldText)
        for (const line of oldLines)
            lines.push(`-${line}`);
    if (newText || !oldText)
        for (const line of newLines)
            lines.push(`+${line}`);
    let diff = lines.join("\n");
    if (diff.length > DIFF_CAP)
        diff = `${diff.slice(0, DIFF_CAP)}\n…`;
    return diff;
}

function patchEnvelope(classified) {
    const path = classified.path || "file";
    if (classified.op === "delete_file")
        return `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch`;
    const header = classified.op === "create_file" ? `*** Add File: ${path}` : `*** Update File: ${path}`;
    const diff = classified.diff || "@@\n";
    return `*** Begin Patch\n${header}\n${diff}\n*** End Patch`;
}

const COMPLETED_TOOL_TAIL = 24;

function clipCompletedItem(item) {
    if (!item || typeof item !== "object")
        return item;
    const copy = { ...item };
    if (typeof copy.arguments === "string" && copy.arguments.length > 2000)
        copy.arguments = `${copy.arguments.slice(0, 2000)}…`;
    if (Array.isArray(copy.summary)) {
        copy.summary = copy.summary.map((part) => {
            if (typeof part?.text === "string" && part.text.length > 2500)
                return { ...part, text: `${part.text.slice(0, 2500)}…` };
            return part;
        });
    }
    return copy;
}

/** Mixin/Desktop fail JSON-decoding a completed event with thousands of tools. */
export function slimCompletedOutput(items) {
    if (!Array.isArray(items))
        return [];
    const important = (item) => {
        const t = item?.type;
        if (t === "message" || t === "reasoning")
            return true;
        if (t === "function_call" && item?.name === "apply_patch")
            return true;
        return false;
    };
    let drop = Math.max(0, items.reduce((n, item) => n + (important(item) ? 0 : 1), 0) - COMPLETED_TOOL_TAIL);
    const out = [];
    for (const item of items) {
        if (!important(item) && drop > 0) {
            drop -= 1;
            continue;
        }
        out.push(clipCompletedItem(item));
    }
    return out;
}

/**
 * Cursor stream-json tools → Desktop items.
 * Only real shell/read/search become exec_command. JSON blobs must not.
 */
export function classifyCursorTool(cursorName, args) {
    const key = toolKey(cursorName);
    const a = asRecord(args) || {};
    const goal = cursorGoalCall(cursorName, args);
    const blobStatus = goal.status
        || goalStatusPayload(a.command ?? a.cmd ?? a.commandChars)
        || goalStatusPayload(a.raw);
    if ((goal.isUpdate || blobStatus) && blobStatus)
        return { kind: "update_goal", status: blobStatus, goal };
    if (goal.isCreate) {
        const objective = firstString(a.objective, a.goal);
        const label = [goal.server, goal.toolName || cursorName].filter(Boolean).join("/");
        return { kind: "note", text: objective ? `Goal: ${clipCmd(objective, 220)}` : `Called ${label}`, goal };
    }
    if (goal.isMcp || goal.isUpdate) {
        const label = [goal.server, goal.toolName || cursorName].filter(Boolean).join("/");
        return { kind: "note", text: goal.status ? `${label} → ${goal.status}` : `Called ${label}`, goal };
    }
    if (isWebSearchTool(cursorName)) {
        const query = firstString(a.url, a.pattern, a.search_term, a.searchTerm, a.query);
        return { kind: "search", text: query };
    }
    const filePath = firstPath(a);
    if (["read", "readfile", "piread"].includes(key) && filePath) {
        const offset = Number(a.offset);
        const limit = Number(a.limit);
        if (Number.isFinite(offset) && Number.isFinite(limit) && limit > 0) {
            const from = Math.max(1, Math.floor(offset));
            const to = from + Math.floor(limit) - 1;
            return { kind: "exec", cmd: clipCmd(`sed -n ${shellQuote(`${from},${to}p`)} ${shellQuote(filePath)}`) };
        }
        return { kind: "exec", cmd: clipCmd(`cat ${shellQuote(filePath)}`) };
    }
    if (["grep", "rg", "pigrep", "codesearch", "semsearch"].includes(key)) {
        const q = firstString(a.pattern, a.query);
        const dir = firstString(filePath, Array.isArray(a.targetDirectories) ? a.targetDirectories[0] : "", Array.isArray(a.target_directories) ? a.target_directories[0] : "");
        if (q)
            return { kind: "exec", cmd: clipCmd(dir ? `rg -n ${shellQuote(q)} ${shellQuote(dir)}` : `rg -n ${shellQuote(q)}`) };
    }
    if (["glob", "globfile", "pifind"].includes(key)) {
        const glob = firstString(a.glob_pattern, a.globPattern, a.pattern, a.glob) || "*";
        return { kind: "exec", cmd: clipCmd(`find ${shellQuote(filePath || ".")} -name ${shellQuote(glob)}`) };
    }
    if (["ls", "pils", "listfiles"].includes(key))
        return { kind: "exec", cmd: clipCmd(filePath ? `ls ${shellQuote(filePath)}` : "ls") };
    if (EDIT_KEYS.has(key)) {
        const path = filePath || "file";
        if (key.includes("delete"))
            return { kind: "patch", op: "delete_file", path };
        const oldText = firstString(a.old_string, a.oldString, a.old_str);
        const newText = firstString(
            a.new_string, a.newString, a.new_str,
            a.stream_content, a.streamContent,
            a.contents, a.text, a.new_text, a.newText,
        );
        const op = key.includes("write") && !oldText ? "create_file" : "update_file";
        return { kind: "patch", op, path, diff: buildV4aDiff(oldText, newText) };
    }
    if (["updatetodos", "readtodos"].includes(key))
        return { kind: "note", text: formatTodos(a) };
    if (key === "createplan")
        return { kind: "note", text: firstString(a.overview, a.plan, a.name) || "Plan" };
    if (key === "task")
        return { kind: "note", text: firstString(a.description, a.prompt) || "subagent" };
    if (key === "await")
        return { kind: "note", text: a.task_id || a.taskId ? `Waiting ${a.task_id || a.taskId}` : "Waiting" };
    if (key === "askquestion")
        return { kind: "note", text: firstString(a.title, a.prompt) || "Question" };
    if (key === "switchmode")
        return { kind: "note", text: firstString(a.target_mode_id, a.targetModeId, a.explanation) || "Switch mode" };
    if (key === "generateimage")
        return { kind: "note", text: firstString(a.description, filePath) || "Image" };
    if (key === "computeruse")
        return { kind: "note", text: firstString(a.description) || "Computer use" };
    if (key === "writeshellstdin")
        return { kind: "note", text: "Wrote stdin" };
    if (key === "readlints") {
        const paths = Array.isArray(a.paths) ? a.paths.filter((p) => typeof p === "string") : [];
        return { kind: "note", text: paths.length ? `Lints ${paths.slice(0, 4).join(", ")}` : "Lints" };
    }
    if (NOTE_KEYS.has(key))
        return { kind: "note", text: noteLabel(cursorName, a) };
    const view = describeCursorTool(cursorName, args);
    if (view.kind === "search" && view.text)
        return { kind: "search", text: view.text };
    const rawCmd = a.command ?? a.cmd ?? a.commandChars;
    if (rawCmd && typeof rawCmd === "object" && !Array.isArray(rawCmd))
        return { kind: "note", text: noteLabel(cursorName, a) };
    const cmd = displayExecCmd(cursorName, args, view.text);
    const cmdGoal = goalStatusPayload(cmd) || goalStatusPayload(view.text);
    if (cmdGoal)
        return { kind: "update_goal", status: cmdGoal, goal };
    if (!cmd || looksLikeJson(cmd) || looksLikeJson(view.text) || /: ['"]\{/.test(cmd))
        return { kind: "note", text: noteLabel(cursorName, a) };
    return { kind: "exec", cmd, cwd: firstString(a.working_directory, a.workingDirectory, a.cwd) };
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function clipCmd(cmd, max = 220) {
    const s = String(cmd || "").replace(/\s+/g, " ").trim();
    if (s.length <= max)
        return s;
    return `${s.slice(0, max - 1)}…`;
}

/** Commands parse_command classifies as Read/Search/ListFiles — native exec titles. */
const LOCAL_PARSE_CMD = /^(cat|sed|head|tail|bat|batcat|less|more|awk|rg|rga|grep|egrep|fgrep|ag|ack|find|ls|tree|fd|eza|exa|git)\b/;

/**
 * Unified exec `cmd` for Desktop's one commandExecution widget.
 * Read/rg/ls stay literal so parsedCmd becomes Read/Search/ListFiles.
 * ssh and other shell stay visible in a Ran card but run as `: '…'` so
 * Desktop does not re-execute production commands.
 */
export function displayExecCmd(cursorName, args, viewText) {
    const key = toolKey(cursorName);
    const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const filePath = String(a.path || a.target_directory || a.targetDirectory || a.file_path || a.filePath || "");
    if (["read", "readfile"].includes(key) && filePath) {
        const offset = Number(a.offset);
        const limit = Number(a.limit);
        if (Number.isFinite(offset) && Number.isFinite(limit) && limit > 0) {
            const from = Math.max(1, Math.floor(offset));
            const to = from + Math.floor(limit) - 1;
            return clipCmd(`sed -n ${shellQuote(`${from},${to}p`)} ${shellQuote(filePath)}`);
        }
        return clipCmd(`cat ${shellQuote(filePath)}`);
    }
    if (["grep", "rg", "codesearch"].includes(key)) {
        const q = String(a.pattern || a.query || "");
        return clipCmd(filePath ? `rg -n ${shellQuote(q)} ${shellQuote(filePath)}` : `rg -n ${shellQuote(q)}`);
    }
    if (["glob", "globfile", "pifind"].includes(key)) {
        const glob = String(a.glob_pattern || a.globPattern || a.pattern || a.glob || "*");
        return clipCmd(`find ${shellQuote(filePath || ".")} -name ${shellQuote(glob)}`);
    }
    if (["ls", "pils", "listfiles"].includes(key))
        return clipCmd(filePath ? `ls ${shellQuote(filePath)}` : "ls");
    const raw = a.command ?? a.cmd ?? a.commandChars ?? viewText ?? key;
    const cmd = Array.isArray(raw) ? raw.map(String).join(" ") : String(raw || "true").trim();
    if (LOCAL_PARSE_CMD.test(cmd))
        return clipCmd(cmd);
    return clipCmd(`: ${shellQuote(cmd)}`);
}

/** Map a Cursor tool into a native Responses item (web search vs local shell). */
export function describeCursorTool(cursorName, args) {
    const key = toolKey(cursorName);
    const a = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const filePath = a.path || a.target_directory || a.targetDirectory || a.file_path || a.filePath || "";
    if (isWebSearchTool(cursorName)) {
        const query = a.pattern || a.search_term || a.searchTerm || a.query || a.url || "";
        return { kind: "search", text: [query, filePath].filter(Boolean).join(" ").trim() };
    }
    if (a.command != null || a.cmd != null || a.commandChars != null) {
        const cmd = a.command ?? a.cmd ?? a.commandChars;
        return { kind: "command", text: Array.isArray(cmd) ? cmd.map(String).join(" ") : String(cmd || "") };
    }
    if (["grep", "rg", "glob", "globfile", "codesearch", "search"].includes(key)) {
        const query = a.pattern || a.search_term || a.searchTerm || a.query || a.glob_pattern || a.globPattern || a.glob || "";
        return { kind: "command", text: [query, filePath].filter(Boolean).join(" ").trim() };
    }
    if (["read", "readfile"].includes(key)) {
        const offset = a.offset;
        const limit = a.limit;
        if (filePath && offset != null && limit != null)
            return { kind: "command", text: `${filePath}:${offset}-${Number(offset) + Number(limit)}` };
        return { kind: "command", text: filePath || "read" };
    }
    if (["edit", "delete", "strreplace", "write", "applyagentdiff", "piwrite", "piedit"].includes(key))
        return { kind: "command", text: filePath || "apply_patch" };
    if (typeof args === "string")
        return { kind: "command", text: args };
    return { kind: "command", text: toolInput(codexToolName(cursorName, args), args) };
}

function toolInput(name, args) {
    if (name === "shell") {
        const cmd = args?.command ?? args?.cmd ?? args?.commandChars;
        if (typeof cmd === "string")
            return cmd;
        if (Array.isArray(cmd))
            return cmd.map(String).join(" ");
    }
    if (typeof args === "string")
        return args;
    try {
        return JSON.stringify(args ?? {});
    }
    catch {
        return "";
    }
}

export function createResponsesNativeStream(opts) {
    const { res, writeEvent: writeEventRaw, responseId, body, displayModel, createdAt, promptTokens } = opts;
    const seenSse = new Set();
    const writeEvent = (type, data) => {
        if (seenSse.size < 20 && !seenSse.has(type)) {
            seenSse.add(type);
            console.log(`[sse] ${type}`);
        }
        if (type === "response.output_item.added" || type === "response.output_item.done" || type === "response.completed" || type === "response.failed") {
            traceOutbound(type, {
                itemType: data?.item?.type || null,
                mapped: data?.item?.phase || data?.item?.name || data?.response?.status || "sse",
            });
        }
        return writeEventRaw(type, data);
    };
    let outputIndex = 0;
    let commentary;
    let reasoning;
    let message;
    let text = "";
    let finished = false;
    const tools = new Map();
    const output = [];

    const nextIndex = () => outputIndex++;

    const emitMessageItem = (item, { streamText } = {}) => {
        const index = item._index;
        writeEvent("response.output_item.added", {
            response_id: responseId,
            output_index: index,
            item: {
                id: item.id,
                type: "message",
                status: "in_progress",
                role: "assistant",
                phase: item.phase,
                content: [],
            },
        });
        writeEvent("response.content_part.added", {
            response_id: responseId,
            item_id: item.id,
            output_index: index,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
        });
        if (streamText) {
            writeEvent("response.output_text.delta", {
                response_id: responseId,
                item_id: item.id,
                output_index: index,
                content_index: 0,
                delta: streamText,
            });
        }
    };

    const completeMessageItem = (item, body) => {
        const index = item._index;
        const content = [{ type: "output_text", text: body, annotations: [] }];
        writeEvent("response.output_text.done", {
            response_id: responseId,
            item_id: item.id,
            output_index: index,
            content_index: 0,
            text: body,
        });
        writeEvent("response.content_part.done", {
            response_id: responseId,
            item_id: item.id,
            output_index: index,
            content_index: 0,
            part: content[0],
        });
        const done = {
            id: item.id,
            type: "message",
            status: "completed",
            role: "assistant",
            phase: item.phase,
            content,
        };
        writeEvent("response.output_item.done", {
            response_id: responseId,
            output_index: index,
            item: done,
        });
        output.push(done);
    };

    const startCommentary = () => {
        if (commentary)
            return;
        const itemId = compactId("msg");
        const index = nextIndex();
        commentary = { id: itemId, _index: index, phase: "commentary", text: "" };
        emitMessageItem(commentary);
    };

    const closeCommentary = () => {
        if (!commentary)
            return;
        completeMessageItem(commentary, commentary.text);
        commentary = undefined;
    };

    const reasoningItem = (id, summaryText) => ({
        id,
        type: "reasoning",
        summary: summaryText == null ? [] : [{ type: "summary_text", text: summaryText }],
    });

    const startReasoning = () => {
        if (reasoning)
            return;
        const itemId = compactId("rs");
        const index = nextIndex();
        reasoning = { id: itemId, _index: index, text: "", partAdded: false };
        writeEvent("response.output_item.added", {
            response_id: responseId,
            output_index: index,
            item: reasoningItem(itemId),
        });
    };

    const ensureReasoningPart = () => {
        if (!reasoning || reasoning.partAdded)
            return;
        reasoning.partAdded = true;
        writeEvent("response.reasoning_summary_part.added", {
            response_id: responseId,
            item_id: reasoning.id,
            output_index: reasoning._index,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
        });
    };

    const closeReasoning = () => {
        if (!reasoning)
            return;
        ensureReasoningPart();
        const body = reasoning.text;
        writeEvent("response.reasoning_summary_text.done", {
            response_id: responseId,
            item_id: reasoning.id,
            output_index: reasoning._index,
            summary_index: 0,
            text: body,
        });
        writeEvent("response.reasoning_summary_part.done", {
            response_id: responseId,
            item_id: reasoning.id,
            output_index: reasoning._index,
            summary_index: 0,
            part: { type: "summary_text", text: body },
        });
        const done = reasoningItem(reasoning.id, body);
        writeEvent("response.output_item.done", {
            response_id: responseId,
            output_index: reasoning._index,
            item: done,
        });
        output.push(done);
        reasoning = undefined;
    };

    const emitToolCommentary = (line) => {
        const clipped = line.length > 1500 ? `${line.slice(0, 1500)}\n…` : line;
        if (!clipped)
            return;
        const itemId = compactId("msg");
        const index = nextIndex();
        const item = { id: itemId, _index: index, phase: "commentary" };
        emitMessageItem(item, { streamText: clipped });
        completeMessageItem(item, clipped);
    };

    const emitWebSearch = (query) => {
        let q = String(query || "").trim().replace(/\s+/g, " ");
        if (!q)
            return;
        if (q.length > 240)
            q = `${q.slice(0, 240)}…`;
        const itemId = compactId("ws");
        const index = nextIndex();
        const item = {
            id: itemId,
            type: "web_search_call",
            status: "in_progress",
            action: { type: "search", query: q },
        };
        writeEvent("response.output_item.added", {
            response_id: responseId,
            output_index: index,
            item,
        });
        const done = { ...item, status: "completed" };
        writeEvent("response.output_item.done", {
            response_id: responseId,
            output_index: index,
            item: done,
        });
        output.push(done);
        return { itemId, index, kind: "web_search", callId: itemId, input: q, done: true };
    };

    const completeExecCommand = (rec) => {
        if (!rec || rec.done || rec.kind !== "exec_command")
            return;
        const done = {
            id: rec.itemId,
            type: "function_call",
            status: "completed",
            call_id: rec.callId,
            name: "exec_command",
            arguments: rec.argumentsJson,
        };
        writeEvent("response.output_item.done", {
            response_id: responseId,
            output_index: rec.index,
            item: done,
        });
        output.push(done);
        rec.done = true;
    };

    const emitNamedFunction = (callId, name, args) => {
        const itemId = compactId("fc");
        const index = nextIndex();
        const argumentsJson = JSON.stringify(args);
        const item = {
            id: itemId,
            type: "function_call",
            status: "completed",
            call_id: callId,
            name,
            arguments: argumentsJson,
        };
        writeEvent("response.output_item.added", {
            response_id: responseId,
            output_index: index,
            item: { ...item, status: "in_progress" },
        });
        writeEvent("response.output_item.done", {
            response_id: responseId,
            output_index: index,
            item,
        });
        output.push(item);
        return { itemId, index, kind: name, callId, argumentsJson, done: true };
    };

    const emitExecCommand = (callId, cmd, cwd) => {
        const itemId = compactId("fc");
        const index = nextIndex();
        const args = { cmd, tty: false, timeout_ms: 8000 };
        if (cwd)
            args.workdir = cwd;
        const argumentsJson = JSON.stringify(args);
        const item = {
            id: itemId,
            type: "function_call",
            status: "in_progress",
            call_id: callId,
            name: "exec_command",
            arguments: argumentsJson,
        };
        writeEvent("response.output_item.added", {
            response_id: responseId,
            output_index: index,
            item,
        });
        const rec = { itemId, index, kind: "exec_command", callId, input: cmd, cmd, cwd, argumentsJson, done: false };
        completeExecCommand(rec);
        return rec;
    };

    const COMMENTARY_CAP = 2000;

    const onThinking = (delta) => {
        if (finished || !delta)
            return;
        startReasoning();
        ensureReasoningPart();
        reasoning.text += delta;
        writeEvent("response.reasoning_summary_text.delta", {
            response_id: responseId,
            item_id: reasoning.id,
            output_index: reasoning._index,
            summary_index: 0,
            delta,
        });
        // Cursor stream-json has no assistant deltas between tools — only
        // thinking, then one assistant blob at result. Surface a clipped
        // copy as commentary so Desktop is not a tool list until the end.
        startCommentary();
        if (commentary.text.length >= COMMENTARY_CAP)
            return;
        const room = COMMENTARY_CAP - commentary.text.length;
        const chunk = delta.length > room ? `${delta.slice(0, Math.max(0, room - 1))}…` : delta;
        if (!chunk)
            return;
        commentary.text += chunk;
        writeEvent("response.output_text.delta", {
            response_id: responseId,
            item_id: commentary.id,
            output_index: commentary._index,
            content_index: 0,
            delta: chunk,
        });
    };

    const onTool = (tool) => {
        if (finished)
            return;
        closeReasoning();
        closeCommentary();
        const callId = tool.callId || compactId("call");
        const argsObj = tool.args && typeof tool.args === "object" && !Array.isArray(tool.args) ? { ...tool.args } : {};
        if (argsObj.status == null && tool.result && typeof tool.result === "object") {
            const fromResult = tool.result.status ?? tool.result.success?.status;
            if (fromResult != null)
                argsObj.status = fromResult;
        }
        let rec = tools.get(callId);
        const goal = cursorGoalCall(tool.name, argsObj);
        if (rec?.kind === "mcp" && goal.isUpdate && goal.status) {
            rec = emitNamedFunction(callId, "update_goal", { status: goal.status });
            emitToolCommentary(`Goal → ${goal.status}`);
            tools.set(callId, rec);
            return;
        }
        if (!rec) {
            const classified = classifyCursorTool(tool.name, argsObj);
            if (classified.kind === "search") {
                const searchRec = emitWebSearch(classified.text || noteLabel(tool.name, argsObj));
                if (searchRec) {
                    tools.set(callId, searchRec);
                    return;
                }
                emitToolCommentary(noteLabel(tool.name, argsObj));
                tools.set(callId, { kind: "mcp", callId, done: true });
                return;
            }
            if (classified.kind === "update_goal") {
                rec = emitNamedFunction(callId, "update_goal", { status: classified.status });
                emitToolCommentary(`Goal → ${classified.status}`);
                tools.set(callId, rec);
                return;
            }
            if (classified.kind === "patch") {
                rec = emitNamedFunction(callId, "apply_patch", { input: patchEnvelope(classified) });
                tools.set(callId, rec);
                return;
            }
            if (classified.kind === "note" || !classified.cmd) {
                emitToolCommentary(classified.text || noteLabel(tool.name, argsObj));
                rec = { kind: "mcp", callId, done: true };
                tools.set(callId, rec);
                return;
            }
            rec = emitExecCommand(callId, classified.cmd, classified.cwd || argsObj.working_directory || argsObj.workingDirectory || argsObj.cwd || "");
            tools.set(callId, rec);
        }
        if (rec && !rec.done && rec.kind === "exec_command")
            completeExecCommand(rec);
        else if (rec)
            rec.done = true;
    };

    const onText = (delta) => {
        if (finished || !delta)
            return text;
        closeReasoning();
        closeCommentary();
        if (!message) {
            const itemId = compactId("msg");
            const index = nextIndex();
            message = { id: itemId, _index: index, phase: "final_answer" };
            emitMessageItem(message);
        }
        text += delta;
        writeEvent("response.output_text.delta", {
            response_id: responseId,
            item_id: message.id,
            output_index: message._index,
            content_index: 0,
            delta,
        });
        return text;
    };

    const finish = () => {
        if (finished)
            return text;
        finished = true;
        closeReasoning();
        closeCommentary();
        for (const rec of tools.values()) {
            if (rec.done)
                continue;
            if (rec.kind === "exec_command")
                completeExecCommand(rec);
            rec.done = true;
        }
        if (message)
            completeMessageItem(message, text);
        const completionTokens = Math.max(1, Math.round(text.length / 4));
        const slimOutput = slimCompletedOutput(output);
        if (output.length > slimOutput.length)
            console.log(`[sse] completed slim ${output.length} -> ${slimOutput.length}`);
        writeEvent("response.completed", {
            response: {
                id: responseId,
                object: "response",
                created_at: createdAt,
                status: "completed",
                background: false,
                error: null,
                incomplete_details: null,
                instructions: body.instructions ?? null,
                max_output_tokens: body.max_output_tokens ?? null,
                model: displayModel,
                output: slimOutput,
                output_text: text,
                parallel_tool_calls: body.parallel_tool_calls ?? true,
                previous_response_id: body.previous_response_id ?? null,
                reasoning: body.reasoning ?? null,
                service_tier: body.service_tier ?? "default",
                store: body.store ?? false,
                temperature: body.temperature ?? null,
                text: body.text ?? { format: { type: "text" } },
                tool_choice: body.tool_choice ?? "auto",
                tools: [],
                top_p: body.top_p ?? null,
                truncation: body.truncation ?? "disabled",
                usage: {
                    input_tokens: promptTokens,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens: completionTokens,
                    output_tokens_details: { reasoning_tokens: 0 },
                    total_tokens: promptTokens + completionTokens,
                },
                user: body.user ?? null,
                metadata: body.metadata ?? null,
            },
        });
        try {
            if (!opts.fanoutDone && !res.writableEnded && !res.destroyed)
                res.write("data: [DONE]\n\n");
        }
        catch {
            /* client gone; events may still be buffered for Desktop retry */
        }
        return text;
    };

    return {
        onThinking,
        onTool,
        onText,
        closeReasoning,
        finish,
        getText: () => text,
        isFinished: () => finished,
    };
}

function recoverCompactText(body, given) {
    const givenText = typeof given === "string" ? given.trim() : "";
    if (givenText)
        return givenText;
    const key = threadKeyFromFollowUp(body);
    const rec = getLiveRecord(key);
    const liveText = (extractFinalText(rec) || "").trim();
    if (liveText)
        return liveText;
    const saved = String(getThreadSession(key)?.lastOutputText || "").trim();
    if (saved)
        return saved;
    return (extractThinkingText(rec) || "").trim();
}

export function emitCompactReplay(opts) {
    const { res, writeEvent, responseId, body, displayModel, createdAt } = opts;
    const text = recoverCompactText(body, opts.text);
    if (!opts.text?.trim() && text)
        console.log(`[replay] compact recovered ${text.length} chars`);
    const thinking = opts.thinking;
    const native = createResponsesNativeStream({
        res,
        writeEvent,
        responseId,
        body,
        displayModel,
        createdAt,
        promptTokens: 1,
    });
    writeEvent("response.created", {
        response: {
            id: responseId,
            object: "response",
            created_at: createdAt,
            status: "in_progress",
            model: displayModel,
            output: [],
        },
    });
    if (thinking)
        native.onThinking(thinking);
    if (text)
        native.onText(text);
    native.finish();
    return native;
}

/**
 * Desktop reconnect while cursor-agent is still running.
 * Mixin errors on a hanging created-only stream, but response.completed
 * with no assistant text marks the Desktop turn finished (019fc3aa 09:19).
 * keepOpen: stream Thought in progress and finish later on this same native.
 */
export function emitInFlightSnapshot(opts) {
    const { writeEvent, responseId, body, displayModel, createdAt, thinking, history } = opts;
    const native = createResponsesNativeStream({
        res: opts.res,
        writeEvent,
        responseId,
        body: body || {},
        displayModel,
        createdAt,
        promptTokens: 1,
        fanoutDone: !opts.keepOpen,
    });
    writeEvent("response.created", {
        response: {
            id: responseId,
            object: "response",
            created_at: createdAt,
            status: "in_progress",
            model: displayModel,
            output: [],
        },
    });
    if (opts.keepOpen) {
        const raw = String(thinking || "Working…");
        native.onThinking(raw.length > 2500 ? `…\n${raw.slice(-2500)}` : raw);
        return native;
    }
    const steps = Array.isArray(history) ? history : [];
    if (steps.length) {
        for (const step of steps) {
            if (step.kind === "thought" && step.text)
                native.onThinking(step.text);
            native.closeReasoning();
            // Do not replay tools as exec_command: Desktop re-runs them,
            // then POSTs thousands of function_call_outputs and the turn
            // collapses into Reconnecting / error decoding response body.
        }
        return native;
    }
    native.onThinking(thinking || "Working…");
    native.closeReasoning();
    return native;
}

/** After response.created already went out on a reattached Desktop socket. */
export function emitCompactContinue(opts) {
    const { res, writeEvent, responseId, body, displayModel, createdAt, text, thinking } = opts;
    const native = createResponsesNativeStream({
        res,
        writeEvent,
        responseId,
        body,
        displayModel,
        createdAt,
        promptTokens: 1,
    });
    if (thinking)
        native.onThinking(thinking);
    if (text)
        native.onText(text);
    native.finish();
    return native;
}

export function emitFailed(opts) {
    const { writeEvent, responseId, createdAt, displayModel, message } = opts;
    writeEvent("response.failed", {
        response: {
            id: responseId,
            object: "response",
            created_at: createdAt,
            status: "failed",
            error: { message: message || "stream failed", code: "cursor_cli_error" },
            output: [],
            model: displayModel,
        },
    });
}
