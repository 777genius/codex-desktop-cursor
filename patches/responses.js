import { randomUUID } from "node:crypto";
import { buildAgentFixedArgs } from "../agent-cmd-args.js";
import { getAccountStats, getNextAccountConfigDir, reportRateLimit, reportRequestEnd, reportRequestError, reportRequestStart, reportRequestSuccess, } from "../account-pool.js";
import { BRIDGE_AGENT_PROMPT_SEPARATOR, buildBridgeContextPreamble, } from "../bridge-context-preamble.js";
import { json, writeSseHeaders } from "../http.js";
import { runAgentStream, runAgentSync, startAgentToolSession, } from "../agent-runner.js";
import { createStreamParser } from "../cli-stream-parser.js";
import { resolveModelForExecution } from "../model-map.js";
import { buildPromptFromMessages, normalizeModelId, responsesInputToMessages, toolsToSystemText, } from "../openai.js";
import { logAccountAssigned, logAccountStats, logAgentError, logModelResolution, logTrafficRequest, logTrafficResponse, } from "../request-log.js";
import { rememberResolvedModel, resolveModel } from "../resolve-model.js";
import { resolveRequestMode } from "../resolve-mode.js";
import { resolveRequestWorkspaceHeader } from "../codex-desktop.js";
import { extractCodexThreadId, prepareAgentInvocation, sessionIdFromStdout } from "../cursor-turn.js";
import { createResponsesNativeStream, emitCompactContinue, emitCompactReplay, emitInFlightSnapshot } from "../responses-native.js";
import { acquireThreadLock } from "../thread-lock.js";
import { markThreadOutput, markThreadPrompt, rememberCall, rememberResponse, threadKeyFromFollowUp } from "../thread-session.js";
import { addLiveSink, beginLiveTurn, bufferEvent, completeLiveTurn, extractFinalText, extractThinkingText, getLiveRecord, getLiveTurn, peekLiveTurn, promptHash, rewriteResponseId, } from "../thread-replay.js";
import { sanitizeMessages } from "../sanitize.js";
import { resolveWorkspace } from "../workspace.js";
import { fitPromptToWinCmdline, warnPromptTruncated, } from "../win-cmdline-limit.js";
import { abortOnClientDisconnect } from "../client-disconnect.js";
import { isDesktopExecFollowUp, parseOpenAiFunctionTools, resolveToolChoice, responsesToolOutputs, } from "../tool-types.js";
import { ToolSessionError, toolSessionOwnerKey, } from "../tool-session-registry.js";
import { getCachedCursorModels } from "./models.js";
function isRateLimited(stderr) {
    return /\b429\b|rate.?limit|too many requests/i.test(stderr);
}
function functionCallItem(call) {
    return {
        id: call.itemId,
        type: "function_call",
        status: "completed",
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments,
    };
}
function structuredResponseObject(opts) {
    const output = [];
    if (opts.result.text) {
        output.push({
            id: opts.messageId ?? `msg_${randomUUID().replace(/-/g, "")}`,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [
                {
                    type: "output_text",
                    text: opts.result.text,
                    annotations: [],
                },
            ],
        });
    }
    if (opts.result.status === "tool_calls") {
        output.push(...opts.result.toolCalls.map(functionCallItem));
    }
    const inputTokens = Math.max(1, Math.round(opts.promptLength / 4));
    const outputTokens = Math.max(1, Math.round(opts.result.text.length / 4));
    return {
        id: opts.id,
        object: "response",
        created_at: opts.createdAt,
        status: "completed",
        background: false,
        error: null,
        incomplete_details: null,
        instructions: opts.body.instructions ?? null,
        max_output_tokens: opts.body.max_output_tokens ?? null,
        model: opts.model,
        output,
        output_text: opts.result.text,
        parallel_tool_calls: opts.body.parallel_tool_calls ?? true,
        previous_response_id: opts.previousResponseId ?? opts.body.previous_response_id ?? null,
        reasoning: opts.body.reasoning ?? null,
        service_tier: opts.body.service_tier ?? "default",
        store: opts.body.store ?? true,
        temperature: opts.body.temperature ?? null,
        text: opts.body.text ?? { format: { type: "text" } },
        tool_choice: opts.body.tool_choice ?? "auto",
        tools: opts.body.tools ?? [],
        top_p: opts.body.top_p ?? null,
        truncation: opts.body.truncation ?? "disabled",
        usage: {
            input_tokens: inputTokens,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: outputTokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: inputTokens + outputTokens,
        },
        user: opts.body.user ?? null,
        metadata: opts.body.metadata ?? null,
    };
}
async function writeStructuredResponseTurn(opts) {
    const messageId = `msg_${randomUUID().replace(/-/g, "")}`;
    if (!opts.stream) {
        const result = await opts.run();
        json(opts.res, 200, structuredResponseObject({
            body: opts.body,
            id: opts.id,
            createdAt: opts.createdAt,
            model: opts.model,
            result,
            previousResponseId: opts.previousResponseId,
            promptLength: opts.promptLength,
            messageId,
        }));
        return result;
    }
    writeSseHeaders(opts.res);
    const initial = {
        id: opts.id,
        object: "response",
        created_at: opts.createdAt,
        status: "in_progress",
        model: opts.model,
        output: [],
    };
    writeResponseEvent(opts.res, "response.created", { response: initial });
    let textStarted = false;
    let emittedText = "";
    const emitText = (text) => {
        if (!textStarted) {
            textStarted = true;
            writeResponseEvent(opts.res, "response.output_item.added", {
                response_id: opts.id,
                output_index: 0,
                item: {
                    id: messageId,
                    type: "message",
                    status: "in_progress",
                    role: "assistant",
                    content: [],
                },
            });
            writeResponseEvent(opts.res, "response.content_part.added", {
                response_id: opts.id,
                item_id: messageId,
                output_index: 0,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
            });
        }
        emittedText += text;
        writeResponseEvent(opts.res, "response.output_text.delta", {
            response_id: opts.id,
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            delta: text,
        });
    };
    const result = await opts.run((event) => {
        if (event.type === "text")
            emitText(event.text);
    });
    if (result.text.length > emittedText.length) {
        emitText(result.text.slice(emittedText.length));
    }
    let outputIndex = textStarted ? 1 : 0;
    if (textStarted) {
        writeResponseEvent(opts.res, "response.output_text.done", {
            response_id: opts.id,
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            text: result.text,
        });
        writeResponseEvent(opts.res, "response.content_part.done", {
            response_id: opts.id,
            item_id: messageId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: result.text, annotations: [] },
        });
        writeResponseEvent(opts.res, "response.output_item.done", {
            response_id: opts.id,
            output_index: 0,
            item: {
                id: messageId,
                type: "message",
                status: "completed",
                role: "assistant",
                content: [
                    { type: "output_text", text: result.text, annotations: [] },
                ],
            },
        });
    }
    if (result.status === "tool_calls") {
        for (const call of result.toolCalls) {
            writeResponseEvent(opts.res, "response.output_item.added", {
                response_id: opts.id,
                output_index: outputIndex,
                item: functionCallItem(call),
            });
            writeResponseEvent(opts.res, "response.output_item.done", {
                response_id: opts.id,
                output_index: outputIndex,
                item: functionCallItem(call),
            });
            outputIndex += 1;
        }
    }
    writeResponseEvent(opts.res, "response.completed", {
        response: structuredResponseObject({
            body: opts.body,
            id: opts.id,
            createdAt: opts.createdAt,
            model: opts.model,
            result,
            previousResponseId: opts.previousResponseId,
            promptLength: opts.promptLength,
            messageId,
        }),
    });
    opts.res.write("data: [DONE]\n\n");
    opts.res.end();
    return result;
}
function createResponseObject(opts) {
    const output = opts.status === "completed"
        ? [
            {
                id: opts.itemId,
                type: "message",
                status: "completed",
                role: "assistant",
                content: [
                    {
                        type: "output_text",
                        text: opts.text,
                        annotations: [],
                    },
                ],
            },
        ]
        : [];
    const totalTokens = opts.promptTokens + opts.completionTokens;
    return {
        id: opts.id,
        object: "response",
        created_at: opts.createdAt,
        status: opts.status,
        background: false,
        error: opts.error ?? null,
        incomplete_details: null,
        instructions: opts.body.instructions ?? null,
        max_output_tokens: opts.body.max_output_tokens ?? null,
        model: opts.model,
        output,
        output_text: opts.text,
        parallel_tool_calls: opts.body.parallel_tool_calls ?? true,
        previous_response_id: opts.body.previous_response_id ?? null,
        reasoning: opts.body.reasoning ?? null,
        service_tier: opts.body.service_tier ?? "default",
        store: opts.body.store ?? false,
        temperature: opts.body.temperature ?? null,
        text: opts.body.text ?? { format: { type: "text" } },
        tool_choice: opts.body.tool_choice ?? "auto",
        tools: opts.body.tools ?? [],
        top_p: opts.body.top_p ?? null,
        truncation: opts.body.truncation ?? "disabled",
        usage: {
            input_tokens: opts.promptTokens,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: opts.completionTokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: totalTokens,
        },
        user: opts.body.user ?? null,
        metadata: opts.body.metadata ?? null,
    };
}
function createOutputItem(itemId, status, text) {
    return {
        id: itemId,
        type: "message",
        status,
        role: "assistant",
        content: [
            {
                type: "output_text",
                text,
                annotations: [],
            },
        ],
    };
}
function writeResponseEvent(res, type, data) {
    if (res.writableEnded || res.destroyed)
        return;
    try {
        res.write(`event: ${type}\n`);
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
        if (typeof res.flush === "function")
            res.flush();
    }
    catch {
        /* client gone; Cursor agent may still be running */
    }
}

