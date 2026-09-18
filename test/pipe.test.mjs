process.env.CURSOR_BRIDGE_TRACE = "0";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { playCursorNdjson, assertDesktopSse } from "./harness.mjs";
import { extractCodexThreadId } from "../patches/cursor-turn.js";
import { isDesktopExecFollowUp, responsesToolOutputs } from "../patches/tool-types.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cursor-agent-auto-read.ndjson");

{
    // Recorded 2026-09-17 from:
    // cursor-agent --print --mode ask --model auto --trust --sandbox enabled
    //   --output-format stream-json --stream-partial-output
    const ndjson = readFileSync(FIXTURE, "utf8");
    const played = playCursorNdjson(ndjson, { responseId: "resp_auto_read" });
    const { exec } = assertDesktopSse(played);
    if (!played.types.includes("thinking delta") || !played.types.includes("tool_call started"))
        throw new Error(`fixture must be the real Auto tool turn, got ${played.types.join(" | ")}`);
    if (!played.types.includes("assistant") || !played.types.includes("result success"))
        throw new Error("fixture missing assistant / result success");
    const args = JSON.parse(exec[0].data.item.arguments);
    if (!/hello\.txt/.test(args.cmd || "") || String(args.cmd).startsWith(": "))
        throw new Error(`Read must be a native Read card, got ${args.cmd}`);
    if (played.text !== "hello-from-fixture")
        throw new Error(`assistant deltas + final snapshot must not double, got ${JSON.stringify(played.text)}`);
    const assistantLines = played.types.filter((t) => t === "assistant").length;
    if (assistantLines < 2)
        throw new Error("this capture streams assistant as several content deltas then a snapshot");
    console.log("ok recorded Auto stream-json → Desktop Thought / Read / text");
}

{
    // Codex Desktop Responses POST (wire types from ChatGPT.app + Mixin, not Chat Completions).
    const thread = "01a0719d-424f-7801-8acf-be9add1e0114";
    const userBody = {
        model: "auto",
        stream: true,
        store: false,
        input: [{
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `continue\ncodex://threads/${thread}` }],
        }],
        tools: [
            { type: "web_search" },
            { type: "local_shell" },
            { type: "apply_patch" },
        ],
    };
    const fromHeader = extractCodexThreadId({ "x-codex-thread-id": thread }, { model: "auto", input: [] }, "");
    const fromInput = extractCodexThreadId({}, userBody, "");
    if (fromHeader !== thread || fromInput !== thread)
        throw new Error(`Desktop thread id, header=${fromHeader} input=${fromInput}`);
    const followBody = {
        model: "auto",
        stream: true,
        previous_response_id: "resp_prev",
        input: [{
            type: "function_call_output",
            call_id: "call_1",
            output: "hello-from-fixture\n",
        }],
    };
    const outputs = responsesToolOutputs(followBody.input);
    if (!isDesktopExecFollowUp(followBody, outputs))
        throw new Error("outputs-only Desktop POST must be exec follow-up, not a new Cursor turn");
    if (isDesktopExecFollowUp(userBody, []))
        throw new Error("user message POST must start a Cursor turn");
    console.log("ok Desktop Responses user turn vs exec_command follow-up");
}

