// A scriptable stand-in for HermesClient: records calls, lets a test push events / requests.
import { EventEmitter } from "node:events";

export class MockHermes extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.responses = [];
    this.sessions = [{ id: "stored_old", title: "Old chat", preview: "hello", started_at: 1700000000, message_count: 2 }];
    this.transcript = [{ role: "user", text: "hello" }, { role: "assistant", text: "hi there" }, { role: "tool", name: "terminal" }];
    this.failSubmitOnce = false;
    this.runtimeSeq = 0;
  }
  async ensureConnected() {}
  close() {}
  respond(id, result) { this.responses.push({ id, result }); }
  async call(method, params) {
    this.calls.push({ method, params });
    switch (method) {
      case "session.list": return { sessions: this.sessions };
      case "session.create": return { session_id: `rt${++this.runtimeSeq}`, stored_session_id: "stored_new", messages: [], info: { model: "test-model" } };
      case "session.resume": return { session_id: `rt${++this.runtimeSeq}`, messages: this.transcript, info: { model: "test-model" } };
      case "prompt.submit":
        if (this.failSubmitOnce) {
          this.failSubmitOnce = false;
          const { HermesRpcError } = await import("../src/hermes-client.js");
          throw new HermesRpcError({ code: 4001, message: "unknown session" });
        }
        return { status: "streaming" };
      default: return {};
    }
  }
  event(session_id, type, payload) { this.emit("event", { type, session_id, payload }); }
}
