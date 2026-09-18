/**
 * CLI flags and options for the Cursor agent, excluding the final prompt argument.
 */
import { writeConversationHistoryFile } from "./conversation-history.js";

export function buildAgentFixedArgs(config, workspaceDir, model, stream, mode, effectiveChatOnly, resumeChatId, historyFile) {
    const args = ["--print"];
    if (resumeChatId) {
        args.push("--resume", resumeChatId);
    }
    else if (historyFile) {
        args.push("--conversation-history-file", historyFile);
    }
    if (config.approveMcps)
        args.push("--approve-mcps");
    if (config.force && mode === "agent") {
        args.push("--force");
        args.push("--sandbox", "disabled");
    }
    args.push("--trust");
    // cursor-agent only accepts --mode plan|ask; agent mode is the default
    // and rejects --mode agent with "argument 'agent' is invalid".
    if (mode !== "agent") {
        args.push("--mode", mode);
    }
    args.push("--workspace", workspaceDir);
    args.push("--model", model);
    if (stream) {
        args.push("--stream-partial-output", "--output-format", "stream-json");
    }
    else {
        args.push("--output-format", "text");
    }
    return args;
}

/** Same prompt/history/resume split responses + chat + anthropic use. */
export function resolveAgentCliTurn(turn, seededPrompt) {
    const historyFile = !turn.resumed && turn.historyMessages?.length
        ? writeConversationHistoryFile(turn.threadKey, turn.historyMessages)
        : undefined;
    const agentPrompt = turn.resumed || turn.historyMessages?.length ? turn.agentPrompt : seededPrompt;
    return { historyFile, agentPrompt };
}

/**
 * Build CLI arguments for running the Cursor agent.
 */
export function buildAgentCmdArgs(config, workspaceDir, model, prompt, stream, mode, effectiveChatOnly, resumeChatId, historyFile) {
    return [
        ...buildAgentFixedArgs(config, workspaceDir, model, stream, mode, effectiveChatOnly, resumeChatId, historyFile),
        prompt,
    ];
}