{
    // Real cursor-agent mcpToolCall shape (server cursor / UpdateGoal).
    const ndjson = [
        JSON.stringify({ type: "system", subtype: "init", model: "Auto", session_id: "11111111-1111-4111-8111-111111111111" }),
        JSON.stringify({
            type: "tool_call",
            subtype: "started",
            call_id: "call-605bdf04-e876-40c7-93a9-c4b8212a5daf-0",
            tool_call: {
                mcpToolCall: {
                    args: {
                        server: "cursor",
                        toolName: "UpdateGoal",
                        toolCallId: "0_tool_5fbb9c13-7035-4781-b0c7-2fcea3b18",
                        args: { status: "COMPLETE" },
                    },
                    toolCallId: "call-605bdf04-e876-40c7-93a9-c4b8212a5daf-0",
                },
            },
        }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
        JSON.stringify({ type: "result", subtype: "success", result: "done" }),
    ].join("\n");
    const played = playCursorNdjson(ndjson, { responseId: "resp_update_goal" });
    assertDesktopSse(played);
    const names = played.sse.filter((e) => e.data?.item?.type === "function_call").map((e) => e.data.item.name);
    if (!names.includes("update_goal"))
        throw new Error(`UpdateGoal must become function_call update_goal, got ${names.join(",") || "none"}`);
    if (names.includes("exec_command"))
        throw new Error("UpdateGoal must not become exec_command Ran card");
    const args = JSON.parse(played.sse.find((e) => e.data?.item?.name === "update_goal").data.item.arguments);
    if (args.status !== "complete")
        throw new Error(`Desktop goal status must be complete, got ${JSON.stringify(args)}`);
    console.log("ok Cursor UpdateGoal MCP → Desktop update_goal complete");
}

{
    const ndjson = [
        JSON.stringify({
            type: "tool_call",
            subtype: "started",
            call_id: "call-envelope-only",
            tool_call: {
                mcpToolCall: {
                    args: {
                        server: "cursor",
                        toolName: "UpdateGoal",
                        toolCallId: "0_tool_5fbb9c13-7035-4781-b0c7-2fcea3b18",
                    },
                },
            },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
    ].join("\n");
    const played = playCursorNdjson(ndjson, { responseId: "resp_goal_envelope" });
    if (played.sse.some((e) => e.data?.item?.name === "exec_command"))
        throw new Error("envelope-only UpdateGoal must not render as $: JSON Ran");
    if (!played.sse.some((e) => e.data?.item?.phase === "commentary"))
        throw new Error("envelope-only UpdateGoal should be visible commentary, not a shell");
    console.log("ok UpdateGoal without status is not a fake shell");
}

{
    const protoNdjson = [
        JSON.stringify({
            type: "tool_call",
            subtype: "started",
            call_id: "call-goal-proto",
            tool_call: {
                updateGoalToolCall: {
                    args: { status: "GOAL_STATUS_COMPLETE" },
                },
            },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
    ].join("\n");
    const protoPlayed = playCursorNdjson(protoNdjson, { responseId: "resp_goal_proto" });
    const protoFc = protoPlayed.sse.find((e) => e.data?.item?.name === "update_goal");
    if (!protoFc)
        throw new Error("updateGoalToolCall GOAL_STATUS_COMPLETE must be Desktop update_goal");
    if (JSON.parse(protoFc.data.item.arguments).status !== "complete")
        throw new Error("Desktop sidebar needs status complete, not the Cursor enum");
    if (protoPlayed.sse.some((e) => e.data?.item?.name === "exec_command"))
        throw new Error("GOAL_STATUS_COMPLETE must not become a Ran card");

    const fakeShellNdjson = [
        JSON.stringify({
            type: "tool_call",
            subtype: "started",
            call_id: "call-goal-shell-json",
            tool_call: {
                shellToolCall: {
                    args: { command: `{"status":"GOAL_STATUS_COMPLETE"}` },
                },
            },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
    ].join("\n");
    const fakePlayed = playCursorNdjson(fakeShellNdjson, { responseId: "resp_goal_shell_json" });
    if (!fakePlayed.sse.some((e) => e.data?.item?.name === "update_goal"))
        throw new Error("`: '{GOAL_STATUS_COMPLETE}'` shell must still close Desktop's goal");
    if (fakePlayed.sse.some((e) => e.data?.item?.name === "exec_command"))
        throw new Error("goal JSON shell must not render as Ran");
    console.log("ok GOAL_STATUS_COMPLETE → native update_goal complete");
}

{
    const fetchNdjson = [
        JSON.stringify({
            type: "tool_call",
            subtype: "started",
            call_id: "call-fetch-1",
            tool_call: { fetchToolCall: { args: { url: "https://example.com/health" } } },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
    ].join("\n");
    const fetchPlayed = playCursorNdjson(fetchNdjson, { responseId: "resp_fetch" });
    if (!fetchPlayed.sse.some((e) => e.data?.item?.type === "web_search_call"))
        throw new Error("Fetch must stay a web card, not Ran JSON");
    if (fetchPlayed.sse.some((e) => e.data?.item?.name === "exec_command"))
        throw new Error("Fetch must not become exec_command");
    const lsNdjson = [
        JSON.stringify({
            type: "tool_call",
            subtype: "started",
            call_id: "call-ls-1",
            tool_call: { lsToolCall: { args: { path: "/tmp/cdc-fixture" } } },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
    ].join("\n");
    const lsPlayed = playCursorNdjson(lsNdjson, { responseId: "resp_ls" });
    const lsExec = lsPlayed.sse.find((e) => e.data?.item?.name === "exec_command");
    const lsCmd = JSON.parse(lsExec?.data?.item?.arguments || "{}").cmd || "";
    if (!/^ls /.test(lsCmd) || looksJson(lsCmd))
        throw new Error(`Ls must be a ListFiles exec card, got ${lsCmd}`);
    const todoNdjson = [
        JSON.stringify({
            type: "tool_call",
            subtype: "started",
            call_id: "call-todos-1",
            tool_call: {
                updateTodosToolCall: {
                    args: {
                        todos: [
                            { id: "1", content: "deploy", status: "COMPLETED" },
                            { id: "2", content: "verify", status: "IN_PROGRESS" },
                        ],
                    },
                },
            },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
    ].join("\n");
    const todoPlayed = playCursorNdjson(todoNdjson, { responseId: "resp_todos" });
    if (todoPlayed.sse.some((e) => e.data?.item?.name === "exec_command"))
        throw new Error("UpdateTodos must not become a Ran JSON card");
    const note = todoPlayed.sse.filter((e) => e.event === "response.output_text.delta").map((e) => e.data?.delta || "").join("");
    if (!note.includes("deploy") || !note.includes("verify"))
        throw new Error(`todos should stream as commentary, got ${JSON.stringify(note)}`);
    const junkNdjson = [
        JSON.stringify({
            type: "tool_call",
            subtype: "started",
            call_id: "call-ask-1",
            tool_call: { askQuestionToolCall: { args: { title: "Continue?", questions: [] } } },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
    ].join("\n");
    const junkPlayed = playCursorNdjson(junkNdjson, { responseId: "resp_ask" });
    if (junkPlayed.sse.some((e) => e.data?.item?.name === "exec_command"))
        throw new Error("AskQuestion must not render as $: JSON");
    console.log("ok Fetch/Ls/Todos/AskQuestion are not fake JSON shells");
}

{
    const editNdjson = [
        JSON.stringify({
            type: "tool_call",
            subtype: "started",
            call_id: "call-edit-1",
            tool_call: { editToolCall: { args: { path: "src/app.ts", stream_content: "x" } } },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
    ].join("\n");
    const editPlayed = playCursorNdjson(editNdjson, { responseId: "resp_edit" });
    if (editPlayed.sse.some((e) => e.data?.item?.name === "exec_command"))
        throw new Error("Edit already happened in Cursor; must not become a local Ran card");
    const patch = editPlayed.sse.find((e) => e.data?.item?.name === "apply_patch" && e.event === "response.output_item.done");
    const args = JSON.parse(patch?.data?.item?.arguments || "{}");
    if (!String(args.input || "").includes("src/app.ts") || !String(args.input || "").includes("Begin Patch"))
        throw new Error(`Edit must be apply_patch function_call, got ${JSON.stringify(patch?.data?.item)}`);
    if (editPlayed.sse.filter((e) => e.event === "response.output_text.delta").map((e) => e.data?.delta || "").join("").includes("Edited src/app.ts"))
        throw new Error("Edit must not render as commentary Edited /path");
    const createNdjson = [
        JSON.stringify({
            type: "tool_call",
            subtype: "started",
            call_id: "call-create-goal-1",
            tool_call: {
                mcpToolCall: {
                    args: {
                        server: "cursor",
                        toolName: "CreateGoal",
                        args: { objective: "Map remaining Cursor tools accurately" },
                    },
                },
            },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
    ].join("\n");
    const createPlayed = playCursorNdjson(createNdjson, { responseId: "resp_create_goal" });
    if (createPlayed.sse.some((e) => e.data?.item?.name === "exec_command"))
        throw new Error("CreateGoal must not become a Ran JSON card");
    const createNote = createPlayed.sse.filter((e) => e.event === "response.output_text.delta").map((e) => e.data?.delta || "").join("");
    if (!createNote.includes("Map remaining Cursor tools"))
        throw new Error(`CreateGoal should surface the objective, got ${JSON.stringify(createNote)}`);
    const findNdjson = [
        JSON.stringify({
            type: "tool_call",
            subtype: "started",
            call_id: "call-pifind-1",
            tool_call: { piFindToolCall: { args: { pattern: "*.mjs", path: "test" } } },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "" }),
    ].join("\n");
    const findPlayed = playCursorNdjson(findNdjson, { responseId: "resp_pifind" });
    const findExec = findPlayed.sse.find((e) => e.data?.item?.name === "exec_command");
    const findCmd = JSON.parse(findExec?.data?.item?.arguments || "{}").cmd || "";
    if (!/^find /.test(findCmd) || looksJson(findCmd))
        throw new Error(`PiFind must be a find exec card, got ${findCmd}`);
    console.log("ok Edit/CreateGoal/PiFind mapping");
}

{
    const deltaNdjson = [
        JSON.stringify({
            type: "tool_call",
            subtype: "delta",
            call_id: "call-read-delta",
            tool_call: { readToolCall: { args: { path: "/tmp/partial" } } },
        }),
        JSON.stringify({
            type: "tool_call",
            subtype: "started",
            call_id: "call-read-delta",
            tool_call: { readToolCall: { args: { path: "/tmp/cdc-fixture/hello.txt" } } },
        }),
        JSON.stringify({ type: "result", subtype: "success", result: "hello-from-result-only" }),
    ].join("\n");
    const deltaPlayed = playCursorNdjson(deltaNdjson, { responseId: "resp_tool_delta" });
    const reads = deltaPlayed.inbound.filter((e) => e.type === "tool");
    if (reads.length !== 1)
        throw new Error(`tool_call delta must not emit a second Ran, got ${reads.length}`);
    if (deltaPlayed.text !== "hello-from-result-only")
        throw new Error(`result text must fill missing assistant, got ${JSON.stringify(deltaPlayed.text)}`);
    const errNdjson = [
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "partial" }] } }),
        JSON.stringify({ type: "result", subtype: "error", is_error: true, result: "partial" }),
    ].join("\n");
    const errPlayed = playCursorNdjson(errNdjson, { responseId: "resp_result_error" });
    if (!errPlayed.sse.some((e) => e.event === "response.completed"))
        throw new Error("result error must still complete the Desktop stream");
    if (errPlayed.text !== "partial")
        throw new Error("result error must not duplicate assistant text");
    console.log("ok tool_call delta ignored; result text/error complete");
}

function looksJson(cmd) {
    return /\{/.test(String(cmd || ""));
}
