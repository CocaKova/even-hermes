// Pure translation of one Hermes turn (tui_gateway events) into the item / turn notifications a
// codex app-server client expects. No I/O: `emit(method, params)` is the only side effect.
import { randomUUID } from "node:crypto";

const newId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

const FILE_TOOL = /(^|_)(write|patch|edit)(_|$)|write_file|apply_patch/i;
const SEARCH_TOOL = /web_?search/i;
const SHELL_TOOL = /^(terminal|shell|bash|execute_command)$/i;
const QUIET_STATUS = new Set(["ready", "heartbeat"]); // idle chatter, not something a turn is waiting on

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
  // `tool.generating` names the tool before its args exist: pick the shape from the name alone so
  // the item keeps one type from the first indicator through completion.
  if (!done && !Object.keys(args).length) {
    if (SHELL_TOOL.test(name)) return { type: "commandExecution", id, command: "", status };
    if (SEARCH_TOOL.test(name)) return { type: "webSearch", id, query: "", status };
    if (FILE_TOOL.test(name)) return { type: "fileChange", id, status, changes: [] };
  }
  const path = args.path ?? args.file_path ?? args.filename;
  if (FILE_TOOL.test(name) && typeof path === "string") {
    return {
      type: "fileChange", id, status,
      changes: [{ path, kind: "update", diff: done ? String(payload?.inline_diff ?? "") : "" }],
    };
  }
  // Everything else: the HUD prints free text only for shell rows ("Shell <command>"), and a bare
  // "Mcp" says nothing about what ran, so the row carries a one-line label as its command.
  // A failed row looks like any other on the HUD, so the label says it.
  const item = { type: "commandExecution", id, command: `${failed ? "✗ " : ""}${toolLabel(name, args)}`, status };
  if (done) item.aggregatedOutput = stringify(payload?.summary ?? payload?.result_text ?? result);
  return item;
}

const LABEL_KEYS = ["query", "url", "path", "file_path", "goal", "prompt", "question", "skill", "name", "action", "text", "content"];
const LABEL_MAX = 50; // what the HUD keeps of a shell row

