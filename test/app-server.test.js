import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";

process.env.EVEN_HERMES_HOME = mkdtempSync(join(tmpdir(), "even-hermes-test-"));
const { AppServer } = await import("../src/app-server.js");
const { MockHermes } = await import("./mock-gateway.js");

const NOTE = "[glasses]";

async function setup() {
  const hermes = new MockHermes();
  const config = { gateway: { mode: "stdio" }, session: { source: "even-terminal", firstPromptNote: NOTE }, listLimit: 25 };
  const server = new AppServer({ hermes, config, version: "test" });
  const { port } = await server.listen("127.0.0.1", 0);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => ws.once("open", resolve));
  const inbox = [];
  const waiters = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    inbox.push(msg);
    for (const w of [...waiters]) if (w.match(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  });
  let nextId = 1;
  const waitFor = (match) => {
    const hit = inbox.find(match);
    return hit ? Promise.resolve(hit) : new Promise((resolve) => waiters.push({ match, resolve }));
  };
  const call = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return waitFor((m) => m.id === id && !m.method);
  };
  const close = () => { ws.close(); server.close(); };
  return { hermes, ws, inbox, call, waitFor, close };
}

const textInput = (text) => [{ type: "text", text }];

test("a turn streams user message, reasoning, tool call and reply, then completes", async () => {
  const t = await setup();
  const { result: { thread } } = await t.call("thread/start", { cwd: "/tmp" });
  assert.equal(thread.id, "stored_new");
  const { result: { turn } } = await t.call("turn/start", { threadId: thread.id, input: textInput("run ls") });
  assert.equal(turn.status, "inProgress");

  const submit = t.hermes.calls.find((c) => c.method === "prompt.submit");
  assert.equal(submit.params.session_id, "rt1");
  assert.equal(submit.params.text, `${NOTE}\n\nrun ls`, "first prompt carries the glasses note");

  await t.waitFor((m) => m.method === "item/completed" && m.params.item.type === "userMessage");
  t.hermes.event("rt1", "thinking.delta", { text: "( •_•) pondering" });
  t.hermes.event("rt1", "reasoning.delta", { text: "plan" });
  t.hermes.event("rt1", "tool.start", { tool_id: "c1", name: "terminal", args: { command: "ls" } });
  t.hermes.event("rt1", "tool.complete", { tool_id: "c1", name: "terminal", args: { command: "ls" }, result: { output: "a\nb", exit_code: 0 } });
  t.hermes.event("rt1", "message.delta", { text: "\n\nTwo files" });
  t.hermes.event("rt1", "message.delta", { text: ": a, b" });
  t.hermes.event("rt1", "reasoning.available", { text: "Two files: a, b" });
  t.hermes.event("rt1", "message.complete", { text: "Two files: a, b", status: "complete", usage: { input: 10, output: 4 } });

  const done = await t.waitFor((m) => m.method === "turn/completed");
  assert.equal(done.params.turn.status, "completed");
  assert.deepEqual(done.params.turn.usage, { inputTokens: 10, outputTokens: 4 });

  const kinds = t.inbox.filter((m) => m.method === "item/completed").map((m) => m.params.item.type);
  assert.deepEqual(kinds, ["userMessage", "reasoning", "commandExecution", "agentMessage"]);
  const user = t.inbox.find((m) => m.method === "item/started" && m.params.item.type === "userMessage");
  assert.equal(user.params.item.content[0].text, "run ls", "the note never shows on the HUD");
  const cmd = t.inbox.find((m) => m.method === "item/completed" && m.params.item.type === "commandExecution").params.item;
  assert.equal(cmd.aggregatedOutput, "a\nb");
  assert.equal(cmd.exitCode, 0);
  const deltas = t.inbox.filter((m) => m.method === "item/agentMessage/delta").map((m) => m.params.delta).join("");
  assert.equal(deltas, "Two files: a, b", "leading blank lines are trimmed");

  await t.call("turn/start", { threadId: thread.id, input: textInput("again") });
  const second = t.hermes.calls.filter((c) => c.method === "prompt.submit")[1];
  assert.equal(second.params.text, "again", "the note is only sent once per thread");
  t.close();
});

