import { createResponsesNativeStream, emitCompactContinue, emitCompactReplay, emitFailed, emitInFlightSnapshot } from "../patches/responses-native.js";
import { assertResponsesTerminal, parseSse } from "../patches/sse-contract.js";
import { extractFinalText, extractThinkingText, extractTurnHistory, beginLiveTurn, bufferEvent, completeLiveTurn, peekLiveTurn, getLiveTurn, promptHash, rewriteResponseId } from "../patches/thread-replay.js";
import { isDesktopExecFollowUp } from "../patches/tool-types.js";
import { extractCodexThreadId } from "../patches/cursor-turn.js";
import { rememberCall, rememberResponse, resetStoreForTest, threadKeyFromFollowUp } from "../patches/thread-session.js";

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
    emitInFlightSnapshot({
        res,
        writeEvent: collectWrite(res),
        responseId: id,
        body: {},
        displayModel: "m",
        createdAt: 1,
        thinking: "My analysis is now focused on evaluating the session's freshness.",
        keepOpen: true,
    });
    const events = parseSse(res.dump());
    if (!events.find((e) => e.event === "response.created"))
        throw new Error("keepOpen snapshot missing created");
    if (!events.find((e) => e.event === "response.reasoning_summary_text.delta"))
        throw new Error("keepOpen snapshot must stream thinking");
    if (events.some((e) => e.event === "response.output_item.done" && e.data?.item?.type === "reasoning"))
        throw new Error("keepOpen snapshot must not close Thought");
    if (events.some((e) => e.event === "response.completed" || e.event === "response.failed"))
        throw new Error("keepOpen snapshot must not terminal");
    console.log("ok keepOpen snapshot leaves Thought in progress");
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
    if (events.some((e) => e.data?.item?.phase === "commentary"))
        throw new Error("thoughts must use native reasoning items, not commentary messages");
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

