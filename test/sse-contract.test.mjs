process.env.CURSOR_BRIDGE_TRACE = "0";

import { createResponsesNativeStream, emitCompactContinue, emitCompactReplay, emitFailed, emitInFlightSnapshot, classifyCursorTool, slimCompletedOutput } from "../patches/responses-native.js";
import { assertResponsesTerminal, parseSse } from "../patches/sse-contract.js";
import { extractFinalText, extractThinkingText, extractTurnHistory, beginLiveTurn, bufferEvent, completeLiveTurn, peekLiveTurn, getLiveTurn, promptHash, rewriteResponseId, disconnectedTurnText, markCompletedDelivered, followUpReplayText } from "../patches/thread-replay.js";
import { isDesktopExecFollowUp } from "../patches/tool-types.js";
import { extractCodexThreadId, prepareAgentInvocation } from "../patches/cursor-turn.js";
import { rememberCall, rememberResponse, resetStoreForTest, threadKeyFromFollowUp, putThreadSession, getThreadSession, markThreadPrompt } from "../patches/thread-session.js";
import { createStreamParser } from "../patches/cli-stream-parser.js";

function mockRes() {
    let buf = "";
    return {
        writableEnded: false,
        destroyed: false,
        write(chunk) {
            buf += chunk;
            return true;
        },
        end() {
            this.writableEnded = true;
        },
        dump() {
            return buf;
        },
    };
}

function collectWrite(res) {
    return (type, data) => {
        res.write(`event: ${type}\n`);
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };
}

{
    const res = mockRes();
    const id = "resp_test1";
    emitCompactReplay({
        res,
        writeEvent: collectWrite(res),
        responseId: id,
        body: {},
        displayModel: "gemini-3.8-flash-high",
        createdAt: 1,
        text: "hello from compact",
    });
    const events = parseSse(res.dump());
    const kind = assertResponsesTerminal(events, id);
    if (kind !== "response.completed")
        throw new Error(kind);
    const completed = events.find((e) => e.event === "response.completed");
    if (completed.data.response.output_text !== "hello from compact")
        throw new Error("missing text");
    console.log("ok compact matching id");
}

{
    const res = mockRes();
    const id = "resp_fail";
    collectWrite(res)("response.created", {
        response: { id, object: "response", status: "in_progress", output: [] },
    });
    emitFailed({
        writeEvent: collectWrite(res),
        responseId: id,
        createdAt: 1,
        displayModel: "m",
        message: "boom",
    });
    res.write("data: [DONE]\n\n");
    const events = parseSse(res.dump());
    const kind = assertResponsesTerminal(events, id);
    if (kind !== "response.failed")
        throw new Error(kind);
    console.log("ok failed after created is terminal");
}

{
    const res = mockRes();
    const id = "resp_live";
    const native = createResponsesNativeStream({
        res,
        writeEvent: collectWrite(res),
        responseId: id,
        body: {},
        displayModel: "m",
        createdAt: 1,
        promptTokens: 1,
    });
    collectWrite(res)("response.created", {
        response: { id, object: "response", status: "in_progress", output: [] },
    });
    native.onText("partial");
    native.finish();
    native.onText("after complete must be ignored");
    native.onThinking("nope");
    const events = parseSse(res.dump());
    assertResponsesTerminal(events, id);
    console.log("ok no events after completed");
}

{
    const comment = ": keepalive 1\n\n";
    let threw = false;
    try {
        parseSse(comment + "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"x\"}}\n\n");
    }
    catch (e) {
        threw = /sse comment/.test(String(e));
    }
    if (!threw)
        throw new Error("comments must be rejected");
    console.log("ok comments rejected");
}

{
    const res = mockRes();
    const oldId = "resp_old";
    const newId = "resp_new";
    emitCompactReplay({
        res,
        writeEvent: collectWrite(res),
        responseId: oldId,
        body: {},
        displayModel: "m",
        createdAt: 1,
        text: "old",
    });
    const leaked = parseSse(res.dump());
    let threw = false;
    try {
        assertResponsesTerminal(leaked, newId);
    }
    catch {
        threw = true;
    }
    if (!threw)
        throw new Error("old id must not satisfy new request");
    console.log("ok wrong id fails contract");
}

{
    const h = promptHash("user");
    beginLiveTurn("thread:demo", h);
    bufferEvent("thread:demo", "response.output_text.delta", { delta: "abc" });
    bufferEvent("thread:demo", "response.completed", { response: { output_text: "abc" } });
    completeLiveTurn("thread:demo");
    if (extractFinalText({ events: [
        { type: "response.output_text.delta", data: { delta: "abc" } },
        { type: "response.completed", data: { response: { output_text: "abc" } } },
    ] }) !== "abc")
        throw new Error("extract");
    console.log("ok extractFinalText");
}

{
    const empty = extractFinalText({ events: [] });
    if (empty)
        throw new Error("empty replay text must be falsy");
    console.log("ok empty extract is not replayable");
}

{
    const rewritten = rewriteResponseId(
        { response: { id: "resp_old", output_text: "hi" }, response_id: "resp_old" },
        "resp_old",
        "resp_new",
    );
    if (rewritten.response.id !== "resp_new" || rewritten.response_id !== "resp_new")
        throw new Error("rewriteResponseId");
    if (rewritten.response.output_text !== "hi")
        throw new Error("rewrite clobbered text");
    const nested = rewriteResponseId(
        { response: { id: "resp_old", output_text: "mentions resp_old inside" }, response_id: "resp_old" },
        "resp_old",
        "resp_new",
    );
    if (nested.response.output_text !== "mentions resp_old inside")
        throw new Error("rewrite must not touch text");
    console.log("ok rewriteResponseId");
}

