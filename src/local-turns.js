// Turns the bridge answers itself, as scripted Hermes events fed through the normal translator so
// the HUD shows exactly what a real turn would.

const DEMO = /^(\/demo|hud demo)(?: (start|end))?[.!]?$/i;
const WHAT_RAN = /^(\/ran|what (?:tools )?did you (?:just )?(?:run|use))[.!?]*$/i;

const tool = (id, name, args, result, ms = 2000) => [
  [1200, "tool.generating", { name }],
  [800, "tool.start", { tool_id: id, name, args }],
  [ms, "tool.complete", { tool_id: id, name, args, result }],
];

function demo(labelAt) {
  const say = "HUD demo done. In order you should have seen: thinking, Shell ls -la, a browser_navigate row, "
    + "a search, a file edit, a delegate row, a compacting status, a failed brain_recall, this reply, then a tool recap.";
  return {
    hud: { recap: true, ...(labelAt ? { labelAt } : {}) },
    events: [
      [500, "thinking.delta", { text: "(•_•) pondering..." }],
      [1500, "reasoning.delta", { text: "Walking through every row the HUD can show." }],
      ...tool("d1", "terminal", { command: "ls -la ~/workspace" }, { output: "even-hermes\nkeryx", exit_code: 0 }),
      ...tool("d2", "browser_navigate", { url: "https://gardenofnull.cc/portfolio" }, { title: "Garden of Null" }),
      ...tool("d3", "web_search", { query: "even realities g2 sdk" }, { results: 5 }),
      ...tool("d4", "patch", { path: "src/translate.js" }, { ok: true }),
      ...tool("d5", "delegate_task", { goal: "audit the cron jobs" }, { summary: "3 stale pins" }, 3000),
      [1000, "status.update", { kind: "compacting", text: "Compressing context…" }],
      [3000, "thinking.delta", { text: "(•_•) pondering..." }],
      ...tool("d6", "brain_recall", { query: "keryx ship gate" }, { error: "recall timed out" }),
      ...say.match(/\S+\s*/g).map((word) => [60, "message.delta", { text: word }]),
      [300, "message.complete", { text: say, status: "complete" }],
    ],
  };
}

function whatRan(lastRun) {
  const lines = (lastRun ?? []).map((r) => `${r.failed ? "✗" : "✓"} ${r.label}`);
  const text = lines.length ? lines.join("\n") : "No tools ran in the last turn I saw from here.";
  return { hud: { recap: false }, events: [[100, "message.complete", { text, status: "complete" }]] };
}

/** The script for a prompt the bridge handles locally, or null to send it to Hermes. */
export function localScript(text, lastRun) {
  const demoMatch = DEMO.exec(text);
  if (demoMatch) return demo(demoMatch[2]?.toLowerCase());
  if (WHAT_RAN.test(text)) return whatRan(lastRun);
  return null;
}
