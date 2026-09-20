#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, CONFIG_PATH, DEFAULT_FIRST_PROMPT_NOTE, loadConfig } from "../src/config.js";
import { HermesClient } from "../src/hermes-client.js";
import { claudeHome } from "../src/claude-main.js";
import { VERSION } from "../src/shim-main.js";

const shimDir = join(dirname(fileURLToPath(import.meta.url)), "..", "shim");
const args = process.argv.slice(2);

const HELP = `even-hermes ${VERSION} — your Hermes Agent on Even Realities smart glasses

Usage:
  even-hermes [even-terminal options]   Start Even Terminal with Hermes as its agent
  even-hermes init [--ws]               Write a starter config to ${CONFIG_PATH}
  even-hermes doctor                    Check that the Hermes gateway is reachable
  even-hermes --help | --version

Everything after \`even-hermes\` is passed to \`even-terminal\` (e.g. --tailscale, --port 3456).`;

async function doctor() {
  const config = loadConfig();
  console.log(`config:   ${existsSync(CONFIG_PATH) ? CONFIG_PATH : "(defaults — run `even-hermes init`)"}`);
  console.log(`gateway:  ${config.gateway.mode}${config.gateway.mode === "ws" ? ` → ${config.gateway.url}` : " (private tui_gateway process)"}`);
  console.log(`codex:    the app's "Codex" provider → ${config.providers.codex === "codex" ? "your REAL Codex CLI on this machine (its OpenAI login)" : "Hermes"}`);
  console.log(`claude:   the app's "Claude" provider → ${config.providers.claude === "hermes" ? "Hermes (no Claude account is contacted)" : "the REAL Claude Code on this machine (its Anthropic login or API key)"}`);
  const et = spawnSync("even-terminal", ["--version"], { encoding: "utf8" });
  console.log(`terminal: ${et.error ? "even-terminal NOT FOUND — npm i -g @evenrealities/even-terminal" : `even-terminal ${et.stdout.trim()}`}`);
  const hermes = new HermesClient(config.gateway, (line) => console.log(`          ${line}`));
  try {
    const { sessions = [] } = await hermes.call("session.list", { limit: 3 });
    console.log(`hermes:   OK — ${sessions.length} recent session(s) visible`);
    for (const s of sessions) console.log(`          · ${s.title || s.preview || s.id}`);
  } catch (err) {
    console.log(`hermes:   FAILED — ${err.message}`);
    process.exitCode = 1;
  } finally {
    hermes.close();
  }
}

/** The Claude Code that Even Terminal would run on its own: the one its Agent SDK bundles, else PATH. */
function findRealClaude() {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["even-terminal"], { encoding: "utf8" }).stdout?.split(/\r?\n/)[0]?.trim();
  if (which) {
    try {
      const root = join(dirname(realpathSync(which)), "..");
      for (const libc of ["", "-musl"]) {
        const bundled = join(root, "node_modules", "@anthropic-ai", `claude-agent-sdk-${process.platform}-${process.arch}${libc}`, exe);
        if (existsSync(bundled)) return bundled;
      }
    } catch { /* fall through to PATH */ }
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && dir !== shimDir && existsSync(join(dir, exe))) return join(dir, exe);
  }
  return null;
}

function init() {
  if (existsSync(CONFIG_PATH)) {
    console.error(`${CONFIG_PATH} already exists; edit it instead.`);
    process.exit(1);
  }
  const gateway = args.includes("--ws")
    ? { mode: "ws", url: "http://127.0.0.1:9119", username: "", passwordCommand: "" }
    : { mode: "stdio" };
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify({ gateway, session: { firstPromptNote: DEFAULT_FIRST_PROMPT_NOTE } }, null, 2) + "\n");
  chmodSync(CONFIG_PATH, 0o600);
  console.log(`Wrote ${CONFIG_PATH}\nNext: even-hermes doctor`);
}

if (args[0] === "--help" || args[0] === "-h") {
  console.log(HELP);
} else if (args[0] === "--version" || args[0] === "-v") {
  console.log(VERSION);
} else if (args[0] === "doctor") {
  await doctor();
} else if (args[0] === "init") {
  init();
} else {
  const forwarded = args.includes("--provider") ? args : [...args, "--provider", "codex"];
  const config = loadConfig(); // also fails early on a broken config rather than inside a spawned child
  const env = { ...process.env, PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}` };
  const hermesAt = config.gateway.mode === "ws" ? `Hermes at ${config.gateway.url}` : "a private Hermes on this machine";
  let claudeGoes;
  if (config.providers.claude === "hermes") {
    // The Claude provider gets the Hermes shim, plus a config home with no Anthropic login in it:
    // whichever provider is picked in the Even app, nothing here can reach a Claude account.
    env.EVEN_TERMINAL_CLAUDE_CODE_EXECUTABLE = join(shimDir, "claude");
    env.CLAUDE_CONFIG_DIR = claudeHome();
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[key];
    mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true, mode: 0o700 });
    claudeGoes = `${hermesAt} (no Claude account is contacted)`;
  } else {
    // Real Claude Code, through a pass-through that only adds a heads-up to each new session. If it
    // cannot be found the provider is left exactly as Even Terminal ships it.
    const real = findRealClaude();
    if (real) {
      env.EVEN_TERMINAL_CLAUDE_CODE_EXECUTABLE = join(shimDir, "claude");
      env.EVEN_HERMES_REAL_CLAUDE = real;
    }
    claudeGoes = "the REAL Claude Code on this machine, on its Anthropic login or API key (your usage, your bill). "
      + `Set providers.claude to "hermes" in ${CONFIG_PATH} to send it to Hermes instead`;
  }
  console.log(`[even-hermes] provider "Codex"  → ${config.providers.codex === "codex" ? "your REAL Codex CLI on this machine (its OpenAI login, your usage)" : hermesAt}`);
  console.log(`[even-hermes] provider "Claude" → ${claudeGoes}`);
  const child = spawn("even-terminal", forwarded, { stdio: "inherit", env });
  child.on("error", (err) => {
    console.error(err.code === "ENOENT"
      ? "even-terminal is not installed. Run: npm i -g @evenrealities/even-terminal"
      : `failed to start even-terminal: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
}
