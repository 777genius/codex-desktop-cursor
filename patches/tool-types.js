function asRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
    }
    return value;
}
function schemaOrDefault(value) {
    return (asRecord(value) ?? {
        type: "object",
        properties: {},
    });
}
function pushUnique(out, seen, definition) {
    if (!definition.name.trim()) {
        throw new Error("Function tool is missing name");
    }
    if (seen.has(definition.name)) {
        throw new Error(`Duplicate function tool name: ${definition.name}`);
    }
    seen.add(definition.name);
    out.push(definition);
}
/**
 * Parse OpenAI Chat Completions (`function` wrapper), Responses (flat
 * function), and legacy Chat `functions` definitions.
 */
export function parseOpenAiFunctionTools(tools, functions) {
    const out = [];
    const seen = new Set();
    for (const value of tools ?? []) {
        const tool = asRecord(value);
        if (!tool)
            throw new Error("Invalid tool definition");
        // Codex Desktop sends built-in tool types (namespace, web_search,
        // local_shell, apply_patch, …). This proxy only bridges function tools
        // to cursor-agent; skip the rest instead of 400ing the whole request.
        if (tool.type !== "function") {
            continue;
        }
        const wrapped = asRecord(tool.function);
        const fn = wrapped ?? tool;
        if (typeof fn.name !== "string") {
            throw new Error("Function tool is missing name");
        }
        pushUnique(out, seen, {
            name: fn.name,
            description: typeof fn.description === "string" ? fn.description : undefined,
            inputSchema: schemaOrDefault(fn.parameters),
        });
    }
    for (const value of functions ?? []) {
        const fn = asRecord(value);
        if (!fn || typeof fn.name !== "string") {
            throw new Error("Function is missing name");
        }
        pushUnique(out, seen, {
            name: fn.name,
            description: typeof fn.description === "string" ? fn.description : undefined,
            inputSchema: schemaOrDefault(fn.parameters),
        });
    }
    return out;
}
export function parseAnthropicFunctionTools(tools) {
    const out = [];
    const seen = new Set();
    for (const value of tools ?? []) {
        const tool = asRecord(value);
        if (!tool || typeof tool.name !== "string") {
            throw new Error("Anthropic tool is missing name");
        }
        pushUnique(out, seen, {
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : undefined,
            inputSchema: schemaOrDefault(tool.input_schema),
        });
    }
    return out;
}
function namedChoice(choice) {
    const rec = asRecord(choice);
    if (!rec)
        return undefined;
    if (typeof rec.name === "string")
        return rec.name;
    const fn = asRecord(rec.function);
    if (fn && typeof fn.name === "string")
        return fn.name;
    return undefined;
}
export function resolveToolChoice(tools, choice, opts = {}) {
    if (choice === "none" || asRecord(choice)?.type === "none") {
        return { tools: [], required: false };
    }
    const required = choice === "required" ||
        choice === "any" ||
        asRecord(choice)?.type === "any";
    const selected = namedChoice(choice);
    let resolved = [...tools];
    let instruction;
    if (selected) {
        const tool = tools.find((item) => item.name === selected);
        if (!tool)
            throw new Error(`Unknown tool_choice function: ${selected}`);
        resolved = [tool];
        instruction = `You must call the ${selected} tool.`;
    }
    else if (required) {
        instruction = "You must call at least one available tool.";
    }
    if (opts.parallelToolCalls === false && resolved.length > 0) {
        instruction = [instruction, "Call at most one tool at a time."]
            .filter(Boolean)
            .join(" ");
    }
    return {
        tools: resolved,
        required: required || selected !== undefined,
        ...(opts.parallelToolCalls === false ? { maxParallelToolCalls: 1 } : {}),
        ...(instruction ? { instruction } : {}),
    };
}
function stringifyOutput(value) {
    if (value == null)
        return "";
    if (typeof value === "string")
        return value;
    if (Array.isArray(value)) {
        const text = value
            .map((part) => {
            if (typeof part === "string")
                return part;
            const rec = asRecord(part);
            return rec?.type === "text" && typeof rec.text === "string"
                ? rec.text
                : "";
        })
            .filter(Boolean)
            .join("\n");
        if (text)
            return text;
    }
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
export function chatToolOutputs(messages) {
    const outputs = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = asRecord(messages[i]);
        if (!message || message.role !== "tool")
            break;
        if (typeof message.tool_call_id !== "string" || !message.tool_call_id) {
            throw new Error("Tool message is missing tool_call_id");
        }
        outputs.unshift({
            callId: message.tool_call_id,
            output: stringifyOutput(message.content),
        });
    }
    return outputs;
}
function toolCallId(item) {
    for (const key of ["call_id", "callId", "tool_call_id"]) {
        const value = item[key];
        if (typeof value === "string" && value)
            return value;
    }
    return undefined;
}
export function responsesToolOutputs(input) {
    if (!Array.isArray(input))
        return [];
    const outputs = [];
    for (const value of input) {
        const item = asRecord(value);
        if (!item || item.type !== "function_call_output")
            continue;
        const callId = toolCallId(item);
        // Codex Desktop often includes transcript tool results without a
        // client-tool call_id. Those belong in the prompt, not ACP resume.
        if (!callId)
            continue;
        outputs.push({
            callId,
            output: stringifyOutput(item.output),
        });
    }
    return outputs;
}

const TOOL_PLUMBING_TYPES = new Set([
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
    "local_shell_call",
    "local_shell_call_output",
]);

/** Desktop ran exec_command locally and is posting outputs; do not start a new Cursor turn. */
export function isDesktopExecFollowUp(body, outputs) {
    if (!Array.isArray(outputs) || outputs.length === 0)
        return false;
    const input = body?.input;
    if (!Array.isArray(input) || input.length === 0)
        return false;
    for (let i = input.length - 1; i >= 0; i -= 1) {
        const item = asRecord(input[i]);
        if (!item)
            continue;
        if (TOOL_PLUMBING_TYPES.has(item.type))
            continue;
        if (item.role === "user" || (item.type === "message" && item.role === "user"))
            return false;
        return true;
    }
    return true;
}
export function anthropicToolOutputs(messages) {
    const last = asRecord(messages[messages.length - 1]);
    if (!last || last.role !== "user" || !Array.isArray(last.content))
        return [];
    const outputs = [];
    for (const value of last.content) {
        const block = asRecord(value);
        if (!block || block.type !== "tool_result")
            continue;
        if (typeof block.tool_use_id !== "string" || !block.tool_use_id) {
            throw new Error("tool_result is missing tool_use_id");
        }
        outputs.push({
            callId: block.tool_use_id,
            output: stringifyOutput(block.content),
            isError: block.is_error === true,
        });
    }
    return outputs;
}
//# sourceMappingURL=tool-types.js.map