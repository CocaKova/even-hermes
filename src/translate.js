// Pure translation of one Hermes turn (tui_gateway events) into the item / turn notifications a
// codex app-server client expects. No I/O: `emit(method, params)` is the only side effect.
import { randomUUID } from "node:crypto";

const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

const FILE_TOOL = /(^|_)(write|patch|edit)(_|$)|write_file|apply_patch/i;
const SEARCH_TOOL = /web_?search/i;

function stringify(value, max = 4000) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Shape a Hermes tool call as the closest codex thread item. */
export function toolItem(id, payload, done) {
  const name = String(payload?.name ?? "tool");
  const args = payload?.args && typeof payload.args === "object" ? payload.args : {};
  const result = payload?.result;
  const failed = done && result && typeof result === "object"
    && (Boolean(result.error) || (typeof result.exit_code === "number" && result.exit_code !== 0));
  const status = !done ? "inProgress" : failed ? "failed" : "completed";

  if (typeof args.command === "string" && args.command) {
    const item = { type: "commandExecution", id, command: args.command, status };
    if (typeof args.workdir === "string") item.cwd = args.workdir;
    if (done) {
      const out = result && typeof result === "object"
        ? [result.output, result.error].filter((s) => typeof s === "string" && s).join("\n")
        : stringify(payload?.result_text ?? result);
      item.aggregatedOutput = stringify(out);
      if (typeof result?.exit_code === "number") item.exitCode = result.exit_code;
    }
    return item;
  }
  if (SEARCH_TOOL.test(name) && typeof args.query === "string") {
    return { type: "webSearch", id, query: args.query, status };
  }
  const path = args.path ?? args.file_path ?? args.filename;
  if (FILE_TOOL.test(name) && typeof path === "string") {
    return {
      type: "fileChange", id, status,
      changes: [{ path, kind: "update", diff: done ? String(payload?.inline_diff ?? "") : "" }],
    };
  }
  const item = { type: "mcpToolCall", id, server: "hermes", tool: name, arguments: args, status };
  if (done) item.result = stringify(payload?.summary ?? payload?.result_text ?? result);
  return item;
}

export class TurnTranslator {
  constructor(threadId, emit) {
    this.threadId = threadId;
    this.emit = emit;
    this.turnId = newId("turn");
    this.startedAt = Date.now() / 1000;
    this.items = [];
    this.open = null; // the streaming reasoning / agentMessage item, if any
    this.tools = new Map(); // hermes tool_id → item id
    this.sawText = false;
    this.done = false;
  }

  snapshot(status = this.done ? "completed" : "inProgress") {
    return { id: this.turnId, status, startedAt: this.startedAt, items: this.items };
  }

  start(userText) {
    this.emit("thread/status/changed", { threadId: this.threadId, status: { type: "active" } });
    this.emit("turn/started", { threadId: this.threadId, turn: this.snapshot() });
    const item = { type: "userMessage", id: newId("msg"), content: [{ type: "text", text: userText }] };
    this.#started(item);
    this.#completed(item);
  }

  handle(type, payload = {}) {
    if (this.done) return;
    switch (type) {
      case "reasoning.delta":
      case "reasoning.available":
        if (type === "reasoning.available" && this.sawText) return; // trailing recap of a streamed reply
        this.#stream("reasoning", String(payload.text ?? ""));
        return;
      case "message.delta":
        this.#stream("agentMessage", String(payload.text ?? ""));
        return;
      case "message.interim":
        if (!payload.already_streamed) this.#stream("agentMessage", String(payload.text ?? ""));
        this.#closeOpen();
        return;
      case "tool.start": {
        this.#closeOpen();
        const id = newId("tool");
        this.tools.set(String(payload.tool_id ?? id), id);
        this.#started(toolItem(id, payload, false));
        return;
      }
      case "tool.complete": {
        const key = String(payload.tool_id ?? "");
        const id = this.tools.get(key) ?? newId("tool");
        if (!this.tools.has(key)) this.#started(toolItem(id, payload, false));
        this.tools.delete(key);
        this.#completed(toolItem(id, payload, true));
        return;
      }
      case "error":
        this.emit("error", { threadId: this.threadId, turnId: this.turnId, error: { message: String(payload.message ?? payload.text ?? "Hermes error") } });
        return;
      case "message.complete":
        this.finish(payload);
        return;
      default:
        return; // status lines, usage ticks, kaomoji "thinking" spinners: nothing a HUD needs
    }
  }

