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
- A model API key, set in the dashboard after install (see [Model and key setup](#model-and-key-setup))

## Install

Both ways do the same job: connect Claude Desktop, Claude Code and Codex to your local DSH. DSH's own subagents use its built-in subagent tools and don't go through this project.

Both ways install the same things; pick either one:

- **A. Install package**: sets up everything and adds the plugin to the DSH desktop app. The plugin can only be added while DSH isn't running. If DSH is running, quit it and run the install again, or install the plugin from the DSH plugin market.
- **B. DSH plugin**: install it from the DSH plugin market. When DSH starts, the plugin installs the same set from the runtime it carries, then starts the local service.

The full set:
- the MCP entries of the three clients;
- the skill and delegation rules that teach Claude what to delegate;
- the `dsh` command-line launcher;
- the local service (dashboard, key setup page);
- the delegation panel above the DSH composer.

Both share the runtime in `~/.dsh/bridge`, and the newer version wins. On every DSH start the plugin also re-checks the client configs.

### A. Install script

**One-click install, no git needed**: from [Releases](https://github.com/zzm1234560621-prog/dsh-delegate/releases/latest), download:

| System | Download | Then |
|---|---|---|
| Windows | `dsh-delegate-install.bat` | Double-click it. It downloads and installs the latest package, deletes the temporary files and keeps the window open on the result |
| macOS | `dsh-delegate.zip` | Double-click to unzip, then double-click `install.command` inside; it installs in Terminal |
| Linux | `dsh-delegate.zip` | Unzip it and run `sh install.sh` in the unzipped folder |

- Windows: if the browser says the file isn't commonly downloaded, choose Keep. If double-clicking shows "Windows protected your PC", click More info → Run anyway.
- If the `.bat` can't download the package (GitHub unreachable): turn on your proxy and run it again, or get `dsh-delegate.zip` another way, run `set DSH_DELEGATE_ZIP=C:\path\to\dsh-delegate.zip` in cmd, then run the `.bat`. The flags below work too, e.g. `dsh-delegate-install.bat --autostart`.
- If macOS blocks the first double-click ("cannot be opened" / "could not verify the developer"): on macOS 14 and earlier, right-click → Open; from macOS 15, click Open Anyway at the bottom of System Settings → Privacy & Security. Or run `sh install.sh` in Terminal from the unzipped folder, which does the same.
- There is no standalone Mac installer file: browsers save downloads without the execute permission, so it wouldn't run on double-click. That is why `install.command` ships inside the zip.
- `dsh-delegate.zip` and `dsh-delegate-v<version>.zip` are the same package. On Windows you can also unzip it and double-click `install.cmd`.

**Or clone with git**, Windows (PowerShell or cmd):

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
| `--autostart` | Keep the local dashboard service running: start it at login, bring it back if it stops |
| `--usage-hooks` | Add quota recording and delegation reminders to Claude Code (edits `~/.claude/settings.json`) |

A misspelled flag aborts instead of installing.

Then **fully quit and reopen Claude Desktop**, or start a new Claude Code session. Once `dsh_task` / `dsh_parallel` / `dsh_job` show up in the tool list, you're set. If you haven't set a key yet, continue with [Model and key setup](#model-and-key-setup). To update, download the new zip (or `git pull`) and run the script again; configs that haven't changed are left untouched.

### B. DSH plugin

```bash
dsh plugin --profile <profile> add "file:/path/to/dsh-delegate/plugin"
```

Or search for dsh-delegate in the DSH plugin market. Restart DSH after installing.

On its first start the plugin runs the installer from the runtime it carries, so you get the same result as A. On every later start it:
- reinstalls only when the plugin is newer than `~/.dsh/bridge`;
- otherwise only re-checks the three clients' configs, writing (after a backup) only when one differs;
- starts the local service if it isn't running, since the panel and the dashboard need it.

The plugin looks for Node in this order: `DSH_DELEGATE_NODE`, `node` on PATH, then the Node that ships with DSH. So it works without Node.js installed. Each run is logged to `~/.dsh/delegate-plugin.log`.

The delegation panel shows the local service's status and the tasks Claude / Codex delegated; DSH's own subagents don't appear there.

Plugin settings (in DSH's plugin settings):

| Setting | Default | Effect |
|---|---|---|
| `wireClients` | `true` | Write the Claude Desktop, Claude Code and Codex entries |
| `startService` | `true` | Start the local service with DSH |
| `autostart` | `false` | Start the service at login and restart it if it stops, like `--autostart` |
| `usageHooks` | `false` | Quota reminders in Claude Code, like `--usage-hooks` |

### What the installer touches

| Location | What |
|---|---|
| `~/.dsh/bridge/` | Runtime: MCP server, CLI, dashboard |
| `dsh` launcher | Created only when DSH is desktop-only and no `dsh` is on PATH; an existing `dsh` is never overwritten or deleted |
| `~/.dsh/skills/dsh-delegate/`, `~/.claude/skills/dsh-delegate/` | Skill: what is worth delegating and how to write the task |
| `~/.dsh/AGENTS.md`, `~/.claude/CLAUDE.md` | Appends one marked block (`<!-- dsh-delegate:start -->` … `end`); reinstalls replace only that block |
| Claude Desktop config, `~/.claude.json`, `~/.codex/config.toml` | Adds an MCP server named `dsh` |
| `~/.claude/settings.json` (only with `--usage-hooks`) | statusLine and UserPromptSubmit hook |

Files are written only when their content actually changes, and a `*.bak-dsh-delegate-<time>` backup is kept next to each one first.

### Other MCP clients

Cursor, Windsurf and any other stdio MCP client can be added by hand. This prints ready-to-paste snippets with your machine's paths:

```bash
node ~/.dsh/bridge/bin/dsh-delegate.js print-config
```

## Model and key setup

Headless DSH can't read the keys saved in the DSH desktop app, so after installing, **set the model and key once in the dashboard**.

1. Open the dashboard, or click 打开看板 (open dashboard) on the DSH delegation panel.

   ```powershell
   node "$env:USERPROFILE\.dsh\bridge\bin\dsh-delegate.js" ui --open    # Windows
   ```

   ```bash
   node ~/.dsh/bridge/bin/dsh-delegate.js ui --open                    # macOS / Linux
   ```

2. In 执行模型与凭据 (model and credentials), pick the provider, the model and the reasoning effort.
3. Click 用当前供应商的变量名 (use this provider's variable name), paste the key into 值 (value) and click 写入 .env (write to .env).
4. Click 保存模型 (save model). The next delegated task picks it up.

The dashboard writes the key to `$DSH_HOME/.env` (default `~/.dsh/.env`) and the model to the headless profile. Switch providers here too: editing `.env` alone doesn't change the model. Variable names starting with `DSH_` are reserved by DSH and get rejected.

If you only use DeepSeek, installing with `--copy-credentials` also works: it copies the `DEEPSEEK_API_KEY` saved in DSH into `.env`.

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

- A call waits up to 45 s (`soft_wait_ms` changes that, up to 50 s; `0` waits until done, but the host's per-call timeout can cut it off). If the task isn't finished it returns `job=…`. **That is not a failure**: keep waiting with `dsh_job`.
- If the host reconnects and dsh-delegate restarts, `dsh_job` still answers for the old job id: finished results come back from the run records in `~/.dsh/delegate-runs`, and jobs still running when the server exited are reported as interrupted.
- Tasks have no timeout by default; only an explicit `timeout_ms` starts a clock.
- Subagents can read the whole repo but write only their working directory or `write_scope`. The defaults are the `workspace-write` sandbox and unattended runs (`--approval-policy never`).
- `dsh_job` with `cancel` stops only that job's subagents and the processes they started; other jobs keep running.

## Delegate more when quota runs low

When the Claude Code or Codex plan quota runs low, dsh-delegate reminds them to hand more work to DSH.

| Client | Where the quota comes from | How the reminder arrives |
|---|---|---|
| Claude Code | Used percentages for the 5-hour and weekly windows in the data Claude Code passes to the statusline (claude.ai Pro / Max / Ultra plans only); `dsh-delegate statusline` records them to `$DSH_HOME/quota/claude.json` and shows the quota and current tier in the Claude Code footer. The desktop Code tab never runs the statusline, so there an exhausted window is read from the 429 in `~/.claude/projects` session logs (exhausted + reset time only, no percentage) | A UserPromptSubmit hook (`dsh-delegate hook prompt`) adds the reminder to Claude's context on every message |
| Codex | Read directly from its local session log `~/.codex/sessions`; no setup needed | At the start of every new session, the MCP server puts the current quota and delegation requirement into the instructions it gives Codex |
| Claude Desktop | Shares the plan quota with Claude Code and uses the last figures Claude Code recorded, which may be out of date | At MCP server startup, puts the quota and delegation requirement into the instructions it gives Claude |

No login tokens are read.

Tiers: when either window reaches 70% (default), "delegate more": work that can be written as a self-contained instruction goes to DSH first; at 90% (default), "delegate everything": everything except the decisions the model has to make itself goes to DSH. Both thresholds are changed in the dashboard card 额度与派活档位 (quota and delegation tier). Below the thresholds, nothing is added.

Turning it on: install with `--usage-hooks`. It adds a statusLine and this hook to `~/.claude/settings.json`, with a backup first. If you already have your own statusLine, it's left alone and only the hook is added (in that case nothing records Claude's quota; you can forward the input to `dsh-delegate statusline` from your own statusline script). To see the current quota: `dsh-delegate quota`. Uninstall removes the statusLine and hook it added.

Limits: it's only an explicit reminder; whether to delegate is still up to the model. Codex's log format isn't a public interface, so when it can't be read, nothing happens. The Code tab of the Claude desktop app never runs the statusline (verified), so only Claude Code in the terminal updates the percentages; when a desktop session exhausts a window, the dashboard reads that 429 from the session logs instead and shows "exhausted" with the reset time.

## Dashboard and local service

Below, `dsh-delegate` means `node ~/.dsh/bridge/bin/dsh-delegate.js` (on Windows `node "$env:USERPROFILE\.dsh\bridge\bin\dsh-delegate.js"`).

```bash
dsh-delegate ui --open         # start the service and open the dashboard: http://127.0.0.1:7788
dsh-delegate daemon --no-ui    # API only, no dashboard
dsh-delegate autostart on      # start at login, restart it if it stops
dsh-delegate status
dsh-delegate quota             # show Claude / Codex quota and current tier
```

The service listens on `127.0.0.1` only and accepts requests only from local processes, local pages (the dashboard itself, `dsh web`) and the DSH desktop app. Requests that other websites send from your browser get a 403. If you really need another origin, add it with the `DSH_DELEGATE_ALLOWED_ORIGINS` environment variable.

The service doesn't start with Claude or DSH. To keep it running, turn on autostart: `dsh-delegate autostart on`. On Windows that is a scheduled task that starts it at login and checks every 5 minutes, bringing it back if it stopped; on macOS the LaunchAgent restarts it after an abnormal exit; on Linux it only starts at login. Every start and exit of the service is logged to `$DSH_HOME/delegate-daemon.log`.

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

Uninstall removes the skill, the instruction block, the launcher it created, the statusLine and hook it added to Claude Code, and every client's `dsh` entry that points at this tool, and turns off autostart. Someone else's entry with the same name is left alone. Add `--keep-clients` to keep the client configs.

## Known limits

- The subagent can't see your conversation with Claude, so the task has to stand on its own. Each call starts a new session unless you pass `session_id`.
- The DSH sandbox always allows writes to the system temp directory (verified on Windows with `%TEMP%`); `write_scope` doesn't cover it. Don't test write scopes inside a temp directory.
- Concurrency is unlimited by default. With many tasks, keep an eye on memory and model rate limits; `max_concurrency` caps it.
- Windows is the main test platform. On macOS, three ways are tried in order:
  1. The command-line DSH that ships inside the DSH app (`<App>.app/Contents/Resources/runtime/cli/bin/dsh`), run on the Node bundled next to it. This location comes from a user's install on a real Mac.
  2. An installed `dsh` command.
  3. Running the app binary itself as Node.

  None of these has been tested on a real Mac yet. Desktop-app discovery on Linux hasn't been verified on a real machine either.

## FAQ

**No `dsh_*` tools in the list**: fully quit Claude Desktop (including the tray icon) and reopen it, or start a new Claude Code session. If they're still missing, run `dsh-delegate doctor`.

**DSH not found**: point to it with an environment variable: `DSH_DELEGATE_CLI=/path/to/dsh` for the command-line DSH, or `DSH_DELEGATE_APP=/path/to/DSH NEXT(.exe)` for the desktop app. GUI clients such as Claude Desktop and Codex don't see variables set in a terminal.

**`MISSING_CREDENTIAL`**: headless DSH can't find a key; set one in the dashboard, see [Model and key setup](#model-and-key-setup).

**The DSH delegation panel says 服务未连接 (service not connected)**: the local service isn't running. Start it with `dsh-delegate ui --open`, or turn on autostart.

**`job=dsh-…`**: the task is still running; keep waiting with `dsh_job`.

**Dashboard won't open**: the service isn't running, so start it with `dsh-delegate ui --open`. If port 7788 is taken it moves to 7789 and up; `dsh-delegate status` shows the real address.

## License

MIT
