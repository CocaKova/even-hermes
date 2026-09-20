// Pure translation of one Hermes turn (tui_gateway events) into the stream-json messages the Claude
// Agent SDK expects from a `claude` CLI. No I/O: `write(message)` is the only side effect.
//
// Even Terminal's Claude path shows a tool row as "<tool name> <input.description>", so unlike the
// codex path every Hermes tool keeps its own name on the HUD.
import { randomUUID } from "node:crypto";
import { recapLine, toolLabel } from "./translate.js";

const SHELL_TOOL = /^(terminal|shell|bash|execute_command)$/i;
const SEARCH_TOOL = /web_?search/i;
const QUIET_STATUS = new Set(["ready", "heartbeat"]);
const MODEL = "hermes";

const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

function resultText(payload) {
  const result = payload?.result;
  if (result && typeof result === "object") {
    const parts = [result.output, result.error].filter((s) => typeof s === "string" && s);
    if (parts.length) return parts.join("\n").slice(0, 4000);
  }
  const text = payload?.summary ?? payload?.result_text ?? result;
  if (text === undefined || text === null) return "";
  return (typeof text === "string" ? text : JSON.stringify(text)).slice(0, 4000);
}

const isFailure = (payload) => {
  const result = payload?.result;
  return Boolean(result && typeof result === "object"
    && (result.error || (typeof result.exit_code === "number" && result.exit_code !== 0)));
};

/** The Claude-side name and input that make Even Terminal print the most useful row. */
export function claudeTool(payload, failed = false) {
  const name = String(payload?.name ?? "tool").replace(/^mcp_/, "");
  const args = payload?.args && typeof payload.args === "object" ? payload.args : {};
  const mark = failed ? "✗ " : "";
  if (typeof args.command === "string" && args.command) {
    return { name: "Bash", input: { command: args.command, description: `${mark}${args.command}` } };
  }
  if (SHELL_TOOL.test(name)) return { name: "Bash", input: {} };
  if (SEARCH_TOOL.test(name)) return { name: "WebSearch", input: { query: `${mark}${args.query ?? ""}` } };
  // toolLabel is "name argument"; this path prints the name itself, so keep only the argument.
  const shown = name === "delegate_task" ? "delegate:" : name; // how toolLabel spells it
  const label = toolLabel(name, args);
  const detail = label.startsWith(`${shown} `) ? label.slice(shown.length + 1) : "";
  return { name: name === "delegate_task" ? "delegate" : name, input: { description: `${mark}${detail}`.trim(), arguments: args } };
}

export class ClaudeStream {
  /** opts: { labelAt: "end"|"start", recap: boolean, model } — see TurnTranslator. */
  constructor(sessionId, write, opts = {}) {
    this.sessionId = sessionId;
    this.write = write;
    this.labelAt = opts.labelAt === "start" ? "start" : "end";
    this.recap = Boolean(opts.recap);
    this.model = opts.model || MODEL;
    this.startedAt = Date.now();
    this.index = 0;
    this.open = null; // { kind: "thinking" | "text", index }
    this.tools = new Map(); // hermes tool_id → { id, payload, closed }
    this.generating = []; // { name, id } announced by tool.generating, not yet claimed
    this.status = null; // { id, payload }
    this.ran = [];
    this.text = "";
    this.calls = 0;
    this.done = false;
  }