{
    const h = promptHash("дальше");
    const rec = beginLiveTurn("thread:reattach", h, { responseId: "resp_live" });
    rec.startedAt = Date.now() - (11 * 60 * 1000);
    if (!peekLiveTurn("thread:reattach"))
        throw new Error("in-flight turn must peek past 10min");
    if (!getLiveTurn("thread:reattach", h))
        throw new Error("in-flight turn must getLiveTurn past 10min");
    completeLiveTurn("thread:reattach");
    if (peekLiveTurn("thread:reattach"))
        throw new Error("completed turn must not peek");
    if (getLiveTurn("thread:reattach", h))
        throw new Error("completed turn older than 10min must expire");
    console.log("ok in-flight live turn survives dup window");
}

{
    const res = mockRes();
    const id = "resp_snap";
    emitCompactReplay({
        res,
        writeEvent: collectWrite(res),
        responseId: id,
        body: {},
        displayModel: "m",
        createdAt: 1,
        thinking: "plan",
        text: "I'm currently focusing on the latter stages",
    });
    const events = parseSse(res.dump());
    if (assertResponsesTerminal(events, id) !== "response.completed")
        throw new Error("snapshot must terminal");
    const textDelta = events.filter((e) => e.event === "response.output_text.delta").map((e) => e.data?.delta).join("");
    if (!textDelta.includes("latter stages"))
        throw new Error("snapshot missing assistant text");
    console.log("ok compact snapshot has visible text and terminal");
}

{
    const res = mockRes();
    const id = "resp_hang";
    emitInFlightSnapshot({
        res,
        writeEvent: collectWrite(res),
        responseId: id,
        body: {},
        displayModel: "m",
        createdAt: 1,
        thinking: "plan while tools run",
    });
    const events = parseSse(res.dump());
    if (!events.find((e) => e.event === "response.created"))
        throw new Error("in-flight snapshot missing created");
    if (!events.find((e) => e.data?.item?.type === "reasoning" || (e.event === "response.reasoning_summary_text.delta" && e.data?.delta?.includes("plan while tools run"))))
        throw new Error("in-flight snapshot missing thinking");
    if (events.some((e) => e.event === "response.completed" || e.event === "response.failed" || e.event === "done"))
        throw new Error("in-flight snapshot must not terminal");
    if (res.writableEnded)
        throw new Error("in-flight snapshot must keep the socket open");
    console.log("ok in-flight snapshot hangs without completed");
}

{
    const res = mockRes();
    const id = "resp_keepopen";
    const native = emitInFlightSnapshot({
        res,
        writeEvent: collectWrite(res),
        responseId: id,
        body: {},
        displayModel: "m",
        createdAt: 1,
        thinking: "My analysis is now focused on evaluating the session's freshness.",
        keepOpen: true,
    });
    const openEvents = parseSse(res.dump());
    if (!openEvents.find((e) => e.event === "response.created"))
        throw new Error("keepOpen snapshot missing created");
    if (!openEvents.find((e) => e.event === "response.reasoning_summary_text.delta"))
        throw new Error("keepOpen snapshot must stream thinking");
    if (openEvents.some((e) => e.event === "response.output_item.done" && e.data?.item?.type === "reasoning"))
        throw new Error("keepOpen snapshot must not close Thought");
    if (openEvents.some((e) => e.event === "response.completed" || e.event === "response.failed"))
        throw new Error("keepOpen snapshot must not terminal");
    native.onText("done after reattach");
    native.finish();
    const events = parseSse(res.dump());
    if (assertResponsesTerminal(events, id) !== "response.completed")
        throw new Error("keepOpen finish must be a Mixin terminal with [DONE]");
    console.log("ok keepOpen snapshot leaves Thought in progress");
}

{
    const res = mockRes();
    const id = "resp_recovered";
    const native = emitInFlightSnapshot({
        res,
        writeEvent: collectWrite(res),
        responseId: id,
        body: {},
        displayModel: "m",
        createdAt: 1,
        thinking: "still running tools",
        keepOpen: true,
    });
    native.onText("goal report that landed while Desktop was reconnecting");
    native.finish();
    const events = parseSse(res.dump());
    if (assertResponsesTerminal(events, id) !== "response.completed")
        throw new Error("recovered reattach must terminal");
    const completed = events.find((e) => e.event === "response.completed");
    if (!String(completed?.data?.response?.output_text || "").includes("goal report that landed"))
        throw new Error("reattach must ship the answer accumulated before disconnect");
    console.log("ok reattach seeds pre-disconnect assistant text");
}

{
    beginLiveTurn("thread:think", promptHash("x"));
    bufferEvent("thread:think", "response.reasoning_summary_text.delta", { delta: "abc" });
    bufferEvent("thread:think", "response.output_text.delta", { delta: "xyz" });
    if (extractThinkingText(getLiveTurn("thread:think", promptHash("x"))) !== "abc")
        throw new Error("thinking extract");
    console.log("ok extractThinkingText");
}

