# dsh-delegate

[中文](README.md) | English

**Let Claude hand the grunt work to a DeepSeek Harness (DSH) subagent running on your machine.**

Claude Desktop, Claude Code and Codex get three MCP tools: `dsh_task` for a single task, `dsh_parallel` to fan out, and `dsh_job` to follow long jobs. Claude makes the decisions; DSH does the legwork: bulk file edits, small scripts, explaining errors, running checks and summarising the results. That work runs on a cheaper model, in its own process and sandbox, and only the conclusion comes back, so it doesn't eat Claude's context.

```text
Claude Desktop / Claude Code / Codex
        │  MCP (stdio)
        ▼
  dsh-delegate ──spawn──► dsh --profile headless  × N    own process · sandbox · resumable
        ▲                          │
        └──── status line + answer / job id ┘
```

## Features

- **Zero dependencies**: Node.js 18+ is all it needs; there is no `npm install` step.
- **Host timeouts don't kill long tasks**: a call waits up to 45 s, then returns `job=…` (not a failure) and you keep waiting with `dsh_job`.
- **Parallel work with separate write areas**: `dsh_parallel` runs every task at once by default. Each task can take a `write_scope`: it can read the whole repo but only write its own directory, and the DSH sandbox rejects writes outside it.
- **Resumable**: the status line carries a `session_id`; pass it back to continue the same session.
- **Visible usage**: tokens and throughput for every run, read from the DSH session log.
- **Local dashboard**: watch what subagents are doing, switch models and enter keys in the browser. Installed as a DSH plugin, it also adds a panel above the DSH composer.

## Requirements

