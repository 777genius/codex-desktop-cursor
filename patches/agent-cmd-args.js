/**
 * CLI flags and options for the Cursor agent, excluding the final prompt argument.
 */
export function buildAgentFixedArgs(config, workspaceDir, model, stream, mode, effectiveChatOnly, resumeChatId) {
    const args = ["--print"];
    if (resumeChatId) {
        args.push("--resume", resumeChatId);
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
/**
 * Build CLI arguments for running the Cursor agent.
 */
export function buildAgentCmdArgs(config, workspaceDir, model, prompt, stream, mode, effectiveChatOnly, resumeChatId) {
    return [
        ...buildAgentFixedArgs(config, workspaceDir, model, stream, mode, effectiveChatOnly, resumeChatId),
        prompt,
    ];
}