{
    const res = mockRes();
    const native = createResponsesNativeStream({
        res,
        writeEvent: collectWrite(res),
        responseId: "resp_hist",
        body: {},
        displayModel: "m",
        createdAt: 1,
        promptTokens: 1,
    });
    native.onThinking("first thought");
    native.onTool({ phase: "started", name: "shell", args: { command: "ls" }, callId: "c1" });
    native.onThinking("second thought");
    const events = parseSse(res.dump());
    const reasoningAdded = events.filter((e) => e.event === "response.output_item.added" && e.data?.item?.type === "reasoning");
    if (reasoningAdded.length !== 2)
        throw new Error(`expected two native reasoning items, got ${reasoningAdded.length}`);
    if (!events.some((e) => e.event === "response.reasoning_summary_text.delta" && e.data?.delta === "first thought"))
        throw new Error("first thought must stream as reasoning_summary_text.delta");
    if (!events.some((e) => e.event === "response.reasoning_summary_text.delta" && e.data?.delta === "second thought"))
        throw new Error("second thought must stream as reasoning_summary_text.delta");
    const commentaryAdded = events.filter((e) => e.event === "response.output_item.added" && e.data?.item?.phase === "commentary");
    if (commentaryAdded.length !== 2)
        throw new Error(`expected two visible commentary items between tools, got ${commentaryAdded.length}`);
    if (!events.some((e) => e.event === "response.output_text.delta" && e.data?.delta === "first thought"))
        throw new Error("first thought must also stream as visible commentary");
    if (!events.some((e) => e.event === "response.output_text.delta" && e.data?.delta === "second thought"))
        throw new Error("second thought must also stream as visible commentary");
    if (!events.some((e) => e.data?.item?.type === "function_call" && e.data.item.name === "exec_command" && String(e.data.item.arguments || "").includes("ls")))
        throw new Error("shell must surface as exec_command, not web search");
    if (events.some((e) => e.data?.item?.type === "web_search_call"))
        throw new Error("shell must not be faked as web_search_call");
    if (events.some((e) => e.data?.item?.type === "local_shell_call"))
        throw new Error("shell must not use local_shell_call; Desktop has no widget for it");
    if (/\{"pattern"/.test(JSON.stringify(events)))
        throw new Error("tool args must not dump JSON into the transcript");
    if (events.some((e) => e.data?.item?.type === "custom_tool_call"))
        throw new Error("command tools must not use custom_tool_call");
    const firstDone = events.find((e) => e.event === "response.output_item.done" && e.data?.item?.type === "reasoning");
    if (firstDone?.data?.item?.summary?.[0]?.type !== "summary_text" || firstDone.data.item.summary[0].text !== "first thought")
        throw new Error("closed reasoning item must carry summary_text");
    if (!events.some((e) => e.event === "response.reasoning_summary_part.added" && e.data?.summary_index === 0))
        throw new Error("Codex parser requires reasoning_summary_part.added with summary_index");
    if (events.some((e) => /shell_command running/.test(JSON.stringify(e.data))))
        throw new Error("tool stub must not pollute commentary");
    console.log("ok native reasoning items plus exec_command");
}

{
    beginLiveTurn("thread:hist", promptHash("h"));
    bufferEvent("thread:hist", "response.reasoning_summary_text.delta", { delta: "plan A" });
    bufferEvent("thread:hist", "response.output_item.done", {
        item: { type: "reasoning", summary: [{ type: "summary_text", text: "plan A" }] },
    });
    bufferEvent("thread:hist", "response.output_item.added", {
        item: { type: "custom_tool_call", name: "shell", input: "ls", call_id: "c1" },
    });
    bufferEvent("thread:hist", "response.output_item.added", {
        item: { type: "custom_tool_call_output", call_id: "c1", output: "ok" },
    });
    bufferEvent("thread:hist", "response.reasoning_summary_text.delta", { delta: "plan B" });
    const steps = extractTurnHistory(getLiveTurn("thread:hist", promptHash("h")));
    if (steps.map((s) => s.kind).join(",") !== "thought,tool,thought")
        throw new Error(`history steps ${steps.map((s) => s.kind).join(",")}`);
    if (steps[1].input !== "ls" || steps[1].output !== "ok")
        throw new Error("tool history");
    const res = mockRes();
    emitInFlightSnapshot({
        res,
        writeEvent: collectWrite(res),
        responseId: "resp_steps",
        body: {},
        displayModel: "m",
        createdAt: 1,
        history: steps,
    });
    const events = parseSse(res.dump());
    if (events.filter((e) => e.data?.item?.type === "reasoning").length < 2)
        throw new Error("snapshot must replay multiple native reasoning items");
    if (events.some((e) => e.data?.item?.type === "function_call" || e.data?.item?.type === "local_shell_call"))
        throw new Error("snapshot must not replay tools as executable items");
    if (events.some((e) => e.data?.item?.type === "web_search_call"))
        throw new Error("replayed shell must not become web search");
    if (events.some((e) => e.event === "response.completed"))
        throw new Error("history snapshot must not complete");
    console.log("ok turn history snapshot");
}

{
    beginLiveTurn("thread:phase", promptHash("p"));
    bufferEvent("thread:phase", "response.output_item.added", {
        item: { id: "msg_c", type: "message", phase: "commentary", role: "assistant" },
    });
    bufferEvent("thread:phase", "response.output_text.delta", { item_id: "msg_c", delta: "thinking list item" });
    bufferEvent("thread:phase", "response.output_item.added", {
        item: { id: "msg_f", type: "message", phase: "final_answer", role: "assistant" },
    });
    bufferEvent("thread:phase", "response.output_text.delta", { item_id: "msg_f", delta: "final only" });
    const rec = getLiveTurn("thread:phase", promptHash("p"));
    if (extractFinalText(rec) !== "final only")
        throw new Error(`commentary leaked into final: ${extractFinalText(rec)}`);
    if (!extractThinkingText(rec).includes("thinking list item"))
        throw new Error("commentary must count as thinking history");
    console.log("ok commentary skipped in final text");
}

{
    const res = mockRes();
    const native = createResponsesNativeStream({
        res,
        writeEvent: collectWrite(res),
        responseId: "resp_grep",
        body: {},
        displayModel: "m",
        createdAt: 1,
        promptTokens: 1,
    });
    native.onTool({
        phase: "started",
        name: "Grep",
        args: { pattern: "POSTGRES_ROLLOUT_SOAK_SECONDS", path: "ops/deploy" },
        callId: "g1",
    });
    const events = parseSse(res.dump());
    const exec = events.find((e) => e.event === "response.output_item.done" && e.data?.item?.type === "function_call");
    if (exec?.data?.item?.name !== "exec_command")
        throw new Error("grep must become exec_command");
    if (!String(exec.data.item.arguments || "").includes("POSTGRES_ROLLOUT_SOAK_SECONDS"))
        throw new Error("grep must become exec_command with rg");
    if (events.some((e) => e.data?.item?.type === "web_search_call"))
        throw new Error("grep must not be faked as web_search_call");
    if (events.some((e) => e.data?.item?.type === "local_shell_call"))
        throw new Error("grep must not use local_shell_call");
    if (events.some((e) => e.data?.item?.phase === "commentary"))
        throw new Error("grep must not dump JSON commentary");
    console.log("ok grep is exec_command not web search");
}

{
    const res = mockRes();
    const native = createResponsesNativeStream({
        res,
        writeEvent: collectWrite(res),
        responseId: "resp_web",
        body: {},
        displayModel: "m",
        createdAt: 1,
        promptTokens: 1,
    });
    native.onTool({
        phase: "started",
        name: "WebSearch",
        args: { search_term: "openai responses local_shell_call" },
        callId: "w1",
    });
    const events = parseSse(res.dump());
    const search = events.find((e) => e.data?.item?.type === "web_search_call");
    if (!search?.data?.item?.action?.query?.includes("openai responses local_shell_call"))
        throw new Error("WebSearch must remain web_search_call");
    if (events.some((e) => e.data?.item?.type === "local_shell_call"))
        throw new Error("WebSearch must not become local_shell_call");
    if (events.some((e) => e.data?.item?.type === "function_call"))
        throw new Error("WebSearch must not become exec_command");
    console.log("ok real WebSearch stays web_search_call");
}

{
    const res = mockRes();
    const native = createResponsesNativeStream({
        res,
        writeEvent: collectWrite(res),
        responseId: "resp_read",
        body: {},
        displayModel: "m",
        createdAt: 1,
        promptTokens: 1,
    });
    native.onTool({
        phase: "started",
        name: "Read",
        args: { path: "src/app.ts", offset: 1, limit: 80 },
        callId: "r1",
    });
    const events = parseSse(res.dump());
    const exec = events.find((e) => e.event === "response.output_item.done" && e.data?.item?.type === "function_call");
    const args = JSON.parse(exec?.data?.item?.arguments || "{}");
    if (exec?.data?.item?.name !== "exec_command")
        throw new Error("Read must become exec_command");
    if (!/^sed -n /.test(args.cmd || "") || !args.cmd.includes("src/app.ts"))
        throw new Error(`Read must be sed/cat for native Read card, got ${args.cmd}`);
    if (String(args.cmd).startsWith(": "))
        throw new Error("Read must not be wrapped as a no-op");
    console.log("ok Read is exec_command sed/cat");
}

{
    const res = mockRes();
    const native = createResponsesNativeStream({
        res,
        writeEvent: collectWrite(res),
        responseId: "resp_ssh",
        body: {},
        displayModel: "m",
        createdAt: 1,
        promptTokens: 1,
    });
    native.onTool({
        phase: "started",
        name: "Shell",
        args: { command: "ssh -o ConnectTimeout=10 codex-workers-eu-01 cat /etc/os-release" },
        callId: "s1",
    });
    const events = parseSse(res.dump());
    const exec = events.find((e) => e.event === "response.output_item.done" && e.data?.item?.type === "function_call");
    const args = JSON.parse(exec?.data?.item?.arguments || "{}");
    if (exec?.data?.item?.name !== "exec_command")
        throw new Error("ssh must become exec_command");
    if (!String(args.cmd).startsWith(": ") || !String(args.cmd).includes("ssh -o ConnectTimeout=10"))
        throw new Error(`ssh must show in a no-op Ran card, got ${args.cmd}`);
    if (events.some((e) => e.data?.item?.type === "web_search_call" || e.data?.item?.type === "local_shell_call"))
        throw new Error("ssh must use unified exec_command only");
    console.log("ok ssh is display-only exec_command");
}

{
    const classified = classifyCursorTool("Edit", {
        path: "/Users/belief/dev/projects/review-router/packages/features/review-config/src/domain/review-configuration.ts",
        old_string: "a",
        new_string: "b",
    });
    if (classified.kind !== "patch" || classified.op !== "update_file")
        throw new Error(`Edit must classify as apply_patch, got ${JSON.stringify(classified)}`);
    const res = mockRes();
    const native = createResponsesNativeStream({
        res,
        writeEvent: collectWrite(res),
        responseId: "resp_edit_native",
        body: {},
        displayModel: "m",
        createdAt: 1,
        promptTokens: 1,
    });
    native.onTool({
        name: "Edit",
        callId: "call-edit-native",
        args: {
            path: classified.path,
            old_string: "a",
            new_string: "b",
        },
    });
    const events = parseSse(res.dump());
    const call = events.find((e) => e.data?.item?.name === "apply_patch" && e.event === "response.output_item.done");
    const args = JSON.parse(call?.data?.item?.arguments || "{}");
    if (!String(args.input || "").includes("review-configuration.ts") || !String(args.input || "").includes("Begin Patch"))
        throw new Error("native Edit card missing apply_patch envelope");
    if (events.some((e) => String(e.data?.delta || "").startsWith("Edited ")))
        throw new Error("native Edit must not be commentary");
    if (events.some((e) => e.data?.item?.type === "apply_patch_call"))
        throw new Error("Mixin cannot decode apply_patch_call; use function_call apply_patch");
    console.log("ok Edit is apply_patch not Edited /path commentary");
}

{
    const slim = slimCompletedOutput(Array.from({ length: 80 }, (_, i) => ({
        type: "function_call",
        name: "exec_command",
        call_id: `c${i}`,
        arguments: "{}",
    })).concat([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }]));
    if (slim.filter((i) => i.name === "exec_command").length !== 24)
        throw new Error(`completed must keep a short tool tail, got ${slim.length}`);
    if (!slim.some((i) => i.type === "message"))
        throw new Error("completed must keep the assistant message");
    console.log("ok completed output slims so Mixin can decode it");
}