- Node.js ≥ 18
- DSH, either the desktop app (DSH NEXT) or the CLI (`npm i -g @deepseek-ai/dsh`)
- A model credential that headless DSH can read (see [Credentials](#credentials))

## Install

### A. One-shot script: if you mainly use Claude / Codex

Windows (PowerShell or cmd):

```powershell
git clone https://github.com/zzm1234560621-prog/dsh-delegate
cd dsh-delegate
.\install.cmd --dry-run    # see what would change first
.\install.cmd
```

macOS / Linux:

```bash
git clone https://github.com/zzm1234560621-prog/dsh-delegate
cd dsh-delegate
./install.sh --dry-run
./install.sh
```

Both scripts take the same flags (on Windows, `-DryRun` / `-Targets` work too):

| Flag | Effect |
|---|---|
| `--dry-run` | List the files that would change, write nothing |
| `--targets=claude-code,codex` | Wire only these clients (default: all three) |
| `--copy-credentials` | Copy the `DEEPSEEK_API_KEY` saved in DSH into the `.env` headless reads |
| `--autostart` | Start the local dashboard service at login |

A misspelled flag aborts instead of installing.

Then **fully quit and reopen Claude Desktop**, or start a new Claude Code session. Once `dsh_task` / `dsh_parallel` / `dsh_job` show up in the tool list, you're set. After a `git pull`, run the script again; configs that haven't changed are left untouched.

### B. DSH plugin: if you mainly use DSH

```bash
dsh plugin --profile <profile> add "file:/path/to/dsh-delegate/plugin"
```

Restart that profile. The plugin also wires Claude / Codex (writing only when a config differs, with a backup first) and adds a delegation panel above the DSH composer. Set `wireClients: false` in the plugin config to keep it away from external clients.

| You mainly use | Install |
|---|---|
| Claude Desktop / Claude Code / Codex | A |
| DSH | B (wires Claude as well) |

### What the installer touches

| Location | What |
|---|---|
| `~/.dsh/bridge/` | Runtime: MCP server, CLI, dashboard |
| `dsh` launcher | Created only when DSH is desktop-only and no `dsh` is on PATH; an existing `dsh` is never overwritten or deleted |
| `~/.dsh/skills/dsh-delegate/`, `~/.claude/skills/dsh-delegate/` | Skill: what is worth delegating and how to write the task |
| `~/.dsh/AGENTS.md`, `~/.claude/CLAUDE.md` | Appends one marked block (`<!-- dsh-delegate:start -->` … `end`); reinstalls replace only that block |
| Claude Desktop config, `~/.claude.json`, `~/.codex/config.toml` | Adds an MCP server named `dsh` |

Files are written only when their content actually changes, and a `*.bak-dsh-delegate-<time>` backup is kept next to each one first.

### Other MCP clients

Cursor, Windsurf and any other stdio MCP client can be added by hand. This prints ready-to-paste snippets with your machine's paths:

```bash
node ~/.dsh/bridge/bin/dsh-delegate.js print-config
```

## Credentials

Headless DSH reads only the launch environment, `<cwd>/.env` and `$DSH_HOME/.env` (default `~/.dsh/.env`). **It does not read keys saved in the DSH desktop app.**

```powershell
# Windows
"DEEPSEEK_API_KEY=sk-..." | Add-Content "$env:USERPROFILE\.dsh\.env"
```

```bash
# macOS / Linux
echo 'DEEPSEEK_API_KEY=sk-...' >> ~/.dsh/.env
```

Or install with `--copy-credentials`. To use another model provider, pick it and enter its key in the dashboard. Variable names starting with `DSH_` are reserved by DSH and can't go in `.env`.

## Usage

The installer puts the delegation rules into `~/.claude/CLAUDE.md` and the skill, so Claude decides on its own when to delegate. You can also just ask:

```text
Use dsh to switch every double-quoted string in src/**/*.js to single quotes, then run npx eslint src and report.
```

```text
Fan out three ways: modules a, b and c each on their own, write scopes src/a, src/b and src/c.
```

Every result starts with a status line:

```text
[DSH ok · 22.4s · exit 0 · workspace-write · write:src/a · 12.3k tok（出 1.8k）· 82 tok/s · session-…]
Edited 14 files; eslint passes.
```

(`出` = output tokens; the server's status text is in Chinese.)

### The three tools

| Tool | Purpose | Common arguments |
|---|---|---|
| `dsh_task` | Delegate one self-contained task | `task`, `cwd`, `write_scope`, `session_id` (resume), `mode: "async"`, `no_web` |
| `dsh_parallel` | Delegate several independent tasks at once | `tasks[]` (each may have `title`, `write_scope`, `cwd`), `max_concurrency` |
| `dsh_job` | Wait for or cancel a long job | `job_id`, `wait_ms`, `action: "cancel"` |

- A call waits up to 45 s (`soft_wait_ms` changes that; `0` waits until done). If the task isn't finished it returns `job=…`. **That is not a failure**: keep waiting with `dsh_job`.
- Tasks have no timeout by default; only an explicit `timeout_ms` starts a clock.
- Subagents can read the whole repo but write only their working directory or `write_scope`. The defaults are the `workspace-write` sandbox and unattended runs (`--approval-policy never`).
- `dsh_job` with `cancel` stops only that job's subagents and the processes they started; other jobs keep running.

## Dashboard and local service

Below, `dsh-delegate` means `node ~/.dsh/bridge/bin/dsh-delegate.js` (on Windows `node "$env:USERPROFILE\.dsh\bridge\bin\dsh-delegate.js"`).

```bash
dsh-delegate ui --open         # start the service and open the dashboard: http://127.0.0.1:7788
dsh-delegate daemon --no-ui    # API only, no dashboard
dsh-delegate autostart on      # start at login
dsh-delegate status
```

The service listens on `127.0.0.1` only and accepts requests only from local processes and local pages (the dashboard itself, the DSH web UI). Requests that other websites send from your browser get a 403. If you really need another origin, add it with the `DSH_DELEGATE_ALLOWED_ORIGINS` environment variable.

## Checks and tests

```bash
dsh-delegate doctor --run    # check the setup, then run one real task (one model call)
npm test                     # MCP handshake smoke test
npm run test:all             # smoke + install/protocol edge cases + regression suite, all offline, no model calls
node test/live.js            # full protocol run using Claude Desktop's real config (one model call)
```

## Uninstall

```bash
dsh-delegate uninstall --remove-runtime
dsh plugin --profile <profile> remove dsh-delegate    # if you installed the plugin
```

Uninstall removes the skill, the instruction block, the launcher it created, and every client's `dsh` entry that points at this tool, and turns off autostart. Someone else's entry with the same name is left alone. Add `--keep-clients` to keep the client configs.

## Known limits

- The subagent can't see your conversation with Claude, so the task has to stand on its own. Each call starts a new session unless you pass `session_id`.
- The DSH sandbox always allows writes to the system temp directory (verified on Windows with `%TEMP%`); `write_scope` doesn't cover it. Don't test write scopes inside a temp directory.
- Concurrency is unlimited by default. With many tasks, keep an eye on memory and model rate limits; `max_concurrency` caps it.
- Windows is the main test platform. Desktop-app discovery on macOS / Linux hasn't been verified on real machines yet.

## FAQ

**No `dsh_*` tools in the list**: fully quit Claude Desktop (including the tray icon) and reopen it, or start a new Claude Code session. If they're still missing, run `dsh-delegate doctor`.

**`MISSING_CREDENTIAL`**: headless DSH can't find a key; see [Credentials](#credentials).

**`job=dsh-…`**: the task is still running; keep waiting with `dsh_job`.

**Dashboard won't open**: the service isn't running, so start it with `dsh-delegate ui --open`. If port 7788 is taken it moves to 7789 and up; `dsh-delegate status` shows the real address.

## License

MIT
