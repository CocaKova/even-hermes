import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ClaudeStream, claudeTool } from "../src/claude-stream.js";

function play(events, opts) {
  const out = [];
  const stream = new ClaudeStream("s1", (m) => out.push(m), opts);
  stream.start();
  for (const [type, payload] of events) stream.handle(type, payload);
  return { out, stream };
}
const blocks = (out) => out.filter((m) => m.type === "stream_event" && m.event.type === "content_block_start").map((m) => m.event.content_block);
const toolUses = (out) => out.filter((m) => m.type === "assistant").map((m) => m.message.content[0]);

test("Hermes tools keep their own names, with the telling argument as the description", () => {
  assert.deepEqual(claudeTool({ name: "terminal", args: { command: "ls" } }), { name: "Bash", input: { command: "ls", description: "ls" } });
  assert.deepEqual(claudeTool({ name: "web_search", args: { query: "g2 sdk" } }), { name: "WebSearch", input: { query: "g2 sdk" } });
  const nav = claudeTool({ name: "browser_navigate", args: { url: "https://www.example.com/pricing" } }, true);
  assert.deepEqual([nav.name, nav.input.description], ["browser_navigate", "✗ example.com/pricing"]);
  const del = claudeTool({ name: "delegate_task", args: { goal: "audit the cron jobs" } });
  assert.deepEqual([del.name, del.input.description], ["delegate", "audit the cron jobs"]);
});

test("a turn becomes thinking, an early tool row, a status row, text, a recap and a free result", () => {
  const { out } = play([
    ["thinking.delta", { text: "(•_•) pondering..." }],
    ["tool.generating", { name: "terminal" }],
    ["tool.start", { tool_id: "c1", name: "terminal", args: { command: "ls" } }],
    ["tool.complete", { tool_id: "c1", name: "terminal", args: { command: "ls" }, result: { output: "a", exit_code: 0 } }],
    ["status.update", { kind: "compacting", text: "Compressing context…" }],
    ["message.delta", { text: "\n\ndone" }],
    ["message.complete", { text: "done", status: "complete", usage: { input: 10, output: 4 } }],
  ], { recap: true });
  assert.deepEqual(blocks(out).map((b) => b.name ?? b.type), ["thinking", "Bash", "compacting", "text", "text"]);
  const uses = toolUses(out);
  assert.deepEqual(uses.map((u) => [u.name, u.input.description]), [["Bash", "ls"], ["compacting", "Compressing context…"]]);
  assert.equal(new Set(blocks(out).filter((b) => b.type === "tool_use").map((b) => b.id)).size, 2, "tool.start claims the row tool.generating opened");
  const result = out.at(-1);
  assert.deepEqual([result.type, result.subtype, result.total_cost_usd], ["result", "success", 0]);
  assert.match(result.result, /^done\n\n⚙ 1 tool · 1 shell · \d+s$/);
});

test("an interrupted turn reports the way the SDK expects", () => {
  const { out } = play([["message.complete", { status: "interrupted" }]]);
  assert.deepEqual([out.at(-1).subtype, out.at(-1).terminal_reason], ["error_during_execution", "aborted_streaming"]);
});

test("the claude shim never runs or forwards to a real Claude Code", () => {
  const shim = fileURLToPath(new URL("../shim/claude", import.meta.url));
  const run = spawnSync(shim, ["-p", "hello"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /never runs the real Claude Code/);
});