{
    if (!isDesktopExecFollowUp({
        input: [{ type: "function_call_output", call_id: "c1", output: "ok" }],
    }, [{ callId: "c1", output: "ok" }]))
        throw new Error("outputs-only request is a Desktop exec follow-up");
    if (isDesktopExecFollowUp({
        input: [
            { type: "function_call_output", call_id: "c1", output: "ok" },
            { type: "message", role: "user", content: [{ type: "input_text", text: "дальше" }] },
        ],
    }, [{ callId: "c1", output: "ok" }]))
        throw new Error("new user text after outputs is not a follow-up");
    if (isDesktopExecFollowUp({ input: [{ role: "user", content: "hi" }] }, []))
        throw new Error("no outputs is not a follow-up");
    console.log("ok Desktop exec follow-up detection");
}

{
    const key = "thread:019fc3aa-overflow";
    beginLiveTurn(key, "hash-overflow", { responseId: "resp_overflow" });
    for (let i = 0; i < 8500; i++) {
        bufferEvent(key, "response.output_item.done", {
            item: { type: "function_call", name: "exec_command", call_id: `c${i}` },
        });
    }
    bufferEvent(key, "response.output_item.added", {
        item: { id: "msg_final", type: "message", role: "assistant", phase: "final_answer" },
    });
    bufferEvent(key, "response.output_text.delta", {
        item_id: "msg_final",
        delta: "goal report after 8000 tool events",
    });
    completeLiveTurn(key);
    const rec = getLiveTurn(key, "hash-overflow");
    if (!extractFinalText(rec).includes("goal report after 8000 tool events"))
        throw new Error("answer after 8000 SSE events must still be kept for Desktop reconnect");
    if (disconnectedTurnText(key) !== "goal report after 8000 tool events")
        throw new Error("disconnect follow-up must replay the answer that never reached Desktop");
    markCompletedDelivered(key);
    if (disconnectedTurnText(key))
        throw new Error("already-delivered turn must not replay via disconnectedTurnText");
    if (followUpReplayText(key, "stale previous essay") !== "goal report after 8000 tool events")
        throw new Error("exec-followup must prefer this turn's text over a previous prompt's lastOutputText");
    rec.startedAt = Date.now() - (25 * 60 * 1000);
    if (followUpReplayText(key, "stale previous essay") !== "goal report after 8000 tool events")
        throw new Error("turns longer than 10min must still keep their answer for Desktop reconnect");
    if (followUpReplayText("thread:gone", "Source-title карточка больше не валит board.") !== "Source-title карточка больше не валит board.")
        throw new Error("with no live rec, exec-followup uses saved lastOutputText");
    console.log("ok overflow buffer keeps final text for disconnect replay");
}