function startSseKeepalive(getSinks, writeIdle, lastEventAt) {
    const tick = () => {
        const sinks = typeof getSinks === "function" ? getSinks() : [];
        const open = sinks.some((s) => s?.res && !s.res.writableEnded && !s.res.destroyed);
        if (!open)
            return;
        if (Date.now() - lastEventAt() < 15000)
            return;
        try {
            writeIdle();
        }
        catch {
            /* ignore */
        }
    };
    const timer = setInterval(tick, 20000);
    if (typeof timer.unref === "function")
        timer.unref();
    return () => clearInterval(timer);
}

function sinkOpen(sink) {
    return sink?.res && !sink.res.writableEnded && !sink.res.destroyed;
}

function writeToLiveSinks(threadKey, fallbackRes, fallbackId, type, data) {
    const rec = getLiveRecord(threadKey);
    const sinks = rec?.sinks?.length ? rec.sinks : [{ res: fallbackRes, id: fallbackId }];
    const fromId = rec?.primaryId || fallbackId;
    for (const sink of sinks) {
        if (sink.compact || sink.translated) {
            if (type === "response.in_progress" && sinkOpen(sink)) {
                writeResponseEvent(sink.res, "response.in_progress", {
                    response: { id: sink.id, object: "response", status: "in_progress" },
                });
            }
            continue;
        }
        const payload = sink.id === fromId ? data : rewriteResponseId(data, fromId, sink.id);
        writeResponseEvent(sink.res, type, payload);
        if (type === "response.completed") {
            try {
                if (sinkOpen(sink))
                    sink.res.write("data: [DONE]\n\n");
            }
            catch {
                /* client gone */
            }
        }
    }
}

