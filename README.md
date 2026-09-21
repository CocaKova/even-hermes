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

### Keeping it running

Started from a shell, it dies with that shell and the glasses say the terminal is unreachable. On Linux a systemd user unit fixes that (`~/.config/systemd/user/even-hermes.service`, then `systemctl --user enable --now even-hermes`):

```ini
[Unit]
Description=even-hermes
After=network-online.target

[Service]
Environment=PATH=%h/.npm-global/bin:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=%h/.npm-global/bin/even-hermes --tailscale --port 3456
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

Adjust the paths to wherever `npm link` put `even-hermes` (`which even-hermes`). Even Terminal keeps its pairing token, so a restart does not need a new QR scan. Run `loginctl enable-linger $USER` if it should survive you logging out.

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

## The two providers in the Even app

The Even app lets you pick a provider per session, and the choice decides what runs on your machine, so even-hermes prints both routes when it starts and `even-hermes doctor` repeats them.

- **Codex** goes to Hermes through the `codex app-server` shim (or to your real Codex with `providers.codex`, below). Tool rows read `Shell <label>`.
- **Claude** is yours to decide with `providers.claude`:

| `providers.claude` | What "Claude" on the glasses runs |
|---|---|
| `"claude"` (default) | The real Claude Code that Even Terminal ships, untouched, on whatever Anthropic login or API key is on that machine. Your usage, your bill. The first reply of each new session starts with a one-line heads-up naming the machine and the kind of account, so nobody learns it from an invoice. |
| `"hermes"` | Hermes again, through a `claude` shim that speaks the Claude Agent SDK's stream-json protocol. This is the nicer HUD: rows keep the Hermes tool's own name (`browser_navigate example.com/pricing`), Hermes todos drive the task-progress display, and every turn reports a cost of 0. In this mode the provider also gets a config home with no Anthropic login in it and no `ANTHROPIC_*` variables, and the shim never forwards to a real Claude Code, so nothing on the glasses can reach a Claude account. |

### Switching a provider back to the real thing

Both are one line in `~/.even-hermes/config.json`, then restart even-hermes (`systemctl --user restart even-hermes` if you run it as a service). `even-hermes doctor` shows what each provider will run before you put the glasses on.

```json
{
  "providers": {
    "claude": "claude",
    "codex": "codex"
  }
}
```

- `"claude": "claude"` runs the real Claude Code (with the heads-up line); `"claude": "hermes"` sends it to Hermes. You need a Claude login or `ANTHROPIC_API_KEY` on that machine for the real one, exactly as with plain Even Terminal.
- `"codex": "codex"` hands the Codex provider to the real `codex` on your PATH, untouched; `"codex": "hermes"` (default) sends it to Hermes. There is no heads-up line on this side, only the startup banner.
- Sessions do not cross over: a session started on Hermes stays a Hermes session after you flip a provider, and the real CLI will not find it in its own history (and the other way round). Start a new session after switching.
- To drop even-hermes entirely, run `even-terminal` instead of `even-hermes`. Nothing is installed into Even Terminal itself; the shims only exist on the PATH of the process even-hermes starts.

Sessions started on the Claude side in `"hermes"` mode are listed from transcripts the shim writes under `~/.even-hermes/claude-home`.

## Limits

- Hermes runs where Hermes runs. The project directory you pick in Even Terminal is passed as the session `cwd`, but tools execute on the Hermes host.
- Secret, sudo and vault prompts are declined automatically. You cannot type a password on a HUD, and you should not want to.
- In `ws` mode, resuming a session that another client has open takes over its live stream, as any second Hermes client would.
- If the gateway connection drops mid-turn, the turn is reported as failed on the glasses rather than hanging. It may still finish on the Hermes side; resume the session to see.
- `even-terminal codex` (the desktop Codex TUI attached to Even Terminal) is not supported through the shim. Other `codex` subcommands are forwarded to your real Codex if one is installed.
- On the Claude side in `"hermes"` mode every turn is its own short-lived process (that is how the Agent SDK drives a CLI), so each turn re-attaches to the stored Hermes session; approvals there are once-or-deny, with no "always" option.
- Approval and clarify flows are covered by tests against a mock gateway; the rest was verified against Hermes Agent v0.21.3 and Even Terminal 0.10.4. Both protocols are young and may move.

## Development

```bash
npm test
```

`src/translate.js` is the pure event translation, `src/app-server.js` the Codex-facing server, `src/hermes-client.js` the gateway transport.

## Putting a different agent behind it

Nothing on the Even Terminal side is specific to Hermes. If you have your own agent, the glasses-facing half is reusable as it stands and the Hermes half is two files:

- **Keep** `shim/`, `bin/even-hermes.js`, `src/app-server.js` (the `codex app-server` protocol Even Terminal drives) and `src/claude-stream.js` (the Claude Agent SDK stream-json side). These are the parts that took packet-watching to get right.
- **Replace** `src/hermes-client.js` with a client for your agent. The rest of the code only needs `call(method, params)` plus three emitted events: `event` (streamed turn events), `request` (the agent asks the wearer to approve or answer something) and `down`. The calls made are `session.create`, `session.list`, `session.resume`, `session.close`, `prompt.submit` and `session.interrupt`.
- **Adapt** `src/translate.js`, which turns agent events into HUD rows. It reads `thinking.delta`, `reasoning.delta`, `message.delta`, `message.complete`, `tool.generating`, `tool.start`, `tool.complete`, `status.update` and `error`. Emit those names from your client and you may not need to touch it.

`test/mock-gateway.js` is a 34-line fake agent that the test suite runs against, and the quickest way to see the expected shapes. `hud demo` (above) exercises every HUD row with no agent at all, so you can check your glasses before writing any code.

What the HUD can and cannot show, learned the hard way: only shell and web-search rows print free text, every other tool type shows a fixed word, there is no channel for thinking text or a free-form status line, and token usage is only read at the end of a turn.

Not affiliated with Even Realities, Nous Research, OpenAI or Anthropic.

## License

MIT
