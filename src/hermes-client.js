// JSON-RPC client for the Hermes Agent `tui_gateway` — the backend behind `hermes --tui`, the
// desktop app and the dashboard chat. Newline-delimited JSON-RPC both ways; the server also sends
// `event` notifications and its own requests (approval / clarify / ...) that expect a response.
import { spawn, execSync } from "node:child_process";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { resolveStdioCommand } from "./config.js";

const RECONNECT_DELAYS_MS = [500, 1000, 2000, 5000, 10000];

export class HermesRpcError extends Error {
  constructor(error) {
    super(error?.message || "Hermes RPC error");
    this.code = error?.code;
    this.data = error?.data;
  }
}

export class HermesClient extends EventEmitter {
  constructor(gateway, log = () => {}) {
    super();
    this.gateway = gateway;
    this.log = log;
    this.nextId = 1;
    this.pending = new Map();
    this.transport = null;
    this.connecting = null;
    this.closed = false;
    this.failures = 0;
  }

  /** Connect if needed. Rejects when the gateway cannot be reached right now. */
  async ensureConnected() {
    if (this.transport) return;
    if (!this.connecting) {
      this.connecting = (this.gateway.mode === "ws" ? this.#connectWs() : this.#connectStdio())
        .then((transport) => {
          this.transport = transport;
          this.failures = 0;
          this.emit("up");
        })
        .finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  async call(method, params = {}, timeoutMs = 60000) {
    await this.ensureConnected();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Hermes RPC timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Answer a server→client request (approval, clarify, ...). */
  respond(id, result) {
    this.#send({ jsonrpc: "2.0", id, result });
  }

  close() {
    this.closed = true;
    this.transport?.close();
  }

  #send(msg) {
    this.transport?.send(JSON.stringify(msg));
  }

  #handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg?.method === "string") {
      if (msg.id === undefined || msg.id === null) {
        if (msg.method === "event") this.emit("event", msg.params ?? {});
      } else {
        this.emit("request", msg.id, msg.method, msg.params ?? {});
      }
      return;
    }
    const pending = this.pending.get(msg?.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new HermesRpcError(msg.error));
    else pending.resolve(msg.result);
  }

  #handleDown(reason) {
    if (!this.transport) return;
    this.transport = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`Hermes gateway disconnected: ${reason}`));
    }
    this.pending.clear();
    if (!this.closed) this.log(`gateway connection lost: ${reason}`);
    this.emit("down", reason);
    if (!this.closed) this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.failures, RECONNECT_DELAYS_MS.length - 1)];
    this.failures++;
    setTimeout(() => {
      if (this.closed || this.transport) return;
      this.ensureConnected().catch((err) => {
        this.log(`reconnect failed: ${err.message}`);
        this.#scheduleReconnect();
      });
    }, delay).unref();
  }

  // ── stdio: a private gateway process ─────────────────────────────────────────────────────────

  async #connectStdio() {
    const { argv, cwd } = resolveStdioCommand(this.gateway);
    this.log(`spawning Hermes gateway: ${argv.join(" ")}`);
    const child = spawn(argv[0], argv.slice(1), { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    const transport = {
      send: (text) => child.stdin.write(text + "\n"),
      close: () => child.kill(),
    };
    await new Promise((resolve, reject) => {
      let buffer = "";
      let ready = false;
      const timer = setTimeout(() => reject(new Error("Hermes gateway did not become ready within 60s")), 60000);
      child.once("error", (err) => { clearTimeout(timer); reject(err); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (!ready) reject(new Error(`Hermes gateway exited during startup (code ${code})`));
        else this.#handleDown(`gateway process exited (code ${code})`);
      });
      child.stderr.on("data", (d) => {
        for (const line of d.toString().split("\n")) if (line.trim()) this.log(`[gateway] ${line.trim()}`);
      });
      child.stdout.on("data", (d) => {
        buffer += d.toString();
        let nl;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          if (!ready && line.includes('"gateway.ready"')) {
            ready = true;
            clearTimeout(timer);
            resolve();
          }
          this.#handleLine(line);
        }
      });
    });
    return transport;
  }

  // ── ws: attach to a running dashboard ────────────────────────────────────────────────────────

  async #connectWs() {
    const base = this.gateway.url.replace(/\/+$/, "");
    const wsBase = base.replace(/^http/i, "ws");
    let query;
    if (this.gateway.token) {
      query = `token=${encodeURIComponent(this.gateway.token)}`;
    } else {
      query = `ticket=${encodeURIComponent(await this.#mintTicket(base))}`;
    }
    const ws = new WebSocket(`${wsBase}/api/ws?${query}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.terminate(); reject(new Error("WebSocket connect timeout")); }, 15000);
      ws.once("open", () => { clearTimeout(timer); resolve(); });
      ws.once("error", (err) => { clearTimeout(timer); reject(new Error(`WebSocket error: ${err.message}`)); });
      ws.once("unexpected-response", (_req, res) => {
        clearTimeout(timer);
        reject(new Error(`Dashboard refused the WebSocket (HTTP ${res.statusCode}); check gateway credentials`));
      });
    });
    ws.on("message", (data) => {
      for (const line of data.toString().split("\n")) if (line.trim()) this.#handleLine(line);
    });
    ws.on("error", (err) => this.log(`ws error: ${err.message}`));
    ws.on("close", (code) => this.#handleDown(`websocket closed (${code})`));
    this.log(`attached to Hermes dashboard at ${base}`);
    return { send: (text) => ws.send(text), close: () => ws.close() };
  }

  /** Gated dashboards: password login → session cookie → single-use 30s WS ticket. */
  async #mintTicket(base) {
    const password = this.#resolvePassword();
    if (!this.gateway.username || !password) {
      throw new Error("ws mode needs gateway.token, or gateway.username plus gateway.password / gateway.passwordCommand");
    }
    const login = await fetch(`${base}/auth/password-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: this.gateway.provider || "basic", username: this.gateway.username, password }),
    });
    if (!login.ok) throw new Error(`Dashboard login failed (HTTP ${login.status})`);
    const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const res = await fetch(`${base}/api/auth/ws-ticket`, { method: "POST", headers: { cookie } });
    if (!res.ok) throw new Error(`Could not mint a WebSocket ticket (HTTP ${res.status})`);
    const { ticket } = await res.json();
    if (!ticket) throw new Error("Dashboard returned no WebSocket ticket");
    return ticket;
  }

  #resolvePassword() {
    if (this.gateway.password) return this.gateway.password;
    if (!this.gateway.passwordCommand) return "";
    try {
      return execSync(this.gateway.passwordCommand, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30000 }).trim();
    } catch (err) {
      throw new Error(`gateway.passwordCommand failed (exit ${err.status ?? "?"})`);
    }
  }
}