function endLiveSinks(threadKey, fallbackRes) {
    const rec = getLiveRecord(threadKey);
    const sinks = rec?.sinks?.length ? rec.sinks : [{ res: fallbackRes }];
    const text = extractFinalText(rec) || "";
    for (const sink of sinks) {
        try {
            if (!sinkOpen(sink))
                continue;
            if (sink.native && typeof sink.native.finish === "function" && !sink.native.isFinished?.()) {
                sink.native.finish();
            }
            else if (sink.compact) {
                emitCompactContinue({
                    res: sink.res,
                    writeEvent: (type, data) => writeResponseEvent(sink.res, type, data),
                    responseId: sink.id,
                    body: sink.body || {},
                    displayModel: sink.displayModel,
                    createdAt: sink.createdAt || Math.floor(Date.now() / 1000),
                    text,
                    thinking: "",
                });
            }
            if (!sink.res.writableEnded)
                sink.res.end();
        }
        catch {
            /* client gone */
        }
    }
}

async function reattachLiveStream({ res, responseId, threadKey, body, displayModel, createdAt }) {
    const rec = peekLiveTurn(threadKey);
    if (!rec?.primaryId)
        return false;
    writeSseHeaders(res);
    if (typeof res.flushHeaders === "function")
        res.flushHeaders();
    const thinking = extractThinkingText(rec) || "";
    console.log(`[reattach] ${threadKey} hang events=${rec.events.length} thinking=${thinking.length}`);
    rememberResponse(threadKey, responseId);
    const native = emitInFlightSnapshot({
        res,
        writeEvent: (type, data) => {
            const callId = data?.item?.call_id || data?.item?.callId;
            if (callId)
                rememberCall(threadKey, callId);
            writeResponseEvent(res, type, data);
        },
        responseId,
        body: body || {},
        displayModel,
        createdAt,
        thinking: thinking || "Working…",
        keepOpen: true,
    });
    addLiveSink(threadKey, {
        res,
        id: responseId,
        translated: true,
        native,
        body: body || {},
        displayModel,
        createdAt,
    });
    return true;
}

