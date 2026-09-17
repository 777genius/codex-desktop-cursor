/**
 * Codex Desktop / Mixin custom Responses contract:
 * created (this response id) → optional deltas → exactly one terminal
 * (response.completed or response.failed) with the same id and output: [].
 * Then data: [DONE]. Nothing after the terminal.
 */

export function parseSse(text) {
    const events = [];
    const chunks = String(text || "").split("\n\n");
    for (const chunk of chunks) {
        const lines = chunk.split("\n");
        let event = "";
        const dataLines = [];
        for (const line of lines) {
            if (line.startsWith(":"))
                throw new Error(`sse comment is not a Responses event: ${line}`);
            if (line.startsWith("event:"))
                event = line.slice(6).trim();
            else if (line.startsWith("data:"))
                dataLines.push(line.slice(5).trimStart());
        }
        const raw = dataLines.join("\n");
        if (!raw)
            continue;
        if (raw === "[DONE]") {
            events.push({ event: "done", data: "[DONE]" });
            continue;
        }
        let data;
        try {
            data = JSON.parse(raw);
        }
        catch (err) {
            throw new Error(`invalid upstream SSE JSON: ${raw.slice(0, 80)}`);
        }
        events.push({ event: event || data.type, data });
    }
    return events;
}

export function assertResponsesTerminal(events, responseId) {
    if (!Array.isArray(events) || events.length === 0)
        throw new Error("empty SSE");
    const created = events.find((e) => e.event === "response.created");
    if (!created)
        throw new Error("missing response.created");
    const createdId = created.data?.response?.id || created.data?.id;
    if (createdId !== responseId)
        throw new Error(`created id ${createdId} != ${responseId}`);
    const terminals = events.filter((e) => e.event === "response.completed" || e.event === "response.failed");
    if (terminals.length !== 1)
        throw new Error(`expected 1 terminal, got ${terminals.length}: ${terminals.map((e) => e.event).join(",")}`);
    const term = terminals[0];
    const termId = term.data?.response?.id;
    if (termId !== responseId)
        throw new Error(`terminal id ${termId} != ${responseId}`);
    const output = term.data?.response?.output;
    if (!Array.isArray(output))
        throw new Error("custom completed response output must be an array");
    const termIndex = events.indexOf(term);
    const doneIndex = events.findIndex((e) => e.event === "done");
    if (doneIndex < 0)
        throw new Error("missing data: [DONE]");
    if (doneIndex < termIndex)
        throw new Error("[DONE] before terminal");
    const after = events.slice(termIndex + 1).filter((e) => e.event !== "done");
    if (after.length)
        throw new Error(`events after terminal: ${after.map((e) => e.event).join(",")}`);
    return term.event;
}