/** `tool_name telling-argument`, one line, sized for the HUD. */
export function toolLabel(name, args = {}) {
  const key = LABEL_KEYS.find((k) => typeof args[k] === "string" && args[k].trim())
    ?? Object.keys(args).find((k) => typeof args[k] === "string" && args[k].trim());
  const short = String(name).replace(/^mcp_/, "").replace(/^delegate_task$/, "delegate:");
  if (!key) return short;
  const value = args[key].replace(/^https?:\/\/(www\.)?/, "").replace(/\s+/g, " ").trim();
  const label = `${short} ${value}`;
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

/** True when a tool has no native HUD shape and rides a labeled row. */
const isLabeled = (payload) => {
  const args = payload?.args && typeof payload.args === "object" ? payload.args : {};
  const name = String(payload?.name ?? "tool");
  if (typeof args.command === "string" && args.command) return false;
  if (SEARCH_TOOL.test(name) && typeof args.query === "string") return false;
  if (SHELL_TOOL.test(name) && !Object.keys(args).length) return false;
  return !FILE_TOOL.test(name);
};

const family = (name) => (SHELL_TOOL.test(name) ? "shell" : SEARCH_TOOL.test(name) ? "search" : FILE_TOOL.test(name) ? "edit"
  : String(name).replace(/^mcp_/, "").split("_")[0] || "tool");

/** "⚙ 7 tools · 3 shell · 2 browser · 1 failed · 41s" */
export function recapLine(ran, seconds) {
  if (!ran.length) return "";
  const counts = new Map();
  for (const r of ran) counts.set(family(r.name), (counts.get(family(r.name)) ?? 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1]);
  const parts = [`${ran.length} tool${ran.length === 1 ? "" : "s"}`, ...groups.slice(0, 3).map(([f, n]) => `${n} ${f}`)];
  if (groups.length > 3) parts.push(`+${groups.length - 3} more`);
  const failed = ran.filter((r) => r.failed).length;
  if (failed) parts.push(`${failed} failed`);
  parts.push(`${Math.round(seconds)}s`);
  return `⚙ ${parts.join(" · ")}`;
}

export class TurnTranslator {
  /** opts.labelAt: "end" keeps a labeled row in progress until its tool finishes (the label shows
   *  then); "start" completes it as the tool starts so the label shows while the tool runs.
   *  opts.recap: append a one-line tool recap after the reply. */
  constructor(threadId, emit, opts = {}) {
    this.threadId = threadId;
    this.emit = emit;
    this.labelAt = opts.labelAt === "start" ? "start" : "end";
    this.recap = Boolean(opts.recap);
    this.ran = []; // { name, label, failed } per finished tool, for the recap and "what did you run"
    this.turnId = newId("turn");
    this.startedAt = Date.now() / 1000;
    this.items = [];
    this.open = null; // the streaming reasoning / agentMessage item, if any
    this.tools = new Map(); // hermes tool_id → item id
    this.generating = []; // { name, id } announced by tool.generating, not yet claimed by a tool.start
    this.status = null; // the in-progress status row, if any
    this.early = new Set(); // labeled rows already completed on the HUD at tool.start
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
    if (type !== "status.update" && type !== "thinking.delta") this.#closeStatus();
    switch (type) {
      case "thinking.delta":
        // The spinner line fires as each model call begins, before (or without) reasoning text:
        // it is the earliest honest "thinking" signal. Never split a reply that is mid-stream.
        if (!String(payload.text ?? "").trim()) return;
        this.#closeStatus(); // a new model call: whatever the status was waiting on is over
        if (!this.open) this.#openItem("reasoning");
        return;
      case "tool.generating": {
        this.#closeOpen();
        const pending = { name: String(payload.name ?? "tool"), id: newId("tool") };
        this.generating.push(pending);
        this.#started(toolItem(pending.id, { name: pending.name }, false));
        return;
      }
      case "status.update":
        this.#statusRow(String(payload.kind ?? "status"), String(payload.text ?? "").trim());
        return;
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
        const at = this.generating.findIndex((g) => g.name === String(payload.name ?? "tool"));
        const id = at === -1 ? newId("tool") : this.generating.splice(at, 1)[0].id;
        this.tools.set(String(payload.tool_id ?? id), id);
        this.#started(toolItem(id, payload, false));
        if (this.labelAt === "start" && isLabeled(payload)) {
          this.early.add(id);
          this.#completed({ ...toolItem(id, payload, false), status: "completed" });
        }
        return;
      }
      case "tool.complete": {
        const key = String(payload.tool_id ?? "");
        const id = this.tools.get(key) ?? newId("tool");
        if (!this.tools.has(key)) this.#started(toolItem(id, payload, false));
        this.tools.delete(key);
        const item = toolItem(id, payload, true);
        const name = String(payload.name ?? "tool");
        this.ran.push({ name, label: item.command?.replace(/^✗ /, "") ?? (item.query ? `search ${item.query}` : item.changes?.[0]?.path ? `edit ${item.changes[0].path}` : name), failed: item.status === "failed" });
        if (this.early.delete(id)) { // the HUD already closed this row; keep the snapshot truthful
          const idx = this.items.findIndex((i) => i.id === id);
          if (idx !== -1) this.items[idx] = item;
          return;
        }
        this.#completed(item);
        return;
      }
      case "error":
        this.emit("error", { threadId: this.threadId, turnId: this.turnId, error: { message: String(payload.message ?? payload.text ?? "Hermes error") } });
        return;
      case "message.complete":
        this.finish(payload);
        return;
      default:
        return; // usage ticks, session info: nothing a HUD needs
    }
  }

  finish(payload = {}) {
    if (this.done) return;
    this.#closeOpen();
    this.#closeStatus();
    const finalText = typeof payload.text === "string" ? payload.text.trim() : "";
    if (!this.sawText && finalText) {
      const item = { type: "agentMessage", id: newId("msg"), text: finalText };
      this.#started(item);
      this.#completed(item);
    }
    for (const id of [...this.tools.values(), ...this.generating.map((g) => g.id)]) {
      const item = this.items.find((i) => i.id === id);
      if (item && !this.early.has(id)) this.#completed({ ...item, status: "failed" });
    }
    const recap = this.recap ? recapLine(this.ran, Date.now() / 1000 - this.startedAt) : "";
    if (recap) {
      // The HUD concatenates a turn's messages, so the recap brings its own paragraph break.
      const item = { type: "agentMessage", id: newId("msg"), text: `\n\n${recap}` };
      this.#started(item);
      this.#completed(item);
    }
    this.tools.clear();
    this.generating = [];
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
    const body = this.open ? (kind === "reasoning" ? this.open.summary[0] : this.open.text) : "";
    if (!body) {
      text = text.replace(/^\s+/, ""); // models often lead a reply with blank lines
      if (!text) return;
    }
    if (!this.open) this.#openItem(kind);
    if (kind === "reasoning") {
      this.open.summary[0] += text;
      return;
    }
    this.sawText = true;
    this.open.text += text;
    this.emit("item/agentMessage/delta", { threadId: this.threadId, turnId: this.turnId, itemId: this.open.id, delta: text });
  }

  #openItem(kind) {
    this.open = kind === "reasoning"
      ? { type: "reasoning", id: newId("rsn"), summary: [""], content: [] }
      : { type: "agentMessage", id: newId("msg"), text: "" };
    this.#started(this.open);
  }

  /** Lifecycle status (compaction, provider recovery, warnings) as a tool-shaped row: the HUD has
   *  no free-text status channel, and a row that stays in progress reads as "busy", not "hung". */
  #statusRow(kind, text) {
    if (!text || QUIET_STATUS.has(kind) || QUIET_STATUS.has(text)) return;
    const command = toolLabel(kind === "status" ? "status:" : `${kind}:`, { text });
    if (this.status?.command === command) return;
    this.#closeStatus();
    this.status = { type: "commandExecution", id: newId("sts"), command, status: "inProgress" };
    this.#started(this.status);
  }

  #closeStatus() {
    if (!this.status) return;
    const item = { ...this.status, status: "completed" };
    this.status = null;
    this.#completed(item);
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