function liveNatives(threadKey) {
    const out = [];
    for (const sink of getLiveRecord(threadKey)?.sinks || []) {
        if (sink?.native && typeof sink.native.onThinking === "function" && !sink.native.isFinished?.())
            out.push(sink.native);
    }
    return out;
}
function responseContentText(message) {
    const content = message?.content;
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .filter((p) => p?.type === "text" ||
            p?.type === "input_text" ||
            p?.type === "output_text")
            .map((p) => p.text ?? "")
            .join("");
    }
    return "";
}
export async function handleResponses(req, res, ctx, rawBody, method, pathname, remoteAddress) {
    const { config, lastRequestedModelRef, modelCacheRef } = ctx;
    const body = JSON.parse(rawBody || "{}");
    let selectedTools;
    let toolInstruction;
    let requireToolCall = false;
    let maxParallelToolCalls;
    let submittedToolOutputs;
    try {
        const parsedTools = parseOpenAiFunctionTools(body.tools);
        const choice = resolveToolChoice(parsedTools, body.tool_choice, {
            parallelToolCalls: body.parallel_tool_calls,
        });
        selectedTools = choice.tools;
        toolInstruction = choice.instruction;
        requireToolCall = choice.required;
        maxParallelToolCalls = choice.maxParallelToolCalls;
        submittedToolOutputs = responsesToolOutputs(body.input);
    }
    catch (error) {
        json(res, 400, {
            error: {
                message: error instanceof Error ? error.message : String(error),
                code: "invalid_tools",
                type: "invalid_request_error",
            },
        });
        return;
    }
    if (config.useAcp && submittedToolOutputs.length > 0) {
        if (Array.isArray(body.input) &&
            body.input.some((item) => !item ||
                typeof item !== "object" ||
                item.type !== "function_call_output")) {
            json(res, 400, {
                error: {
                    message: "A function_call_output resume cannot include other input item types",
                    code: "invalid_tool_resume",
                    type: "invalid_request_error",
                },
            });
            return;
        }
        if (body.instructions != null) {
            json(res, 400, {
                error: {
                    message: "instructions cannot change while an ACP tool turn is active",
                    code: "invalid_tool_resume",
                    type: "invalid_request_error",
                },
            });
            return;
        }
    }
    const ownerKey = toolSessionOwnerKey(req, remoteAddress);
    const requested = normalizeModelId(body.model);
    const model = resolveModel(requested, lastRequestedModelRef, config);
    const models = await getCachedCursorModels(config, modelCacheRef);
    const decision = resolveModelForExecution({
        requested: model,
        defaultModel: config.defaultModel,
        availableCursorIds: models.map((m) => m.id),
    });
    const cursorModel = decision.final;
    rememberResolvedModel(cursorModel, lastRequestedModelRef);
    logModelResolution(config.verbose, decision);
    const displayModel = decision.requestedWasDefault && config.defaultModel !== "default"
        ? config.defaultModel
        : model;
    const modelCatalogName = models.find((item) => item.id === cursorModel)?.name;
    const id = `resp_${randomUUID().replace(/-/g, "")}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const followThreadId = extractCodexThreadId(req.headers, body, "");
    const followThreadKey = followThreadId
        ? `thread:${followThreadId}`
        : threadKeyFromFollowUp(body, submittedToolOutputs);
    if (!config.useAcp && isDesktopExecFollowUp(body, submittedToolOutputs)) {
        const live = followThreadKey ? peekLiveTurn(followThreadKey) : undefined;
        console.log(`[exec-followup] outputs=${submittedToolOutputs.length} thread=${followThreadKey || "-"} live=${!!live} prev=${body.previous_response_id || "-"}`);
        if (body.stream && live) {
            await reattachLiveStream({
                res,
                responseId: id,
                threadKey: followThreadKey,
                body,
                displayModel,
                createdAt,
            });
            return;
        }
        // Tool-output follow-up is plumbing, not a new assistant turn.
        // Replaying a finished turn's text here is how 019fc3aa duplicated
        // the ranking essay after Desktop POSTed exec_command outputs.
        const replayText = " ";
        if (body.stream) {
            writeSseHeaders(res);
            emitCompactReplay({
                res,
                writeEvent: (type, data) => writeResponseEvent(res, type, data),
                responseId: id,
                body,
                displayModel,
                createdAt,
                text: replayText,
            });
            if (!res.writableEnded)
                res.end();
        }
        else {
            json(res, 200, createResponseObject({
                body,
                id,
                createdAt,
                model: displayModel,
                status: "completed",
                text: replayText,
                itemId: `msg_${randomUUID().replace(/-/g, "")}`,
                promptTokens: 1,
                completionTokens: 1,
            }));
        }
        return;
    }
    const cleanMessages = sanitizeMessages(responsesInputToMessages(body));
    const structuredToolStart = config.useAcp &&
        selectedTools.length > 0 &&
        submittedToolOutputs.length === 0;
    if (structuredToolStart && body.store === false) {
        json(res, 400, {
            error: {
                message: "store=false is incompatible with stateful ACP tool passthrough",
                code: "invalid_store",
                type: "invalid_request_error",
            },
        });
        return;
    }
    const toolsText = structuredToolStart
        ? undefined
        : body.tool_choice === "none"
            ? undefined
            : toolsToSystemText(body.tools);
    const messagesWithTools = [
        ...(toolInstruction && structuredToolStart
            ? [{ role: "system", content: toolInstruction }]
            : []),
        ...(toolsText ? [{ role: "system", content: toolsText }] : []),
        ...cleanMessages,
    ];
    const prompt = buildPromptFromMessages(messagesWithTools);
    const trafficMessages = cleanMessages.map((m) => ({
        role: String(m?.role ?? "user"),
        content: responseContentText(m),
    }));
    logTrafficRequest(config.verbose, model ?? cursorModel, trafficMessages, !!body.stream);
    if (config.useAcp && submittedToolOutputs.length > 0) {
        const previousResponseId = body.previous_response_id;
        const record = typeof previousResponseId === "string"
            ? ctx.toolSessions.findByResponseId(ownerKey, previousResponseId)
            : undefined;
        if (!record ||
            record.api !== "responses" ||
            !submittedToolOutputs.every((output) => record.session.hasCall(output.callId))) {
            json(res, 409, {
                error: {
                    message: "Response tool session is missing or expired; resend the original input",
                    code: "tool_session_expired",
                    type: "invalid_request_error",
                },
            });
            return;
        }
        const configDir = record.configDir;
        logAccountAssigned(configDir);
        reportRequestStart(configDir);
        const startedAt = Date.now();
        const abortController = new AbortController();
        abortOnClientDisconnect(res, abortController);
        abortController.signal.addEventListener("abort", () => void record.session.close(), { once: true });
        try {
            const result = await writeStructuredResponseTurn({
                res,
                body,
                stream: !!body.stream,
                id,
                createdAt,
                model: displayModel,
                previousResponseId,
                promptLength: prompt.length,
                run: async (listener) => {
                    const turn = await ctx.toolSessions.resume(record, submittedToolOutputs, listener);
                    if (turn.status === "tool_calls") {
                        ctx.toolSessions.aliasResponse(record, id);
                    }
                    return turn;
                },
            });
            reportRequestSuccess(configDir, Date.now() - startedAt);
            logTrafficResponse(config.verbose, model ?? cursorModel, result.text, !!body.stream);
        }
        catch (error) {
            reportRequestError(configDir, Date.now() - startedAt);
            if (!res.headersSent) {
                json(res, error instanceof ToolSessionError ? error.status : 500, {
                    error: {
                        message: error instanceof Error ? error.message : String(error),
                        code: error instanceof ToolSessionError
                            ? error.code
                            : "tool_session_error",
                    },
                });
            }
            else if (!res.writableEnded) {
                writeResponseEvent(res, "response.failed", {
                    response: {
                        id,
                        object: "response",
                        status: "failed",
                        error: {
                            message: error instanceof Error ? error.message : String(error),
                            code: "tool_session_error",
                        },
                    },
                });
                res.end();
            }
        }
        finally {
            reportRequestEnd(configDir);
            logAccountStats(config.verbose, getAccountStats());
        }
        return;
    }
    let mode;
    try {
        mode = resolveRequestMode(config, req.headers["x-cursor-mode"], body.mode, prompt);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "Invalid mode";
        json(res, 400, { error: { message: msg, code: "invalid_mode" } });
        return;
    }
    const effectiveChatOnly = mode === "ask"
        ? config.chatOnlyWorkspace
        : config.chatOnlyWorkspaceExplicit && config.chatOnlyWorkspace;
    const headerWs = resolveRequestWorkspaceHeader(req.headers["x-cursor-workspace"], prompt);
    let workspaceDir;
    let tempDir;
    try {
        const ws = resolveWorkspace(config, headerWs, effectiveChatOnly);
        workspaceDir = ws.workspaceDir;
        tempDir = ws.tempDir;
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : "Invalid workspace";
        json(res, 400, { error: { message: msg, code: "invalid_workspace" } });
        return;
    }
    const invocation = {
        headers: req.headers,
        body,
        messages: cleanMessages,
        fullPrompt: prompt,
        toolsText,
        model: cursorModel,
        mode,
        workspaceDir,
    };
    const preview = prepareAgentInvocation(invocation, { silent: true });
    const previewHash = promptHash(preview.agentPrompt);
    if (body.stream) {
        const liveKey = preview.threadKey || threadKeyFromFollowUp(body, submittedToolOutputs);
        const inflight = peekLiveTurn(liveKey);
        if (inflight && inflight.primaryId) {
            if (inflight.hash !== previewHash)
                console.log(`[reattach] ${liveKey} hash mismatch; attaching live turn`);
            await reattachLiveStream({
                res,
                responseId: id,
                threadKey: liveKey,
                body,
                displayModel,
                createdAt,
            });
            return;
        }
    }
    const unlock = await acquireThreadLock(preview.threadKey);
    let streamStarted = false;
    const turn = prepareAgentInvocation(invocation, { silent: true });
    try {
    const seededPrompt = config.contextPreamble
        ? `${buildBridgeContextPreamble({
            headers: req.headers,
            bridgeWorkspaceBase: config.workspace,
            agentWorkspaceDir: workspaceDir,
            isolatedChatOnly: tempDir !== undefined,
            cursorMode: mode,
            contextExtra: config.contextExtra,
        })}${BRIDGE_AGENT_PROMPT_SEPARATOR}${prompt}`
        : prompt;
    const agentPrompt = turn.resumed ? turn.agentPrompt : seededPrompt;
    const turnHash = promptHash(turn.agentPrompt);
    const cachedTurn = getLiveTurn(turn.threadKey, turnHash);
    // Replay only the answer produced for THIS prompt. lastOutputText from an
    // earlier turn is how «дальше» on 019fc3aa re-printed the ranking essay.
    const finishedText = cachedTurn?.done ? (extractFinalText(cachedTurn) || "") : "";
    if (body.stream && finishedText) {
        console.log(`[replay] ${turn.threadKey} chat=${turn.resumeChatId || "-"} compact=${finishedText.length}`);
        writeSseHeaders(res);
        if (typeof res.flushHeaders === "function")
            res.flushHeaders();
        emitCompactReplay({
            res,
            writeEvent: (type, data) => writeResponseEvent(res, type, data),
            responseId: id,
            body,
            displayModel,
            createdAt,
            text: finishedText,
        });
        if (!res.writableEnded)
            res.end();
        return;
    }
    if (turn.resumed)
        console.log(`[resume] ${turn.threadKey} chat=${turn.resumeChatId} bytes=${turn.agentPrompt.length}`);
    else
        console.log(`[seed] ${turn.threadKey} bytes=${agentPrompt.length}`);
    const fixedArgs = buildAgentFixedArgs(config, workspaceDir, cursorModel, !!body.stream, mode, effectiveChatOnly, turn.resumeChatId);
    const fit = fitPromptToWinCmdline(config.agentBin, fixedArgs, agentPrompt, {
        maxCmdline: config.winCmdlineMax,
        platform: process.platform,
        cwd: workspaceDir,
    });
    if (!fit.ok) {
        json(res, 500, {
            error: {
                message: fit.error,
                code: "windows_cmdline_limit",
                type: "api_error",
            },
        });
        return;
    }
    if (fit.truncated) {
        warnPromptTruncated(fit.originalLength, fit.finalPromptLength);
    }
    // When the prompt is delivered via stdin (or ACP), keep it OUT of argv,
    // otherwise a long prompt still blows past the kernel ARG_MAX (spawn E2BIG
    // on Linux). fit.args appends the full prompt for the argv path only.
    const cmdArgs = config.promptViaStdin || config.useAcp ? fixedArgs : fit.args;
    const itemId = `msg_${randomUUID().replace(/-/g, "")}`;
    const promptForAgent = config.promptViaStdin || config.useAcp ? agentPrompt : undefined;
    const truncatedHeaders = fit.truncated
        ? { "X-Cursor-Proxy-Prompt-Truncated": "true" }
        : undefined;
    if (structuredToolStart) {
        const configDir = getNextAccountConfigDir();
        logAccountAssigned(configDir);
        reportRequestStart(configDir);
        const startedAt = Date.now();
        const abortController = new AbortController();
        abortOnClientDisconnect(res, abortController);
        let record;
        try {
            const session = await startAgentToolSession({
                config,
                workspaceDir,
                effectiveChatOnly,
                cmdArgs,
                prompt: agentPrompt,
                tools: selectedTools,
                tempDir,
                configDir,
                signal: abortController.signal,
                modelDisplayName: modelCatalogName,
                requireToolCall,
                maxParallelToolCalls,
            });
            record = ctx.toolSessions.createRecord({
                api: "responses",
                ownerKey,
                model: displayModel ?? cursorModel,
                configDir,
                session,
            });
            abortController.signal.addEventListener("abort", () => void session.close(), { once: true });
            const result = await writeStructuredResponseTurn({
                res,
                body,
                stream: !!body.stream,
                id,
                createdAt,
                model: displayModel,
                previousResponseId: body.previous_response_id,
                promptLength: agentPrompt.length,
                run: async (listener) => {
                    const turn = await ctx.toolSessions.collect(record, listener);
                    if (turn.status === "tool_calls") {
                        ctx.toolSessions.aliasResponse(record, id);
                    }
                    return turn;
                },
            });
            reportRequestSuccess(configDir, Date.now() - startedAt);
            if (result.status === "completed" &&
                result.stderr &&
                isRateLimited(result.stderr)) {
                reportRateLimit(configDir, 60_000);
            }
            logTrafficResponse(config.verbose, model ?? cursorModel, result.text, !!body.stream);
        }
        catch (error) {
            if (record) {
                ctx.toolSessions.remove(record);
                await record.session.close().catch(() => undefined);
            }
            reportRequestError(configDir, Date.now() - startedAt);
            if (!res.headersSent) {
                json(res, 500, {
                    error: {
                        message: error instanceof Error ? error.message : String(error),
                        code: "tool_session_error",
                        type: "api_error",
                    },
                });
            }
            else if (!res.writableEnded) {
                writeResponseEvent(res, "response.failed", {
                    response: {
                        id,
                        object: "response",
                        status: "failed",
                        error: {
                            message: error instanceof Error ? error.message : String(error),
                            code: "tool_session_error",
                        },
                    },
                });
                res.end();
            }
        }
        finally {
            reportRequestEnd(configDir);
            logAccountStats(config.verbose, getAccountStats());
        }
        return;
    }
    if (body.stream) {
        const configDir = getNextAccountConfigDir();
        logAccountAssigned(configDir);
        reportRequestStart(configDir);
        const streamStart = Date.now();
        const abortController = new AbortController();
        // Do not SIGKILL cursor-agent when Mixin/Desktop drops the websocket.
        // 01a0719d was dying every ~6 minutes on "Connection reset" and then
        // retrying the same last-user prompt forever. Keep the Cursor chat
        // turn running; the thread lock serializes the Desktop retry.
        writeSseHeaders(res, truncatedHeaders);
        if (typeof res.flushHeaders === "function")
            res.flushHeaders();
        res.on("error", () => {
            /* client disconnected mid-stream */
        });
        res.on("close", () => {
            if (!res.writableEnded)
                console.log("[detach] client gone; cursor-agent keeps running");
        });
        const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
        beginLiveTurn(turn.threadKey, turnHash, { res, responseId: id });
        rememberResponse(turn.threadKey, id);
        markThreadPrompt(turn.threadKey, turn.agentPrompt);
        let lastEventAt = Date.now();
        const writeTracked = (type, data) => {
            lastEventAt = Date.now();
            if (type !== "response.in_progress")
                bufferEvent(turn.threadKey, type, data);
            const callId = data?.item?.call_id || data?.item?.callId;
            if (callId)
                rememberCall(turn.threadKey, callId);
            writeToLiveSinks(turn.threadKey, res, id, type, data);
        };
        const stopKeepalive = startSseKeepalive(() => getLiveRecord(turn.threadKey)?.sinks || [{ res, id }], () => writeTracked("response.in_progress", {
            response: { id, object: "response", status: "in_progress" },
        }), () => lastEventAt);
        const native = createResponsesNativeStream({
            res,
            writeEvent: writeTracked,
            responseId: id,
            body,
            displayModel,
            createdAt,
            promptTokens,
            fanoutDone: true,
        });
        const initialResponse = createResponseObject({
            body,
            id,
            itemId,
            createdAt,
            model: displayModel,
            status: "in_progress",
            text: "",
            promptTokens,
            completionTokens: 0,
        });
        writeTracked("response.created", { response: { ...initialResponse, output: [] } });
        const writeChunk = (chunk, accumulated) => native.onText(chunk);
        const finishStream = (accumulated) => {
            logTrafficResponse(config.verbose, model ?? cursorModel, native.getText() || accumulated, true);
            native.finish();
        };
        if (config.useAcp && typeof promptForAgent === "string") {
            let accumulated = "";
            streamStarted = true;
            runAgentStream(config, workspaceDir, effectiveChatOnly, cmdArgs, (chunk) => {
                accumulated = writeChunk(chunk, accumulated);
            }, tempDir, promptForAgent, configDir, abortController.signal, modelCatalogName)
                .then(({ code, stderr: stderrOut }) => {
                stopKeepalive();
                const latencyMs = Date.now() - streamStart;
                reportRequestEnd(configDir);
                if (stderrOut && isRateLimited(stderrOut)) {
                    reportRateLimit(configDir, 60000);
                }
                if (abortController.signal.aborted) {
                    finishStream(accumulated);
                }
                else if (code !== 0) {
                    reportRequestError(configDir, latencyMs);
                    const publicMsg = logAgentError(config.sessionsLogPath, method, pathname, remoteAddress, code, stderrOut);
                    if (!accumulated)
                        accumulated = publicMsg;
                    finishStream(accumulated);
                    logAccountStats(config.verbose, getAccountStats());
                    res.end();
                    return;
                }
                else {
                    reportRequestSuccess(configDir, latencyMs);
                }
                logAccountStats(config.verbose, getAccountStats());
                finishStream(accumulated);
                res.end();
            })
                .catch((err) => {
                stopKeepalive();
                reportRequestEnd(configDir);
                reportRequestError(configDir, Date.now() - streamStart);
                if (!accumulated)
                    accumulated = "The Cursor agent stream failed. See server logs for details.";
                finishStream(accumulated);
                console.error(`[${new Date().toISOString()}] Agent stream error:`, err);
                if (!res.writableEnded)
                    res.end();
            })
                .finally(() => {
                stopKeepalive();
                completeLiveTurn(turn.threadKey);
                markThreadOutput(turn.threadKey, extractFinalText(getLiveTurn(turn.threadKey, turnHash)));
                unlock();
            });
            return;
        }
        let accumulated = "";
        let streamFinished = false;
        const finishOnce = (text) => {
            if (streamFinished)
                return;
            streamFinished = true;
            finishStream(text);
        };
        let capturedSessionId;
        const parseLine = createStreamParser((text) => {
            accumulated = native.onText(text);
            for (const extra of liveNatives(turn.threadKey))
                extra.onText(text);
        }, () => {
            /* finish on process exit only — Mixin rejects streams that close
               without response.completed for THIS response id, and also rejects
               extra events after a terminal. */
        }, (sid) => {
            capturedSessionId = sid;
            turn.rememberSession(sid);
        }, (event) => {
            if (event.type === "thinking") {
                native.onThinking(event.text);
                for (const extra of liveNatives(turn.threadKey))
                    extra.onThinking(event.text);
            }
            else if (event.type === "tool") {
                native.onTool(event);
                for (const extra of liveNatives(turn.threadKey))
                    extra.onTool(event);
            }
        });
        streamStarted = true;
        runAgentStream(config, workspaceDir, effectiveChatOnly, cmdArgs, parseLine, tempDir, promptForAgent, configDir, abortController.signal, modelCatalogName)
            .then(({ code, stderr: stderrOut }) => {
            stopKeepalive();
            const latencyMs = Date.now() - streamStart;
            turn.commitSession(code, capturedSessionId);
            reportRequestEnd(configDir);
            if (stderrOut && isRateLimited(stderrOut)) {
                reportRateLimit(configDir, 60000);
            }
            if (code !== 0) {
                reportRequestError(configDir, latencyMs);
                const publicMsg = logAgentError(config.sessionsLogPath, method, pathname, remoteAddress, code, stderrOut);
                if (!accumulated)
                    accumulated = writeChunk(publicMsg, accumulated);
            }
            else {
                reportRequestSuccess(configDir, latencyMs);
            }
            finishOnce(accumulated);
            logAccountStats(config.verbose, getAccountStats());
            endLiveSinks(turn.threadKey, res);
        })
            .catch((err) => {
            stopKeepalive();
            reportRequestEnd(configDir);
            reportRequestError(configDir, Date.now() - streamStart);
            if (!accumulated) {
                const msg = "The Cursor agent stream failed. See server logs for details.";
                accumulated = writeChunk(msg, accumulated);
            }
            finishOnce(accumulated);
            console.error(`[${new Date().toISOString()}] Agent stream error:`, err);
            endLiveSinks(turn.threadKey, res);
        })
            .finally(() => {
            stopKeepalive();
            completeLiveTurn(turn.threadKey);
            markThreadOutput(turn.threadKey, extractFinalText(getLiveTurn(turn.threadKey, turnHash)));
            unlock();
        });
        return;
    }
    const configDir = getNextAccountConfigDir();
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const syncStart = Date.now();
    const abortController = new AbortController();
    abortOnClientDisconnect(res, abortController);
    const out = await runAgentSync(config, workspaceDir, effectiveChatOnly, cmdArgs, tempDir, promptForAgent, configDir, abortController.signal, modelCatalogName);
    const syncLatency = Date.now() - syncStart;
    reportRequestEnd(configDir);
    if (out.stderr && isRateLimited(out.stderr)) {
        reportRateLimit(configDir, 60000);
    }
    turn.commitSession(out.code, sessionIdFromStdout(out.stdout));
    if (out.code !== 0) {
        reportRequestError(configDir, syncLatency);
        logAccountStats(config.verbose, getAccountStats());
        const errMsg = logAgentError(config.sessionsLogPath, method, pathname, remoteAddress, out.code, out.stderr);
        json(res, 500, {
            error: { message: errMsg, code: "cursor_cli_error" },
        });
        return;
    }
    reportRequestSuccess(configDir, syncLatency);
    const content = out.stdout.trim();
    logTrafficResponse(config.verbose, model ?? cursorModel, content, false);
    const promptTokens = Math.max(1, Math.round(agentPrompt.length / 4));
    const completionTokens = Math.max(1, Math.round(content.length / 4));
    logAccountStats(config.verbose, getAccountStats());
    json(res, 200, createResponseObject({
        body,
        id,
        itemId,
        createdAt,
        model: displayModel,
        status: "completed",
        text: content,
        promptTokens,
        completionTokens,
    }), truncatedHeaders);
    }
    finally {
        if (!streamStarted)
            unlock();
    }
}
//# sourceMappingURL=responses.js.map