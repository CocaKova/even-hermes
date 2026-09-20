// Entry point for the fake `claude` binary that Even Terminal's Claude provider spawns through the
// Claude Agent SDK. It speaks the SDK's stream-json protocol on stdio and runs the turn on Hermes.
//
// It NEVER forwards to a real Claude Code CLI: the whole point is that picking "Claude" in the Even
// app must not reach (or bill) an Anthropic account.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { ClaudeStream } from "./claude-stream.js";
import { CONFIG_DIR, loadConfig } from "./config.js";
import { HermesClient } from "./hermes-client.js";
import { localScript } from "./local-turns.js";
import { VERSION } from "./shim-main.js";

const log = (text) => process.stderr.write(`[even-hermes] ${text}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

/** Where the Agent SDK inside Even Terminal looks for transcripts (the launcher points it here). */
export const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(CONFIG_DIR, "claude-home");
const STORE = () => join(CONFIG_DIR, "claude-sessions.json");

function loadStore() {
  try { return JSON.parse(readFileSync(STORE(), "utf8")); } catch { return {}; }
}

function saveSession(id, entry) {
  const store = loadStore();
  store[id] = { ...store[id], ...entry };
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STORE(), JSON.stringify(store, null, 2), { mode: 0o600 });
}

/** Append one message to the session transcript the SDK lists and replays on the glasses. */
function record(sessionId, cwd, role, text, parentUuid) {
  const dir = join(claudeHome(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const uuid = randomUUID();
  appendFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({
    parentUuid, isSidechain: false, type: role, uuid, sessionId, cwd, timestamp: new Date().toISOString(),
    userType: "external", version: VERSION,
    message: role === "user"
      ? { role, content: [{ type: "text", text }] }
      : { id: `msg_${uuid}`, type: "message", role, model: "hermes", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } },
  })}\n`);
  return uuid;
}

class Shim {
  constructor(argv) {
    this.resume = argv.includes("--resume") ? argv[argv.indexOf("--resume") + 1] : "";
    this.cwd = process.cwd();
    this.config = loadConfig();
    this.hermes = null;
    this.stream = null;
    this.runtimeId = null;
    this.waiting = new Map(); // control request id → resolve
    this.queue = Promise.resolve();
  }

  onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.type === "control_request") return this.#control(msg);
    if (msg.type === "control_response") {
      const id = msg.response?.request_id;
      const resolve = this.waiting.get(id);
      this.waiting.delete(id);
      return resolve?.(msg.response?.subtype === "success" ? msg.response.response ?? {} : null);
    }
    if (msg.type === "user") {
      const content = msg.message?.content;
      const text = (typeof content === "string" ? content : (Array.isArray(content) ? content : [])
        .filter((part) => part?.type === "text").map((part) => part.text).join("\n")).trim();
      if (text) this.queue = this.queue.then(() => this.#turn(text)).catch((err) => this.#crash(err));
    }
  }

  #control(msg) {
    const subtype = msg.request?.subtype;
    const ok = (response = {}) => send({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response } });
    if (subtype === "initialize") {
      return ok({ commands: [], output_style: "default", available_output_styles: ["default"], models: [], account: {} });
    }
    if (subtype === "interrupt") {
      if (this.local) { this.local(); this.local = null; }
      else if (this.runtimeId) this.hermes.call("session.interrupt", { session_id: this.runtimeId }).catch((err) => log(`interrupt failed: ${err.message}`));
      return ok();
    }
    return ok();
  }

  /** Ask the SDK side (Even Terminal's canUseTool) something; resolves null if it refuses to answer. */
  #ask(toolName, input) {
    const requestId = randomUUID();
    send({ type: "control_request", request_id: requestId, request: { subtype: "can_use_tool", tool_name: toolName, input, permission_suggestions: [], tool_use_id: `toolu_${requestId.replace(/-/g, "").slice(0, 20)}` } });
    return new Promise((resolve) => this.waiting.set(requestId, resolve));
  }

  async #turn(text) {
    const store = loadStore();
    const known = this.resume ? store[this.resume] : null;
    const sessionId = this.sessionId ?? (known ? this.resume : randomUUID());
    this.sessionId = sessionId;
    send({ type: "system", subtype: "init", session_id: sessionId, cwd: this.cwd, tools: [], mcp_servers: [], model: "hermes", permissionMode: "default", slash_commands: [], apiKeySource: "none", output_style: "default", uuid: randomUUID() });

    const stream = new ClaudeStream(sessionId, send, this.config.hud);
    this.stream = stream;
    const entry = loadStore()[sessionId] ?? {};
    const userUuid = record(sessionId, this.cwd, "user", text, entry.leaf ?? null);
    const seal = () => {
      const leaf = stream.text.trim() ? record(sessionId, this.cwd, "assistant", stream.text.trim(), userUuid) : userUuid;
      saveSession(sessionId, { leaf, lastRun: stream.local ? entry.lastRun : stream.ran, cwd: this.cwd });
    };

    const script = localScript(text, entry.lastRun);
    if (script) return this.#playLocal(stream, script, seal);

    this.hermes = new HermesClient(this.config.gateway, log);
    const finished = new Promise((resolve) => { this.turnDone = resolve; });
    let early = [];
    this.hermes.on("event", (evt) => {
      if (early) return early.push(evt);
      this.#onEvent(evt);
    });
    this.hermes.on("request", (id, method, params) => this.#onRequest(id, method, params));
    this.hermes.on("down", (reason) => { if (!stream.done) { stream.fail(`Lost the connection to Hermes mid-turn (${reason}). The turn may still finish there.`); this.turnDone(); } });

    const s = this.config.session;
    try {
      if (entry.hermesId) {
        const res = await this.hermes.call("session.resume", { session_id: entry.hermesId, lazy: true, source: s.source || "even-terminal" }, 120000);
        this.runtimeId = res.session_id;
      } else {
        const create = { source: s.source || "even-terminal", cwd: this.cwd };
        if (s.profile) create.profile = s.profile;
        if (s.model) create.model = s.model;
        if (s.reasoningEffort) create.reasoning_effort = s.reasoningEffort;
        const res = await this.hermes.call("session.create", create);
        this.runtimeId = res.session_id;
        saveSession(sessionId, { hermesId: String(res.stored_session_id || res.session_id), cwd: this.cwd });
      }
      stream.start();
      const note = s.firstPromptNote;
      await this.hermes.call("prompt.submit", { session_id: this.runtimeId, text: !entry.noted && note ? `${note}\n\n${text}` : text });
      saveSession(sessionId, { noted: true });
    } catch (err) {
      if (!stream.done) { if (!stream.index) stream.start(); stream.fail(`Could not reach Hermes: ${err.message}`); }
      seal();
      return this.#exit();
    }
    for (const evt of early) this.#onEvent(evt);
    early = null;
    if (!stream.done) await finished;
    seal();
    await this.hermes.call("session.close", { session_id: this.runtimeId }, 5000).catch(() => {});
    this.#exit();
  }

  #onEvent(evt) {
    const type = String(evt?.type ?? "");
    if (this.stream.done || String(evt?.session_id ?? "") !== this.runtimeId) return;
    if (type === "todo.updated") this.#todos(evt.payload);
    this.stream.handle(type, evt.payload ?? {});
    if (this.stream.done) this.turnDone();
  }

  /** Even Terminal turns a TodoWrite permission round-trip into its task-progress display. */
  #todos(payload) {
    const todos = (Array.isArray(payload?.todos) ? payload.todos : []).map((t) => ({
      content: String(t?.content ?? t?.title ?? t?.text ?? ""), activeForm: String(t?.content ?? t?.title ?? t?.text ?? ""),
      status: ["completed", "in_progress"].includes(t?.status) ? t.status : t?.status === "done" ? "completed" : "pending",
    }));
    if (todos.length) this.#ask("TodoWrite", { todos });
  }

  async #onRequest(hermesId, method, params) {
    if (this.runtimeId && String(params?.session_id ?? "") !== this.runtimeId) return;
    if (method === "approval") {
      const command = String(params.command || params.description || params.tool_name || "Hermes action");
      const answer = await this.#ask("Bash", { command, description: String(params.description || command) });
      return this.hermes.respond(hermesId, { choice: answer?.behavior === "allow" ? "once" : "deny" });
    }
    if (method === "clarify") {
      const batch = Array.isArray(params.questions) && params.questions.length > 0;
      const asked = batch ? params.questions : [{ qid: "q1", question: params.question, choices: params.choices }];
      const questions = asked.map((q) => ({
        question: String(q.question ?? ""), header: "Hermes asks", multiSelect: false,
        options: (q.choices ?? []).map((label) => ({ label: String(label), description: "" })),
      }));
      const answer = await this.#ask("AskUserQuestion", { questions });
      const answers = answer?.updatedInput?.answers ?? {};
      const pick = (q, i) => String(answers[q.question] ?? answers[String(i)] ?? "");
      if (batch) return this.hermes.respond(hermesId, { answers: Object.fromEntries(asked.map((q, i) => [String(q.qid), pick(questions[i], i)])) });
      return this.hermes.respond(hermesId, { answer: pick(questions[0], 0) });
    }
    // sudo / secret / vault prompts cannot be answered from a HUD.
    log(`declining unsupported Hermes request: ${method}`);
    return this.hermes.respond(hermesId, { value: "" });
  }

  #playLocal(stream, script, seal) {
    stream.local = true;
    Object.assign(stream, { recap: script.hud?.recap ?? stream.recap, labelAt: script.hud?.labelAt ?? stream.labelAt });
    stream.start();
    return new Promise((resolve) => {
      const timers = [];
      const end = () => { timers.forEach(clearTimeout); seal(); resolve(); this.#exit(); };
      this.local = () => { stream.finish({ status: "interrupted" }); end(); };
      let at = 0;
      for (const [delay, type, payload] of script.events) {
        timers.push(setTimeout(() => {
          if (stream.done) return;
          if (type === "todo.updated") this.#todos(payload);
          stream.handle(type, payload);
          if (stream.done) end();
        }, at += delay));
      }
    });
  }

  #crash(err) {
    log(`turn crashed: ${err.stack || err.message}`);
    if (this.stream && !this.stream.done) this.stream.fail(`even-hermes error: ${err.message}`);
    this.#exit(1);
  }

  #exit(code = 0) {
    this.hermes?.close();
    // Let stdout drain before leaving: the SDK reads the result from the pipe.
    process.stdout.write("", () => process.exit(code));
  }
}

export async function main(argv) {
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(`${VERSION} (even-hermes: Hermes Agent behind the Claude provider)`);
    return;
  }
  if (!argv.includes("stream-json")) {
    log("this `claude` is the even-hermes shim: it only serves Even Terminal's Claude provider and never runs the real Claude Code.");
    process.exit(2);
  }
  const shim = new Shim(argv);
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => shim.onLine(line));
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}
