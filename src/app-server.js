// A `codex app-server` look-alike. Even Terminal believes it is driving Codex; every thread is a
// Hermes session and every turn is a Hermes `prompt.submit`. Hermes keeps running its own tools,
// skills and memory — this process only relays what happens.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { CONFIG_DIR } from "./config.js";
import { HermesRpcError } from "./hermes-client.js";
import { localScript } from "./local-turns.js";
import { TurnTranslator, transcriptToTurns } from "./translate.js";

const THREAD_NOT_FOUND = -32004;
const STATE_PATH = join(CONFIG_DIR, "threads.json");
const MAX_HISTORY_TURNS = 40;

class RpcError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export class AppServer {
  constructor({ hermes, config, log = () => {}, version = "0.0.0" }) {
    this.hermes = hermes;
    this.config = config;
    this.log = log;
    this.version = version;
    this.clients = new Set();
    this.threads = new Map();   // threadId (stored Hermes session id) → thread record
    this.byRuntime = new Map(); // live Hermes runtime session id → threadId
    this.requests = new Map();  // our server-request id → { hermesId, method, threadId, params }
    this.nextRequestId = 1;
    this.meta = loadState();

    hermes.on("event", (evt) => this.#onHermesEvent(evt));
    hermes.on("request", (id, method, params) => this.#onHermesRequest(id, method, params));
    hermes.on("down", (reason) => this.#onHermesDown(reason));
  }

  listen(host, port) {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ host, port });
      this.wss.once("error", reject);
      this.wss.once("listening", () => resolve(this.wss.address()));
      this.wss.on("connection", (ws) => this.#onClient(ws));
    });
  }

  close() {
    for (const ws of this.clients) ws.close();
    this.wss?.close();
  }

  // ── codex client side ────────────────────────────────────────────────────────────────────────

