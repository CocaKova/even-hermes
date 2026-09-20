import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const shim = fileURLToPath(new URL("../shim/claude", import.meta.url));

function home(providers) {
  const dir = mkdtempSync(join(tmpdir(), "even-hermes-claude-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify({ providers }));
  return dir;
}

test("providers.claude = hermes never runs or forwards to a real Claude Code", () => {
  const dir = home({ claude: "hermes" });
  const real = join(dir, "real-claude");
  writeFileSync(real, "#!/bin/sh\necho REAL CLAUDE RAN\n", { mode: 0o755 });
  const run = spawnSync(shim, ["-p", "hello"], { encoding: "utf8", env: { ...process.env, EVEN_HERMES_HOME: dir, EVEN_HERMES_REAL_CLAUDE: real } });
  assert.equal(run.status, 2);
  assert.doesNotMatch(run.stdout, /REAL CLAUDE RAN/);
  assert.match(run.stderr, /never runs the real Claude Code/);
});

test("providers.claude = claude passes the real CLI through and says so once per new session", () => {
  const dir = home({ claude: "claude" });
  const real = join(dir, "real-claude");
  const lines = [
    { type: "system", subtype: "init", session_id: "abc" },
    { type: "stream_event", session_id: "abc", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } },
    { type: "result", subtype: "success", session_id: "abc", result: "hi" },
  ];
  writeFileSync(real, `#!/bin/sh\ncat <<'EOT'\n${lines.map((l) => JSON.stringify(l)).join("\n")}\nEOT\n`, { mode: 0o755 });
  const env = { ...process.env, EVEN_HERMES_HOME: dir, EVEN_HERMES_REAL_CLAUDE: real, ANTHROPIC_API_KEY: "" };
  const parse = (run) => run.stdout.trim().split("\n").map((l) => JSON.parse(l));

  const fresh = parse(spawnSync(shim, ["--output-format", "stream-json"], { encoding: "utf8", env }));
  assert.deepEqual(fresh.map((m) => m.type), ["system", "stream_event", "stream_event", "stream_event", "stream_event", "result"]);
  assert.match(fresh[2].event.delta.text, /^\[Heads up: this is the real Claude Code on .+ using the Claude login there/);
  assert.equal(fresh[2].session_id, "abc");
  assert.deepEqual(fresh.at(-1), lines.at(-1), "the real output is untouched");

  const resumed = parse(spawnSync(shim, ["--output-format", "stream-json", "--resume", "abc"], { encoding: "utf8", env }));
  assert.deepEqual(resumed, lines, "a resumed session is not nagged again");

  const keyed = parse(spawnSync(shim, ["--output-format", "stream-json"], { encoding: "utf8", env: { ...env, ANTHROPIC_API_KEY: "sk-test" } }));
  assert.match(keyed[2].event.delta.text, /billed per token to the Anthropic API key/);
});

test("providers.codex = codex hands the Codex provider to the real codex", () => {
  const dir = home({ codex: "codex" });
  writeFileSync(join(dir, "codex"), "#!/bin/sh\necho REAL CODEX $@\n", { mode: 0o755 });
  const codexShim = fileURLToPath(new URL("../shim/codex", import.meta.url));
  const run = spawnSync(codexShim, ["app-server", "--listen", "ws://127.0.0.1:1"], { encoding: "utf8", env: { ...process.env, EVEN_HERMES_HOME: dir, PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(run.stdout.trim(), "REAL CODEX app-server --listen ws://127.0.0.1:1");
});