test("a reply that never streamed is delivered whole from message.complete", async () => {
  const t = await setup();
  const { result: { thread } } = await t.call("thread/start", {});
  await t.call("turn/start", { threadId: thread.id, input: textInput("hi") });
  await t.waitFor((m) => m.method === "turn/started");
  t.hermes.event("rt1", "message.complete", { text: "hello", status: "complete" });
  await t.waitFor((m) => m.method === "turn/completed");
  const msg = t.inbox.find((m) => m.method === "item/completed" && m.params.item.type === "agentMessage");
  assert.equal(msg.params.item.text, "hello");
  t.close();
});

test("events that beat the turn/start reply are replayed in order", async () => {
  const t = await setup();
  const { result: { thread } } = await t.call("thread/start", {});
  const original = t.hermes.call.bind(t.hermes);
  t.hermes.call = async (method, params) => {
    const res = await original(method, params);
    if (method === "prompt.submit") t.hermes.event("rt1", "message.delta", { text: "early" });
    return res;
  };
  await t.call("turn/start", { threadId: thread.id, input: textInput("hi") });
  const delta = await t.waitFor((m) => m.method === "item/agentMessage/delta");
  assert.equal(delta.params.delta, "early");
  const order = t.inbox.filter((m) => m.method).map((m) => m.method);
  assert.ok(order.indexOf("turn/started") < order.indexOf("item/agentMessage/delta"));
  t.close();
});

test("stored sessions list, read and page history without tool rows", async () => {
  const t = await setup();
  const list = await t.call("thread/list", { limit: 10, cwd: "/work" });
  assert.equal(list.result.data[0].id, "stored_old");
  assert.equal(list.result.data[0].cwd, "/work");
  const read = await t.call("thread/read", { threadId: "stored_old", includeTurns: false });
  assert.equal(read.result.thread.status.type, "idle");
  const missing = await t.call("thread/read", { threadId: "nope" });
  assert.equal(missing.error.code, -32004);
  const turns = await t.call("thread/turns/list", { threadId: "stored_old", sortDirection: "desc" });
  assert.deepEqual(turns.result.data[0].items.map((i) => i.type), ["userMessage", "agentMessage"]);
  t.close();
});

test("resume snapshot reports the live turn", async () => {
  const t = await setup();
  const idle = await t.call("thread/resume", { threadId: "stored_old", excludeTurns: true, initialTurnsPage: { limit: 1 } });
  assert.equal(idle.result.thread.status.type, "idle");
  assert.deepEqual(idle.result.initialTurnsPage.data, []);
  await t.call("turn/start", { threadId: "stored_old", input: textInput("go") });
  await t.waitFor((m) => m.method === "turn/started");
  const busy = await t.call("thread/resume", { threadId: "stored_old", excludeTurns: true, initialTurnsPage: { limit: 1 } });
  assert.equal(busy.result.thread.status.type, "active");
  assert.equal(busy.result.initialTurnsPage.data[0].status, "inProgress");
  t.close();
});

test("a stale runtime session is re-attached once", async () => {
  const t = await setup();
  await t.call("thread/resume", { threadId: "stored_old" });
  t.hermes.failSubmitOnce = true;
  const res = await t.call("turn/start", { threadId: "stored_old", input: textInput("hi") });
  assert.ok(res.result.turn.id);
  assert.equal(t.hermes.calls.filter((c) => c.method === "session.resume").length, 2);
  t.close();
});

test("approval requests round-trip as command approvals", async () => {
  const t = await setup();
  const { result: { thread } } = await t.call("thread/start", {});
  await t.call("turn/start", { threadId: thread.id, input: textInput("rm it") });
  await t.waitFor((m) => m.method === "turn/started");
  t.hermes.emit("request", "srq-1", "approval", { session_id: "rt1", request_id: "r", command: "rm -rf build", description: "delete", choices: ["once", "session", "deny"] });
  const req = await t.waitFor((m) => m.method === "item/commandExecution/requestApproval");
  assert.equal(req.params.command, "rm -rf build");
  assert.deepEqual(req.params.availableDecisions, ["accept", "acceptForSession", "decline"]);
  t.ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { decision: "acceptForSession" } }));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(t.hermes.responses, [{ id: "srq-1", result: { choice: "session" } }]);

  t.hermes.emit("request", "srq-2", "approval", { session_id: "rt1", request_id: "r2", command: "x", choices: ["once", "deny"] });
  const req2 = await t.waitFor((m) => m.method === "item/commandExecution/requestApproval" && m.id !== req.id);
  t.ws.send(JSON.stringify({ jsonrpc: "2.0", id: req2.id, result: { decision: "cancel" } }));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(t.hermes.responses[1], { id: "srq-2", result: { choice: "deny" } });
  t.close();
});

