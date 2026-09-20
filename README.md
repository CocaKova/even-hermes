# even-hermes

Run your [Hermes Agent](https://github.com/NousResearch/hermes-agent) on Even Realities smart glasses.

[Even Terminal](https://www.npmjs.com/package/@evenrealities/even-terminal) puts a coding agent on your glasses, but it only knows two agents: Claude and Codex. `even-hermes` adds a third without patching it.

## How it works

Even Terminal's Codex mode does not talk to OpenAI. It runs whatever `codex` it finds on `PATH` as `codex app-server` and drives it over a local WebSocket. `even-hermes` puts its own `codex` first on `PATH`. That shim speaks the app-server protocol on one side and the Hermes `tui_gateway` JSON-RPC on the other:

```
glasses ─ Even app ─ Even Terminal ─ "codex app-server" ─ Hermes gateway ─ your agent
                                      (this project)
```

| Even Terminal asks for | Hermes gets |
|---|---|
| `thread/start` | `session.create` |
| `thread/list`, `thread/turns/list` | `session.list`, `session.resume` transcript |
| `turn/start` | `prompt.submit` |
| `turn/interrupt` | `session.interrupt` |
| command approval | Hermes `approval` request |
| user question | Hermes `clarify` request |

Hermes events come back as Codex items: reasoning, streamed reply text, and tool calls (terminal commands show as shell commands with their output, web searches as searches, file edits as diffs, everything else as a named tool). The HUD prints free text only for shell and search rows, so every other tool rides a shell row labeled with its name and most telling argument (`Shell browser_navigate example.com/pricing`, `Shell delegate: audit the cron jobs`, a leading `✗` when it failed). Status rides the same rows: the thinking indicator lights as soon as Hermes calls the model, a tool row opens while the model is still writing the call, and lifecycle status (context compaction, provider recovery, warnings) shows as a `compacting: …` row that stays in progress until the turn moves on.

Hermes stays the agent. It runs its own tools, skills and memory on its own host. Nothing from Codex is involved, so there is no second system prompt and no second tool loop. Pointing the real Codex CLI at Hermes's OpenAI-compatible endpoint does not work well for exactly that reason: Hermes ignores the tools Codex offers and does the work itself.

## Install

Needs Node 20+, Linux or macOS, a working Hermes Agent install, and Even Terminal.

```bash
npm i -g @evenrealities/even-terminal
git clone https://github.com/CocaKova/even-hermes && cd even-hermes
npm install && npm link

even-hermes doctor   # checks Even Terminal and the Hermes gateway
even-hermes          # starts Even Terminal with Hermes as the agent; scan the QR in the Even app
```

Arguments pass straight through to `even-terminal` (`even-hermes --tailscale --port 3456`). Your normal `codex` command is untouched; the shim is only on `PATH` for the process `even-hermes` starts.

## Two ways to reach Hermes

Config lives in `~/.even-hermes/config.json` (`even-hermes init` writes a starter, `init --ws` for dashboard mode).

**`stdio` (default, zero config).** Spawns a private gateway process from your Hermes install, the same one `hermes --tui` uses. Looks in `~/.hermes/hermes-agent`; set `gateway.hermesDir` or a full `gateway.command` if yours is elsewhere.

**`ws` (attach to a running dashboard).** Sessions are created inside the dashboard process, so a turn you start from your glasses streams live in every other Hermes client, and you can pick up any existing conversation from the glasses.

```json
{
  "gateway": {
    "mode": "ws",
    "url": "http://127.0.0.1:9119",
    "username": "you",
    "passwordCommand": "your-secret-tool get hermes-dashboard"
  }
}
```

For a dashboard with login enabled, give `username` plus `password` or `passwordCommand` (any command that prints the password; keeps it out of the file). The bridge logs in and mints a fresh single-use WebSocket ticket on every connect. For a loopback dashboard without login, set `gateway.token` to its session token instead. `EVEN_HERMES_MODE`, `_URL`, `_USERNAME`, `_PASSWORD` and `_TOKEN` override the file.

### Session options

| Key | Meaning |
|---|---|
| `session.firstPromptNote` | Prepended to the first prompt of each new thread, telling the agent it is writing to a tiny HUD so it keeps replies short. Never shown on the glasses. Set to `""` to send prompts untouched. |
| `session.model`, `session.reasoningEffort`, `session.profile` | Passed to `session.create`. Empty means your Hermes defaults. |
| `session.source` | Source tag on created sessions (default `even-terminal`). |

### HUD options

| Key | Meaning |
|---|---|
| `hud.labelAt` | `"end"` (default): a labeled tool row stays in progress until the tool finishes, and its label shows then. `"start"`: the row completes as the tool starts, so the label shows while the tool runs. |
| `hud.recap` | `true` adds one line after each reply: `⚙ 7 tools · 3 shell · 2 browser · 1 failed · 41s`. Default `false`. |

### Prompts the bridge answers itself

These never reach Hermes:

- `hud demo` or `/demo` plays a 30-second canned turn through every row the HUD can show (thinking, shell, labeled tools, search, file edit, status, a failed tool, a reply, the recap). `hud demo start` / `hud demo end` force a `labelAt` mode so you can compare them on the lens.
- `what did you run?` or `/ran` lists the tools of the last turn, one per line, `✓` or `✗`.

## Both providers go to Hermes, and nothing reaches a Claude account

The Even app lets you pick a provider per session. even-hermes answers both:

- **Codex** runs the `codex app-server` shim. Tool rows read `Shell <label>`.
- **Claude** runs a `claude` shim that speaks the Claude Agent SDK's stream-json protocol. Rows keep the Hermes tool's own name (`browser_navigate example.com/pricing`), Hermes todos drive the task-progress display, and the turn reports a cost of 0.

The launcher points Even Terminal's Claude provider at the shim (`EVEN_TERMINAL_CLAUDE_CODE_EXECUTABLE`), gives it a config home with no Anthropic login in it (`CLAUDE_CONFIG_DIR=~/.even-hermes/claude-home`), and drops `ANTHROPIC_API_KEY`-style variables from its environment. The shim refuses anything that is not the SDK protocol and never forwards to a real Claude Code, so choosing "Claude" on the glasses cannot spend money. Sessions started on the Claude side are listed from transcripts the shim writes under that config home.

## Limits

- Hermes runs where Hermes runs. The project directory you pick in Even Terminal is passed as the session `cwd`, but tools execute on the Hermes host.
- Secret, sudo and vault prompts are declined automatically. You cannot type a password on a HUD, and you should not want to.
- In `ws` mode, resuming a session that another client has open takes over its live stream, as any second Hermes client would.
- If the gateway connection drops mid-turn, the turn is reported as failed on the glasses rather than hanging. It may still finish on the Hermes side; resume the session to see.
- `even-terminal codex` (the desktop Codex TUI attached to Even Terminal) is not supported through the shim. Other `codex` subcommands are forwarded to your real Codex if one is installed.
- Approval and clarify flows are covered by tests against a mock gateway; the rest was verified against Hermes Agent v0.21.3 and Even Terminal 0.10.4. Both protocols are young and may move.

## Development

```bash
npm test
```

`src/translate.js` is the pure event translation, `src/app-server.js` the Codex-facing server, `src/hermes-client.js` the gateway transport.

Not affiliated with Even Realities, Nous Research or OpenAI.

## License

MIT