{
    const res = mockRes();
    const id = "resp_disconnect_replay";
    emitCompactReplay({
        res,
        writeEvent: collectWrite(res),
        responseId: id,
        body: {},
        displayModel: "m",
        createdAt: 1,
        text: "goal report after 8000 tool events",
    });
    const events = parseSse(res.dump());
    if (assertResponsesTerminal(events, id) !== "response.completed")
        throw new Error("disconnect compact must terminal");
    const completed = events.find((e) => e.event === "response.completed");
    if (completed?.data?.response?.output_text !== "goal report after 8000 tool events")
        throw new Error("exec-followup after drop must replay the Cursor answer, not a space");
    console.log("ok disconnect compact replay ships the missed answer");
}

{
    const res = mockRes();
    const id = "resp_silent_followup";
    emitCompactReplay({
        res,
        writeEvent: collectWrite(res),
        responseId: id,
        body: {},
        displayModel: "m",
        createdAt: 1,
        text: "",
    });
    const events = parseSse(res.dump());
    if (assertResponsesTerminal(events, id) !== "response.completed")
        throw new Error("empty follow-up must still terminal");
    const deltas = events.filter((e) => e.event === "response.output_text.delta").map((e) => e.data?.delta).join("");
    if (deltas.trim())
        throw new Error("empty follow-up must not paint a space bubble");
    console.log("ok empty exec-followup has no visible assistant text");
}