  start() {
    this.#event({
      type: "message_start",
      message: { id: newId("msg"), type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } },
    });
  }

  handle(type, payload = {}) {
    if (this.done) return;
    if (type !== "status.update" && type !== "thinking.delta") this.#closeStatus();
    switch (type) {
      case "thinking.delta":
        if (!String(payload.text ?? "").trim()) return;
        this.#closeStatus();
        if (!this.open) this.#openBlock("thinking");
        return;
      case "reasoning.delta":
      case "reasoning.available":
        if (type === "reasoning.available" && this.text) return;
        if (!String(payload.text ?? "").trim() && this.open?.kind !== "thinking") return;
        if (this.open?.kind !== "thinking") this.#openBlock("thinking");
        return; // the HUD has no thinking-text channel; the indicator is the whole signal
      case "message.delta":
        this.#text(String(payload.text ?? ""));
        return;
      case "message.interim":
        if (!payload.already_streamed) this.#text(String(payload.text ?? ""));
        this.#closeBlock();
        return;
      case "tool.generating": {
        this.#closeBlock();
        const pending = { name: String(payload.name ?? "tool"), id: newId("toolu") };
        this.generating.push(pending);
        this.#toolStart(pending.id, claudeTool({ name: pending.name }).name);
        return;
      }
      case "tool.start": {
        this.#closeBlock();
        const at = this.generating.findIndex((g) => g.name === String(payload.name ?? "tool"));
        const claimed = at !== -1;
        const id = claimed ? this.generating.splice(at, 1)[0].id : newId("toolu");
        const tool = { id, payload, closed: false };
        this.tools.set(String(payload.tool_id ?? id), tool);
        if (!claimed) this.#toolStart(id, claudeTool(payload).name);
        if (this.labelAt === "start") this.#toolEnd(tool, payload, false);
        return;
      }
      case "tool.complete": {
        const key = String(payload.tool_id ?? "");
        let tool = this.tools.get(key);
        if (!tool) {
          tool = { id: newId("toolu"), payload, closed: false };
          this.#toolStart(tool.id, claudeTool(payload).name);
        }
        this.tools.delete(key);
        const failed = isFailure(payload);
        const shown = claudeTool(payload);
        this.ran.push({ name: String(payload.name ?? "tool"), failed, label: shown.input.command ?? (`${shown.name} ${shown.input.description ?? shown.input.query ?? ""}`).trim() });
        if (!tool.closed) this.#toolEnd(tool, payload, failed);
        return;
      }
      case "todo.updated":
        return; // surfaced by the shim as a TodoWrite permission round-trip (that is what feeds task progress)
      case "status.update": {
        const kind = String(payload.kind ?? "status");
        const text = String(payload.text ?? "").trim();
        if (!text || QUIET_STATUS.has(kind) || QUIET_STATUS.has(text)) return;
        if (this.status?.text === text) return;
        this.#closeStatus();
        const name = kind === "status" || kind === "lifecycle" ? "status" : kind;
        this.status = { id: newId("toolu"), text, name };
        this.#toolStart(this.status.id, name);
        return;
      }
      case "error":
        this.#text(`\n[${String(payload.message ?? payload.text ?? "Hermes error")}]\n`);
        return;
      case "message.complete":
        this.finish(payload);
        return;
      default:
        return;
    }
  }

  finish(payload = {}) {
    if (this.done) return;
    this.#closeStatus();
    const finalText = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!this.text && finalText) this.#text(finalText);
    this.#closeBlock();
    for (const tool of this.tools.values()) if (!tool.closed) this.#toolEnd(tool, { ...tool.payload, result: { error: "did not finish" } }, true);
    for (const g of this.generating) this.#toolEnd({ id: g.id }, { name: g.name, result: { error: "never ran" } }, true);
    this.tools.clear();
    this.generating = [];
    const seconds = (Date.now() - this.startedAt) / 1000;
    const recap = this.recap ? recapLine(this.ran, seconds) : "";
    if (recap) { this.#text(`\n\n${recap}`); this.#closeBlock(); }
    this.done = true;

    const usage = payload.usage ?? {};
    const input = Number(usage.input ?? usage.prompt ?? 0);
    const output = Number(usage.output ?? usage.completion ?? 0);
    this.#event({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: output } });
    this.#event({ type: "message_stop" });
    const interrupted = payload.status === "interrupted";
    const failed = payload.status === "error" || Boolean(payload.error);
    const result = {
      type: "result",
      subtype: interrupted || failed ? "error_during_execution" : "success",
      is_error: interrupted || failed,
      duration_ms: Math.round(seconds * 1000), duration_api_ms: 0,
      num_turns: Math.max(1, this.calls),
      result: this.text.trim(),
      session_id: this.sessionId,
      total_cost_usd: 0,
      usage: { input_tokens: input, output_tokens: output },
      modelUsage: { [this.model]: { inputTokens: input, outputTokens: output, costUSD: 0 } },
      permission_denials: [],
      uuid: randomUUID(),
    };
    if (interrupted) result.terminal_reason = "aborted_streaming";
    if (failed) result.errors = [String(payload.error ?? payload.failure_reason ?? payload.warning ?? "Turn failed")];
    this.write(result);
  }

  fail(message) {
    this.finish({ status: "error", error: message });
  }

  #text(text) {
    if (!text) return;
    if (this.open?.kind !== "text") {
      if (!this.text) text = text.replace(/^\s+/, "");
      if (!text) return;
      this.#openBlock("text");
    }
    this.text += text;
    this.#event({ type: "content_block_delta", index: this.open.index, delta: { type: "text_delta", text } });
  }

  #openBlock(kind) {
    this.#closeBlock();
    this.open = { kind, index: this.index++ };
    if (kind === "thinking") this.calls++;
    this.#event({
      type: "content_block_start", index: this.open.index,
      content_block: kind === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
    });
  }

  #closeBlock() {
    if (!this.open) return;
    this.#event({ type: "content_block_stop", index: this.open.index });
    this.open = null;
  }

  #toolStart(id, name) {
    const index = this.index++;
    this.#event({ type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } });
    this.#event({ type: "content_block_stop", index });
  }

  /** The assistant/user pair that makes Even Terminal print the finished row. */
  #toolEnd(tool, payload, failed, shown = claudeTool(payload, failed)) {
    tool.closed = true;
    this.write({
      type: "assistant", session_id: this.sessionId, parent_tool_use_id: null, uuid: randomUUID(),
      message: { id: newId("msg"), type: "message", role: "assistant", model: this.model, content: [{ type: "tool_use", id: tool.id, name: shown.name, input: shown.input }], stop_reason: "tool_use", usage: { input_tokens: 0, output_tokens: 0 } },
    });
    this.write({
      type: "user", session_id: this.sessionId, parent_tool_use_id: null, uuid: randomUUID(),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: resultText(payload), is_error: failed }] },
    });
  }

  #closeStatus() {
    if (!this.status) return;
    const { id, text, name } = this.status;
    this.status = null;
    this.#toolEnd({ id }, {}, false, { name, input: { description: text } });
  }

  #event(event) {
    this.write({ type: "stream_event", event, session_id: this.sessionId, parent_tool_use_id: null, uuid: randomUUID() });
  }
}