test("clarify questions round-trip; secrets are declined", async () => {
  const t = await setup();
  const { result: { thread } } = await t.call("thread/start", {});
  await t.call("turn/start", { threadId: thread.id, input: textInput("deploy") });
  await t.waitFor((m) => m.method === "turn/started");
  t.hermes.emit("request", "srq-1", "clarify", { session_id: "rt1", question: "Which env?", choices: ["staging", "prod"] });
  const req = await t.waitFor((m) => m.method === "item/tool/requestUserInput");
  assert.deepEqual(req.params.questions[0].options.map((o) => o.label), ["staging", "prod"]);
  t.ws.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { answers: { q1: { answers: ["prod"] } } } }));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(t.hermes.responses[0], { id: "srq-1", result: { answer: "prod" } });

  t.hermes.emit("request", "srq-2", "sudo", { session_id: "rt1" });
  assert.deepEqual(t.hermes.responses[1], { id: "srq-2", result: { value: "" } });
  t.close();
});

test("losing the gateway fails the running turn instead of hanging the HUD", async () => {
  const t = await setup();
  const { result: { thread } } = await t.call("thread/start", {});
  await t.call("turn/start", { threadId: thread.id, input: textInput("hi") });
  await t.waitFor((m) => m.method === "turn/started");
  t.hermes.emit("down", "websocket closed (1006)");
  const done = await t.waitFor((m) => m.method === "turn/completed");
  assert.equal(done.params.turn.status, "failed");
  assert.match(done.params.turn.error.message, /Lost the connection/);
  t.close();
});

test("status indicators: thinking before any reasoning text, early tool rows, lifecycle status", async () => {
  const t = await setup();
  const { result: { thread } } = await t.call("thread/start", {});
  await t.call("turn/start", { threadId: thread.id, input: textInput("go") });
  await t.waitFor((m) => m.method === "item/completed" && m.params.item.type === "userMessage");

  t.hermes.event("rt1", "thinking.delta", { text: "(•_•) pondering..." });
  const think = await t.waitFor((m) => m.method === "item/started" && m.params.item.type === "reasoning");
  t.hermes.event("rt1", "thinking.delta", { text: "" });
  t.hermes.event("rt1", "tool.generating", { name: "terminal" });
  const early = await t.waitFor((m) => m.method === "item/started" && m.params.item.type === "commandExecution");
  t.hermes.event("rt1", "tool.start", { tool_id: "c1", name: "terminal", args: { command: "ls" } });
  t.hermes.event("rt1", "tool.complete", { tool_id: "c1", name: "terminal", args: { command: "ls" }, result: { output: "a", exit_code: 0 } });
  t.hermes.event("rt1", "status.update", { kind: "status", text: "ready" });
  t.hermes.event("rt1", "status.update", { kind: "compacting", text: "Compressing context…" });
  t.hermes.event("rt1", "status.update", { kind: "compacting", text: "Compressing context…" });
  t.hermes.event("rt1", "message.delta", { text: "done" });
  t.hermes.event("rt1", "thinking.delta", { text: "(•_•) still here..." });
  t.hermes.event("rt1", "message.delta", { text: "!" });
  t.hermes.event("rt1", "tool.generating", { name: "web_search" });
  t.hermes.event("rt1", "message.complete", { text: "done!", status: "complete" });
  await t.waitFor((m) => m.method === "turn/completed");

  const completed = t.inbox.filter((m) => m.method === "item/completed").map((m) => m.params.item);
  assert.deepEqual(completed.map((i) => i.type), ["userMessage", "reasoning", "commandExecution", "mcpToolCall", "agentMessage", "webSearch"]);
  assert.equal(completed[1].id, think.params.item.id);
  assert.equal(completed[2].id, early.params.item.id, "tool.start claims the row tool.generating opened");
  assert.equal(completed[2].command, "ls");
  assert.deepEqual([completed[3].tool, completed[3].result, completed[3].status], ["status:compacting", "Compressing context…", "completed"]);
  assert.equal(completed[4].text, "done!", "a spinner tick never splits a streaming reply");
  assert.equal(completed[5].status, "failed", "a tool that was announced but never ran does not hang in progress");
  t.close();
});