{
    const key = "thread:019fc3aa-whitespace-wipe";
    beginLiveTurn(key, "hash-wipe", { responseId: "resp_wipe" });
    bufferEvent(key, "response.output_item.added", {
        item: { id: "msg_final", type: "message", role: "assistant", phase: "final_answer" },
    });
    bufferEvent(key, "response.output_text.delta", {
        item_id: "msg_final",
        delta: "I'll keep the ranking filter off overnight.",
    });
    bufferEvent(key, "response.completed", { response: { output_text: "\n" } });
    completeLiveTurn(key);
    if (extractFinalText(getLiveTurn(key, "hash-wipe")) !== "I'll keep the ranking filter off overnight.")
        throw new Error("whitespace completed must not wipe the reattached answer");
    if (followUpReplayText(key, "") !== "I'll keep the ranking filter off overnight.")
        throw new Error("exec-followup must replay the wiped-looking turn");
    console.log("ok whitespace completed does not wipe final text");
}

{
    const key = "thread:019fc3aa-thinking-fallback";
    beginLiveTurn(key, "hash-think", { responseId: "resp_think" });
    bufferEvent(key, "response.reasoning_summary_text.delta", {
        delta: "Continue the social-monitor ranking pass without the 6h stale cutoff.",
    });
    bufferEvent(key, "response.completed", { response: { output_text: "\n" } });
    completeLiveTurn(key);
    if (followUpReplayText(key, "") !== "Continue the social-monitor ranking pass without the 6h stale cutoff.")
        throw new Error("empty final text must fall back to thinking so Desktop is not a fake complete");
    process.env.CURSOR_BRIDGE_THREAD_SESSIONS = `/tmp/cdc-replay-${process.pid}.json`;
    resetStoreForTest();
    rememberCall(key, "call_think_1");
    const res = mockRes();
    emitCompactReplay({
        res,
        writeEvent: collectWrite(res),
        responseId: "resp_think_replay",
        body: { input: [{ type: "function_call_output", call_id: "call_think_1", output: "ok" }] },
        displayModel: "m",
        createdAt: 1,
        text: "",
    });
    const events = parseSse(res.dump());
    const completed = events.find((e) => e.event === "response.completed");
    if (!String(completed?.data?.response?.output_text || "").includes("social-monitor ranking pass"))
        throw new Error("empty compact replay must recover thinking via call_id");
    console.log("ok empty compact recovers thinking from live turn");
}

{
    let got = "";
    const parse = createStreamParser((t) => { got += t; }, () => {}, () => {}, () => {});
    parse(JSON.stringify({ type: "result", subtype: "success", result: { text: "patched ranking without the 6h filter" } }));
    if (!got.includes("patched ranking without the 6h filter"))
        throw new Error("object result.text must become assistant output");
    console.log("ok result object text is not dropped");
}

{
    const nativeRes = mockRes();
    const native = createResponsesNativeStream({
        res: nativeRes,
        writeEvent: collectWrite(nativeRes),
        responseId: "resp_nodelta",
        body: {},
        displayModel: "m",
        createdAt: 1,
        promptTokens: 1,
    });
    native.onTool({ name: "Shell", args: { command: "pwd" }, callId: "c-nodelta" });
    const events = parseSse(nativeRes.dump());
    if (events.some((e) => String(e.event || "").includes("function_call_arguments")))
        throw new Error("exec_command must not emit function_call_arguments.delta");
    console.log("ok no function_call_arguments events");
}

{
    process.env.CURSOR_BRIDGE_THREAD_SESSIONS = `/tmp/cdc-sessions-${process.pid}.json`;
    resetStoreForTest();
    rememberResponse("thread:01a0719d-424f-7801-8acf-be9add1e0114", "resp_prev1");
    rememberCall("thread:019fc3aa-bd72-7ea1-b807-4b9c18ec48bf", "call_abc");
    if (threadKeyFromFollowUp({ previous_response_id: "resp_prev1" }, []) !== "thread:01a0719d-424f-7801-8acf-be9add1e0114")
        throw new Error("follow-up must resolve thread from previous_response_id");
    if (threadKeyFromFollowUp({}, [{ callId: "call_abc", output: "ok" }]) !== "thread:019fc3aa-bd72-7ea1-b807-4b9c18ec48bf")
        throw new Error("follow-up must resolve thread from call_id");
    const fromInput = extractCodexThreadId({}, {
        input: [{
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "see codex://threads/01a0719d-424f-7801-8acf-be9add1e0114" }],
        }],
    }, "");
    if (fromInput !== "01a0719d-424f-7801-8acf-be9add1e0114")
        throw new Error(`thread id from input, got ${fromInput}`);
    const rec = beginLiveTurn("thread:01a0719d-424f-7801-8acf-be9add1e0114", "hash-old", { responseId: "resp_live" });
    if (!peekLiveTurn("thread:01a0719d-424f-7801-8acf-be9add1e0114")?.primaryId)
        throw new Error("live turn must be peekable without matching hash");
    if (rec.hash === "hash-new")
        throw new Error("sanity");
    completeLiveTurn("thread:01a0719d-424f-7801-8acf-be9add1e0114");
    console.log("ok follow-up thread map and live peek without hash");
}