  #onClient(ws) {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));
    ws.on("message", (data) => {
      for (const line of data.toString().split("\n")) {
        if (line.trim()) this.#onClientLine(ws, line);
      }
    });
  }

  async #onClientLine(ws, line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg?.method !== "string") {
      if (msg?.id !== undefined) this.#onClientResponse(msg);
      return;
    }
    if (msg.id === undefined || msg.id === null) return; // `initialized` and other notifications
    try {
      const result = await this.#dispatch(msg.method, msg.params ?? {});
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    } catch (err) {
      const code = err instanceof RpcError ? err.code : -32000;
      if (!(err instanceof RpcError)) this.log(`${msg.method} failed: ${err.message}`);
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message: err.message } }));
    }
  }

  #notify(method, params) {
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(frame);
  }

  async #dispatch(method, params) {
    switch (method) {
      case "initialize":
        return { userAgent: `even-hermes/${this.version}` };
      case "account/get":
        return { account: { type: "hermes", email: this.model || "Hermes Agent", planType: this.config.gateway.mode } };
      case "thread/list":
        return this.#threadList(params);
      case "thread/read":
        return { thread: await this.#threadRead(String(params.threadId ?? ""), params.includeTurns === true) };
      case "thread/turns/list":
        return this.#turnsList(String(params.threadId ?? ""));
      case "thread/start":
        return { thread: await this.#threadStart(params) };
      case "thread/resume":
        return this.#threadResume(params);
      case "turn/start":
        return { turn: await this.#turnStart(params) };
      case "turn/interrupt":
        return this.#turnInterrupt(String(params.threadId ?? ""));
      case "thread/unsubscribe":
        return this.#threadUnsubscribe(String(params.threadId ?? ""));
      default:
        throw new RpcError(-32601, `Method not supported by even-hermes: ${method}`);
    }
  }

  // ── threads ──────────────────────────────────────────────────────────────────────────────────

  #wire(thread, extra = {}) {
    return {
      id: thread.id,
      name: thread.title || null,
      preview: thread.preview || thread.title || "Hermes session",
      cwd: thread.cwd || "",
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt ?? thread.createdAt,
      status: { type: thread.turn && !thread.turn.done ? "active" : "idle" },
      ...extra,
    };
  }

  #remember(id, fields) {
    let thread = this.threads.get(id);
    if (!thread) {
      const saved = this.meta[id] ?? {};
      thread = { id, cwd: saved.cwd ?? "", createdAt: saved.createdAt ?? Date.now() / 1000, runtimeId: null, turn: null, history: null, noted: Boolean(saved.noted) };
      this.threads.set(id, thread);
    }
    Object.assign(thread, fields);
    return thread;
  }

  #persist(thread) {
    this.meta[thread.id] = { cwd: thread.cwd, createdAt: thread.createdAt, noted: thread.noted };
    saveState(this.meta);
  }

  async #threadList(params) {
    const limit = Math.min(Number(params.limit) || this.config.listLimit, 100);
    const { sessions = [] } = await this.hermes.call("session.list", this.#profiled({ limit }));
    const data = sessions.map((row) => {
      const thread = this.#remember(String(row.id), {
        title: row.title || "", preview: row.preview || "",
        createdAt: row.started_at || Date.now() / 1000,
      });
      // Hermes sessions are not tied to a directory; report the one the caller is browsing so
      // directory-scoped pickers still show every conversation.
      return this.#wire(thread, { cwd: thread.cwd || params.cwd || "" });
    });
    return { data, nextCursor: null };
  }

  async #threadRead(threadId, includeTurns) {
    if (!threadId) throw new RpcError(THREAD_NOT_FOUND, "thread not found: (empty id)");
    if (!this.threads.has(threadId) || !this.threads.get(threadId).title) {
      await this.#threadList({ limit: 100 });
    }
    const thread = this.threads.get(threadId);
    if (!thread) throw new RpcError(THREAD_NOT_FOUND, `thread not found: ${threadId}`);
    return this.#wire(thread, includeTurns ? { turns: await this.#history(thread) } : {});
  }

  async #turnsList(threadId) {
    const thread = this.threads.get(threadId) ?? this.#remember(threadId, {});
    const turns = await this.#history(thread);
    return { data: [...turns].reverse(), nextCursor: null, backwardsCursor: null };
  }

  async #history(thread) {
    if (!thread.history) await this.#ensureLive(thread);
    const turns = [...(thread.history ?? [])];
    if (thread.turn) turns.push(thread.turn.snapshot());
    return turns.slice(-MAX_HISTORY_TURNS);
  }

  async #threadStart(params) {
    const cwd = typeof params.cwd === "string" ? params.cwd : "";
    const s = this.config.session;
    const create = this.#profiled({ source: s.source || "even-terminal" });
    if (cwd) create.cwd = cwd;
    if (s.model) create.model = s.model;
    if (s.reasoningEffort) create.reasoning_effort = s.reasoningEffort;
    const res = await this.hermes.call("session.create", create);
    const id = String(res.stored_session_id || res.session_id);
    const thread = this.#remember(id, { cwd, runtimeId: res.session_id, history: [], createdAt: Date.now() / 1000 });
    this.byRuntime.set(res.session_id, id);
    this.model = res.info?.model || this.model;
    this.#persist(thread);
    this.log(`thread ${id} started (runtime ${res.session_id})`);
    return this.#wire(thread);
  }

  async #threadResume(params) {
    const threadId = String(params.threadId ?? "");
    const thread = this.threads.get(threadId) ?? this.#remember(threadId, {});
    await this.#ensureLive(thread);
    if (typeof params.cwd === "string" && params.cwd && !thread.cwd) {
      thread.cwd = params.cwd;
      this.#persist(thread);
    }
    const result = { thread: this.#wire(thread) };
    if (params.initialTurnsPage) {
      result.initialTurnsPage = { data: thread.turn && !thread.turn.done ? [thread.turn.snapshot()] : [], nextCursor: null };
    } else if (!params.excludeTurns) {
      result.thread.turns = await this.#history(thread);
    }
    return result;
  }

  /** Attach to the stored Hermes session (cheap when already live on this connection). */
  async #ensureLive(thread) {
    if (thread.runtimeId) return thread.runtimeId;
    let res;
    try {
      res = await this.hermes.call("session.resume", { session_id: thread.id, lazy: true, source: this.config.session.source || "even-terminal" }, 120000);
    } catch (err) {
      if (err instanceof HermesRpcError) throw new RpcError(THREAD_NOT_FOUND, `thread not found: ${thread.id} (${err.message})`);
      throw err;
    }
    thread.runtimeId = res.session_id;
    thread.history = transcriptToTurns(res.messages, this.config.session.firstPromptNote);
    thread.noted = thread.noted || thread.history.length > 0;
    this.byRuntime.set(res.session_id, thread.id);
    this.model = res.info?.model || this.model;
    this.log(`thread ${thread.id} resumed (runtime ${res.session_id}, ${thread.history.length} turns)`);
    return thread.runtimeId;
  }

  // ── turns ────────────────────────────────────────────────────────────────────────────────────

  async #turnStart(params) {
    const threadId = String(params.threadId ?? "");
    const thread = this.threads.get(threadId);
    if (!thread) throw new RpcError(THREAD_NOT_FOUND, `thread not found: ${threadId}`);
    if (thread.turn && !thread.turn.done) throw new RpcError(-32001, "a turn is already running on this thread");
    const text = (Array.isArray(params.input) ? params.input : [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text).join("\n").trim();
    if (!text) throw new RpcError(-32602, "turn/start needs a text input");
    const script = localScript(text, thread.lastRun);
    if (script) return this.#playLocal(thread, text, script);

    const note = this.config.session.firstPromptNote;
    const outgoing = !thread.noted && note ? `${note}\n\n${text}` : text;
    const submit = async () => this.hermes.call("prompt.submit", { session_id: await this.#ensureLive(thread), text: outgoing });
    // Hermes can start streaming before `prompt.submit` returns; hold those events until the
    // client has the turn id, then replay them in order.
    thread.early = [];
    try {
      try {
        await submit();
      } catch (err) {
        if (!(err instanceof HermesRpcError)) throw err;
        // The runtime id went stale (gateway restarted, session reaped): re-attach once.
        this.byRuntime.delete(thread.runtimeId);
        thread.runtimeId = null;
        await submit();
      }
    } catch (err) {
      thread.early = null;
      throw err;
    }
    thread.noted = true;
    thread.updatedAt = Date.now() / 1000;
    if (!thread.preview) thread.preview = text.slice(0, 80);
    this.#persist(thread);

    const turn = new TurnTranslator(threadId, (method, p) => this.#notify(method, p), this.config.hud);
    thread.turn = turn;
    // The reply must reach the client before the turn's first notification.
    setImmediate(() => {
      const early = thread.early ?? [];
      thread.early = null;
      turn.start(text);
      for (const evt of early) turn.handle(evt.type, evt.payload ?? {});
      if (turn.done) this.#sealTurn(thread);
    });
    return { id: turn.turnId, status: "inProgress", items: [] };
  }

  /** A turn answered by the bridge itself (HUD demo, tool replay): Hermes never sees it. */
  #playLocal(thread, text, script) {
    const turn = new TurnTranslator(thread.id, (method, p) => this.#notify(method, p), { ...this.config.hud, ...script.hud });
    turn.local = true;
    thread.turn = turn;
    thread.localTimers = [];
    let at = 0;
    const step = (delay, fn) => thread.localTimers.push(setTimeout(() => {
      if (turn.done) return;
      fn();
      if (turn.done) this.#sealTurn(thread);
    }, at += delay));
    step(0, () => turn.start(text));
    for (const [delay, type, payload] of script.events) step(delay, () => turn.handle(type, payload));
    return { id: turn.turnId, status: "inProgress", items: [] };
  }

  async #turnInterrupt(threadId) {
    const thread = this.threads.get(threadId);
    if (thread?.turn?.local) {
      thread.turn.finish({ status: "interrupted" });
      this.#sealTurn(thread);
      return {};
    }
    if (thread?.runtimeId) {
      await this.hermes.call("session.interrupt", { session_id: thread.runtimeId }).catch((err) => this.log(`interrupt failed: ${err.message}`));
    }
    return {};
  }

  async #threadUnsubscribe(threadId) {
    const thread = this.threads.get(threadId);
    if (!thread?.runtimeId || (thread.turn && !thread.turn.done)) return { status: "unsubscribed" };
    // Free the live agent; the stored session stays resumable from any Hermes client.
    const runtimeId = thread.runtimeId;
    thread.runtimeId = null;
    thread.history = null;
    this.byRuntime.delete(runtimeId);
    await this.hermes.call("session.close", { session_id: runtimeId }).catch(() => {});
    return { status: "unsubscribed" };
  }

  // ── Hermes side ──────────────────────────────────────────────────────────────────────────────

  #threadFor(runtimeId) {
    const id = this.byRuntime.get(String(runtimeId ?? ""));
    return id ? this.threads.get(id) : undefined;
  }

  #onHermesEvent(evt) {
    const type = String(evt?.type ?? "");
    if (type === "request.cancel") {
      for (const [requestId, req] of this.requests) {
        if (req.hermesId !== evt.payload?.id) continue;
        this.requests.delete(requestId);
        this.#notify("serverRequest/resolved", { threadId: req.threadId, requestId });
      }
      return;
    }
    const thread = this.#threadFor(evt?.session_id);
    if (!thread) return;
    if (type === "session.title" && evt.payload?.title) {
      thread.title = String(evt.payload.title);
      return;
    }
    if (type === "session.info" && evt.payload?.model) this.model = evt.payload.model;
    if (thread.early) { thread.early.push({ type, payload: evt.payload }); return; }
    const turn = thread.turn;
    if (!turn || turn.done) return;
    turn.handle(type, evt.payload ?? {});
    if (turn.done) this.#sealTurn(thread);
  }

  #sealTurn(thread) {
    if (!thread.turn) return;
    for (const timer of thread.localTimers ?? []) clearTimeout(timer);
    thread.localTimers = null;
    if (!thread.turn.local) thread.lastRun = thread.turn.ran;
    (thread.history ??= []).push(thread.turn.snapshot());
    thread.turn = null;
    thread.updatedAt = Date.now() / 1000;
  }

  #onHermesDown(reason) {
    for (const thread of this.threads.values()) {
      thread.runtimeId = null;
      thread.history = null;
      if (thread.turn && !thread.turn.done) {
        thread.turn.fail(`Lost the connection to Hermes mid-turn (${reason}). The turn may still finish there; resume the session to check.`);
        thread.turn = null;
      }
    }
    this.byRuntime.clear();
    this.requests.clear();
  }

  #onHermesRequest(hermesId, method, params) {
    const thread = this.#threadFor(params?.session_id);
    const turnId = thread?.turn?.turnId;
    if (!thread || !turnId) {
      return this.hermes.respond(hermesId, method === "approval" ? { choice: "deny" } : method === "clarify" ? {} : { value: "" });
    }
    const requestId = this.nextRequestId++;
    if (method === "approval") {
      const offered = new Set(Array.isArray(params.choices) && params.choices.length ? params.choices : ["once", "deny"]);
      const availableDecisions = [];
      if (offered.has("once")) availableDecisions.push("accept");
      if (offered.has("session") || offered.has("always")) availableDecisions.push("acceptForSession");
      availableDecisions.push("decline");
      this.requests.set(requestId, { hermesId, method, threadId: thread.id, offered });
      return this.#request(requestId, "item/commandExecution/requestApproval", {
        threadId: thread.id, turnId, itemId: `approval_${requestId}`,
        command: String(params.command || params.description || params.tool_name || "Hermes action"),
        reason: String(params.description ?? ""), cwd: thread.cwd, availableDecisions,
      });
    }
    if (method === "clarify") {
      const batch = Array.isArray(params.questions) && params.questions.length > 0;
      const questions = (batch ? params.questions : [{ qid: "q1", question: params.question, choices: params.choices }])
        .map((q) => ({
          id: String(q.qid), header: "Hermes asks", question: String(q.question ?? ""),
          options: (q.choices ?? []).map((label) => ({ label: String(label), description: "" })),
        }));
      this.requests.set(requestId, { hermesId, method, threadId: thread.id, batch, questions });
      return this.#request(requestId, "item/tool/requestUserInput", { threadId: thread.id, turnId, itemId: `clarify_${requestId}`, questions });
    }
    // sudo / secret / vault prompts and desktop-only bridges cannot be answered from a HUD.
    this.log(`declining unsupported Hermes request: ${method}`);
    return this.hermes.respond(hermesId, { value: "" });
  }

  #request(id, method, params) {
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(frame);
  }

  #onClientResponse(msg) {
    const req = this.requests.get(msg.id);
    if (!req) return;
    this.requests.delete(msg.id);
    const result = msg.result ?? {};
    if (req.method === "approval") {
      const decision = typeof result.decision === "string" ? result.decision : "";
      const choice = decision === "accept" ? (req.offered.has("once") ? "once" : "deny")
        : decision === "acceptForSession" ? (req.offered.has("session") ? "session" : req.offered.has("always") ? "always" : "once")
        : "deny";
      return this.hermes.respond(req.hermesId, { choice });
    }
    const answers = {};
    for (const q of req.questions) {
      const value = result.answers?.[q.id]?.answers?.[0];
      answers[q.id] = typeof value === "string" && value !== "skip" ? value : "";
    }
    this.hermes.respond(req.hermesId, req.batch ? { answers } : { answer: answers.q1 ?? "" });
  }

  #profiled(params) {
    return this.config.session.profile ? { ...params, profile: this.config.session.profile } : params;
  }
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}

function saveState(meta) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    const entries = Object.entries(meta).sort((a, b) => (b[1].createdAt ?? 0) - (a[1].createdAt ?? 0)).slice(0, 500);
    writeFileSync(STATE_PATH, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* thread metadata is a convenience, never fatal */ }
}
