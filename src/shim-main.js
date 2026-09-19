// Entry point for the fake `codex` binary that Even Terminal spawns.
import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServer } from "./app-server.js";
import { loadConfig } from "./config.js";
import { HermesClient } from "./hermes-client.js";

const here = dirname(fileURLToPath(import.meta.url));
export const VERSION = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")).version;

const log = (text) => process.stderr.write(`[even-hermes] ${text}\n`);

/** The next `codex` on PATH that is not this shim, for arguments we do not handle. */
function findRealCodex() {
  const shimDir = realpathSync(join(here, "..", "shim"));
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, process.platform === "win32" ? "codex.cmd" : "codex");
    try {
      accessSync(candidate, constants.X_OK);
      if (dirname(realpathSync(candidate)) !== shimDir) return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

export async function main(argv) {
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(`even-hermes ${VERSION} (codex app-server shim for Hermes Agent)`);
    return;
  }
  if (argv[0] !== "app-server") {
    const real = findRealCodex();
    if (!real) {
      log(`only \`codex app-server\` is emulated, and no real codex was found on PATH for: codex ${argv.join(" ")}`);
      process.exit(2);
    }
    process.exit(spawnSync(real, argv, { stdio: "inherit" }).status ?? 1);
  }

  const listenArg = argv[argv.indexOf("--listen") + 1] ?? "";
  const match = /^ws:\/\/([^:/]+):(\d+)/.exec(argv.includes("--listen") ? listenArg : "");
  if (!match) {
    log("usage: codex app-server --listen ws://127.0.0.1:<port>");
    process.exit(2);
  }

  const config = loadConfig();
  const hermes = new HermesClient(config.gateway, log);
  const server = new AppServer({ hermes, config, log, version: VERSION });
  try {
    await server.listen(match[1], Number(match[2]));
  } catch (err) {
    log(`failed to listen on ${listenArg}: ${err.message}`);
    process.exit(1);
  }
  // Even Terminal waits for this exact phrase on stderr before it connects.
  process.stderr.write(`even-hermes ${VERSION} listening on: ${listenArg} (gateway: ${config.gateway.mode})\n`);
  hermes.ensureConnected().catch((err) => log(`Hermes gateway not reachable yet: ${err.message}`));

  const shutdown = () => { hermes.close(); server.close(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