{
    process.env.CURSOR_BRIDGE_THREAD_SESSIONS = `/tmp/cdc-sessions-stale-${process.pid}.json`;
    resetStoreForTest();
    putThreadSession("thread:019fc3aa-bd72-7ea1-b807-4b9c18ec48bf", {
        chatId: "ef3284a8-c62a-40e0-b7d0-5f4bbde3c1db",
        model: "gemini-3.8-flash-high",
        mode: "agent",
        workspace: "/tmp",
        ready: true,
        lastPromptHash: "old-hash",
        lastOutputText: "### 1. По поводу дней до 12 сентября — мы их уже сделали?",
    });
    markThreadPrompt("thread:019fc3aa-bd72-7ea1-b807-4b9c18ec48bf", "дальше");
    const rec = getThreadSession("thread:019fc3aa-bd72-7ea1-b807-4b9c18ec48bf");
    if (rec.lastOutputText)
        throw new Error("дальше must not compact-replay the previous assistant essay");
    if (!rec.lastPromptHash || rec.lastPromptHash === "old-hash")
        throw new Error("new prompt must update lastPromptHash");
    putThreadSession("thread:019fc3aa-bd72-7ea1-b807-4b9c18ec48bf", {
        ...rec,
        lastOutputText: "same continue should still drop",
    });
    markThreadPrompt("thread:019fc3aa-bd72-7ea1-b807-4b9c18ec48bf", "дальше");
    if (getThreadSession("thread:019fc3aa-bd72-7ea1-b807-4b9c18ec48bf").lastOutputText)
        throw new Error("identical continue prompt is still a new Desktop send");
    console.log("ok stale lastOutputText dropped on new prompt");
}

{
    process.env.CURSOR_BRIDGE_THREAD_SESSIONS = `/tmp/cdc-sessions-model-${process.pid}.json`;
    resetStoreForTest();
    const thread = "01a0719d-424f-7801-8acf-be9add1e0114";
    const chatId = "9bed9a12-8ac5-4a4b-82ed-9ec9aba1baf9";
    putThreadSession(`thread:${thread}`, {
        chatId,
        model: "gemini-3.8-flash-high",
        mode: "agent",
        workspace: "/Users/belief/dev/projects/review-router",
        ready: true,
    });
    const switched = prepareAgentInvocation({
        headers: { "x-codex-thread-id": thread },
        body: { model: "cursor-grok-4.6-xhigh" },
        messages: [{ role: "user", content: "switch to grok and keep going on the overlay mapping" }],
        fullPrompt: "User: switch to grok and keep going on the overlay mapping",
        model: "cursor-grok-4.6-xhigh",
        mode: "agent",
        workspaceDir: "/Users/belief/dev/projects/review-router",
    }, { silent: true });
    if (!switched.resumed || switched.resumeChatId !== chatId)
        throw new Error(`model switch must --resume ${chatId}, got resumed=${switched.resumed} chat=${switched.resumeChatId}`);
    if (switched.agentPrompt !== "switch to grok and keep going on the overlay mapping")
        throw new Error("model switch must send last-user only, not a 3MB seed");
    const otherWs = prepareAgentInvocation({
        headers: { "x-codex-thread-id": thread },
        body: { model: "cursor-grok-4.6-xhigh" },
        messages: [{ role: "user", content: "now in another folder" }],
        fullPrompt: "User: now in another folder",
        model: "cursor-grok-4.6-xhigh",
        mode: "agent",
        workspaceDir: "/tmp/other-workspace",
    }, { silent: true });
    if (otherWs.resumed)
        throw new Error("different workspace must still seed a new Cursor chat");
    console.log("ok Desktop model switch resumes the same Cursor chat");
}