  finish(payload = {}) {
    if (this.done) return;
    this.#closeOpen();
    const finalText = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!this.sawText && finalText) {
      const item = { type: "agentMessage", id: newId("msg"), text: finalText };
      this.#started(item);
      this.#completed(item);
    }
    for (const [, id] of this.tools) {
      const item = this.items.find((i) => i.id === id);
      if (item) this.#completed({ ...item, status: "failed" });
    }
    this.tools.clear();
    this.done = true;
    const status = payload.status === "interrupted" ? "interrupted"
      : payload.status === "error" || payload.error ? "failed" : "completed";
    const usage = payload.usage ?? {};
    const turn = {
      ...this.snapshot(status),
      completedAt: Date.now() / 1000,
      usage: { inputTokens: Number(usage.input ?? usage.prompt ?? 0), outputTokens: Number(usage.output ?? usage.completion ?? 0) },
    };
    if (status === "failed") turn.error = { message: String(payload.error ?? payload.failure_reason ?? payload.warning ?? "Turn failed") };
    this.emit("turn/completed", { threadId: this.threadId, turn: { ...turn, items: [] } });
    this.emit("thread/status/changed", { threadId: this.threadId, status: { type: "idle" } });
  }

  fail(message) {
    this.finish({ status: "error", error: message });
  }

  #stream(kind, text) {
    if (!text) return;
    if (this.open && this.open.type !== kind) this.#closeOpen();
    if (!this.open) {
      text = text.replace(/^\s+/, ""); // models often lead a reply with blank lines
      if (!text) return;
      this.open = kind === "reasoning"
        ? { type: "reasoning", id: newId("rsn"), summary: [""], content: [] }
        : { type: "agentMessage", id: newId("msg"), text: "" };
      this.#started(this.open);
    }
    if (kind === "reasoning") {
      this.open.summary[0] += text;
      return;
    }
    this.sawText = true;
    this.open.text += text;
    this.emit("item/agentMessage/delta", { threadId: this.threadId, turnId: this.turnId, itemId: this.open.id, delta: text });
  }

  #closeOpen() {
    if (!this.open) return;
    const item = this.open;
    this.open = null;
    this.#completed(item);
  }

  #started(item) {
    this.items.push(item);
    this.emit("item/started", { threadId: this.threadId, turnId: this.turnId, item });
  }

  #completed(item) {
    const idx = this.items.findIndex((i) => i.id === item.id);
    if (idx !== -1) this.items[idx] = item;
    this.emit("item/completed", { threadId: this.threadId, turnId: this.turnId, item });
  }
}

/** Group a projected Hermes transcript into codex-style turns (one per user message). */
export function transcriptToTurns(messages, firstPromptNote = "") {
  const turns = [];
  let current = null;
  for (const [i, m] of (messages ?? []).entries()) {
    let text = typeof m?.text === "string" ? m.text.trim() : "";
    if (firstPromptNote && m?.role === "user" && text.startsWith(firstPromptNote)) text = text.slice(firstPromptNote.length).trim();
    if (m?.display_kind === "hidden") continue;
    if (m?.role === "user") {
      current = { id: `hist_${i}`, status: "completed", items: [] };
      turns.push(current);
      if (text) current.items.push({ type: "userMessage", id: `hist_${i}_u`, content: [{ type: "text", text }] });
    } else if (m?.role === "assistant" && text) {
      if (!current) { current = { id: `hist_${i}`, status: "completed", items: [] }; turns.push(current); }
      current.items.push({ type: "agentMessage", id: `hist_${i}_a`, text });
    }
  }
  return turns;
}
