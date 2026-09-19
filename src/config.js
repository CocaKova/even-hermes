import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = process.env.EVEN_HERMES_HOME || join(homedir(), ".even-hermes");
export const CONFIG_PATH = process.env.EVEN_HERMES_CONFIG || join(CONFIG_DIR, "config.json");

export const DEFAULT_FIRST_PROMPT_NOTE =
  "[Sent from Even G1 smart glasses. Replies render on a tiny monochrome HUD: " +
  "keep them short, plain text, no tables or code fences unless asked.]";

const DEFAULTS = {
  gateway: {
    // "ws"    = attach to a running Hermes dashboard (turns show up live in every other client)
    // "stdio" = spawn a private `tui_gateway` process (zero config, invisible to other clients)
    mode: "stdio",
    url: "http://127.0.0.1:9119",
    provider: "basic",
    username: "",
    password: "",
    passwordCommand: "",
    token: "",
    command: [],
    hermesDir: "",
  },
  session: {
    source: "even-terminal",
    model: "",
    profile: "",
    reasoningEffort: "",
    firstPromptNote: DEFAULT_FIRST_PROMPT_NOTE,
  },
  listLimit: 25,
};

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof base[k] === "object" && !Array.isArray(base[k])
      ? merge(base[k], v)
      : v;
  }
  return out;
}

export function loadConfig(path = CONFIG_PATH) {
  let raw = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      throw new Error(`Invalid JSON in ${path}: ${err.message}`);
    }
  }
  const cfg = merge(DEFAULTS, raw);
  const env = process.env;
  if (env.EVEN_HERMES_MODE) cfg.gateway.mode = env.EVEN_HERMES_MODE;
  if (env.EVEN_HERMES_URL) cfg.gateway.url = env.EVEN_HERMES_URL;
  if (env.EVEN_HERMES_USERNAME) cfg.gateway.username = env.EVEN_HERMES_USERNAME;
  if (env.EVEN_HERMES_PASSWORD) cfg.gateway.password = env.EVEN_HERMES_PASSWORD;
  if (env.EVEN_HERMES_TOKEN) cfg.gateway.token = env.EVEN_HERMES_TOKEN;
  if (cfg.gateway.mode !== "ws" && cfg.gateway.mode !== "stdio") {
    throw new Error(`gateway.mode must be "ws" or "stdio" (got ${JSON.stringify(cfg.gateway.mode)})`);
  }
  return cfg;
}

/** Resolve the argv + cwd used to spawn a private Hermes tui_gateway over stdio. */
export function resolveStdioCommand(gateway) {
  if (Array.isArray(gateway.command) && gateway.command.length > 0) {
    return { argv: gateway.command, cwd: gateway.hermesDir || undefined };
  }
  const dir = gateway.hermesDir || process.env.HERMES_AGENT_DIR || join(homedir(), ".hermes", "hermes-agent");
  for (const py of ["venv/bin/python", ".venv/bin/python", "venv/Scripts/python.exe", ".venv/Scripts/python.exe"]) {
    const candidate = join(dir, py);
    if (existsSync(candidate)) return { argv: [candidate, "-m", "tui_gateway.entry"], cwd: dir };
  }
  throw new Error(
    `Could not find the Hermes Agent virtualenv under ${dir}. ` +
    `Set gateway.hermesDir or gateway.command in ${CONFIG_PATH}.`);
}