{
    process.env.CURSOR_BRIDGE_THREAD_SESSIONS = `/tmp/cdc-sessions-remount-${process.pid}.json`;
    resetStoreForTest();
    putThreadSession("thread:01a0719d-424f-7801-8acf-be9add1e0114", {
        chatId: "366794b3-33bc-47b9-a701-334dd6a10c6a",
        model: "cursor-grok-4.6-xhigh",
        mode: "agent",
        workspace: "/Users/belief/dev/projects/review-router",
        ready: true,
    });
    const { writeFileSync } = await import("node:fs");
    const path = process.env.CURSOR_BRIDGE_THREAD_SESSIONS;
    const store = JSON.parse((await import("node:fs")).readFileSync(path, "utf8"));
    store["thread:01a0719d-424f-7801-8acf-be9add1e0114"].chatId = "9bed9a12-8ac5-4a4b-82ed-9ec9aba1baf9";
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`);
    const remounted = getThreadSession("thread:01a0719d-424f-7801-8acf-be9add1e0114");
    if (remounted.chatId !== "9bed9a12-8ac5-4a4b-82ed-9ec9aba1baf9")
        throw new Error(`external remount must reload from disk, got ${remounted.chatId}`);
    console.log("ok thread-session remount from disk");
}

{
    process.env.CURSOR_BRIDGE_THREAD_SESSIONS = `/tmp/cdc-sessions-history-${process.pid}.json`;
    process.env.CURSOR_BRIDGE_HISTORY_DIR = `/tmp/cdc-history-${process.pid}`;
    resetStoreForTest();
    const { toConversationHistory, splitHistoryAndLastUser, writeConversationHistoryFile } = await import("../patches/conversation-history.js");
    const { buildAgentFixedArgs } = await import("../patches/agent-cmd-args.js");
    const messages = [
        { role: "user", content: "old long thread about ranking e2e" },
        { role: "assistant", content: "we already shipped soak" },
        { role: "user", content: "switch to cursor and keep the overlay mapping" },
    ];
    const last = "switch to cursor and keep the overlay mapping";
    const { prior, prompt } = splitHistoryAndLastUser(messages, last);
    if (prompt !== last || prior.length !== 2)
        throw new Error(`split last-user, prior=${prior.length}`);
    const hist = toConversationHistory(prior);
    if (hist.messages[0].user.content[0].text.text !== "old long thread about ranking e2e")
        throw new Error("history json must be ConversationHistory user text");
    if (hist.messages[1].assistant.content[0].text.text !== "we already shipped soak")
        throw new Error("history json must be ConversationHistory assistant text");
    const file = writeConversationHistoryFile("thread:01a0719d-424f-7801-8acf-be9add1e0114", prior);
    const seeded = prepareAgentInvocation({
        headers: { "x-codex-thread-id": "01a0719d-424f-7801-8acf-be9add1e0114" },
        body: { model: "cursor-grok-4.6-xhigh" },
        messages,
        fullPrompt: `User: old long thread about ranking e2e\n\nAssistant: we already shipped soak\n\nUser: ${last}`,
        model: "cursor-grok-4.6-xhigh",
        mode: "agent",
        workspaceDir: "/Users/belief/dev/projects/review-router",
    }, { silent: true });
    if (seeded.resumed)
        throw new Error("first Cursor turn of a Codex thread must seed, not resume");
    if (seeded.agentPrompt !== last)
        throw new Error(`seed prompt must be last user, not the 3MB dump, got ${seeded.agentPrompt.length} bytes`);
    if (seeded.historyMessages.length !== 2)
        throw new Error("seed must keep prior Desktop turns for --conversation-history-file");
    const args = buildAgentFixedArgs({ force: true }, "/tmp", "auto", true, "agent", false, undefined, file);
    if (!args.includes("--conversation-history-file") || !args.includes(file))
        throw new Error("seed must pass cursor-agent --conversation-history-file");
    const resumedArgs = buildAgentFixedArgs({ force: true }, "/tmp", "auto", true, "agent", false, "9bed9a12-8ac5-4a4b-82ed-9ec9aba1baf9", file);
    if (resumedArgs.includes("--conversation-history-file"))
        throw new Error("resume must not re-import history; Cursor chat already has it");
    console.log("ok Codex transcript seeds via --conversation-history-file");
}

{
    beginLiveTurn("thread:dual", promptHash("d"));
    bufferEvent("thread:dual", "response.output_item.added", {
        item: { id: "msg_c", type: "message", phase: "commentary", role: "assistant" },
    });
    bufferEvent("thread:dual", "response.reasoning_summary_text.delta", { delta: "plan" });
    bufferEvent("thread:dual", "response.output_text.delta", { item_id: "msg_c", delta: "plan" });
    if (extractThinkingText(getLiveTurn("thread:dual", promptHash("d"))) !== "plan")
        throw new Error("dual-emitted thinking must not concatenate commentary onto reasoning");
    console.log("ok dual-emitted thinking is not doubled");
}

{
    const { createStreamParser } = await import("../patches/cli-stream-parser.js");
    const texts = [];
    const events = [];
    const parse = createStreamParser(
        (delta) => texts.push(delta),
        () => events.push({ type: "done" }),
        () => {},
        (ev) => events.push(ev),
    );
    parse(JSON.stringify({ type: "system", subtype: "init" }));
    parse(JSON.stringify({ type: "thinking", subtype: "delta", text: "checking Render" }));
    parse(JSON.stringify({ type: "thinking", subtype: "completed", text: "checking Render" }));
    parse(JSON.stringify({
        type: "tool_call",
        subtype: "started",
        call_id: "t1",
        name: "Shell",
        args: { command: "curl https://example" },
    }));
    parse(JSON.stringify({ type: "thinking", subtype: "delta", text: "waiting on deploy" }));
    parse(JSON.stringify({ type: "assistant", text: "deploy is live" }));
    parse(JSON.stringify({ type: "result", subtype: "success" }));
    if (events.filter((e) => e.type === "thinking").map((e) => e.text).join("") !== "checking Renderwaiting on deploy")
        throw new Error(`parser thinking ${JSON.stringify(events)}`);
    if (!events.some((e) => e.type === "tool" && e.name === "Shell"))
        throw new Error("parser must emit tool");
    if (texts.join("") !== "deploy is live")
        throw new Error(`parser text too early: ${texts.join("")}`);
    if (!events.some((e) => e.type === "done"))
        throw new Error("parser must finish on result success");
    console.log("ok stream-json thinking then tools then one assistant");
}

{
    const { loadOverlayMapping } = await import("../patches/overlay-reload.js");
    const first = await loadOverlayMapping();
    if (typeof first.native.createResponsesNativeStream !== "function")
        throw new Error("mapping reload must expose createResponsesNativeStream");
    const second = await loadOverlayMapping();
    if (first.native !== second.native)
        throw new Error("unchanged overlay files must reuse the mapping module");
    console.log("ok overlay mapping reload cache");
}


