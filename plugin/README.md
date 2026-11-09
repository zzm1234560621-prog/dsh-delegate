# DSH Delegate (plugin bundle)

A **configuration-only DSH bundle** that mounts [dsh-delegate](../README.md) as an MCP
server inside a profile. After install, every session in that profile gets:

- `mcp__dsh__dsh_task` — hand one self-contained task to a local subagent
- `mcp__dsh__dsh_parallel` — fan out several tasks with per-task write scopes
- `mcp__dsh__dsh_job` — keep polling long runs instead of timing out

The MCP server ships inside this package (`server/lib/mcp.js`), so no separate
installer is required for the plugin path.

## Install

```bash
# from this directory
dsh plugin --profile <profile> add "file:$(pwd)"

# or once published to npm
dsh plugin --profile <profile> add dsh-delegate
```

Then restart that profile (Desktop: quit the app and reopen). `dsh --profile <profile> --dump-config`
should show the inserted `dsh-delegate-mcp` row.

## Requirements

- DSH 0.2.1-rc.5 or newer (uses `@deepseek-ai/dsh-mcp-client`)
- An API key the headless profile can read: `$DSH_HOME/.env` or the launching
  environment (`DEEPSEEK_API_KEY`, or your provider's variable)

## What it does not do

The plugin only mounts the MCP tools. The standalone installer adds more:
the `dsh` CLI shim, the skill/instruction files, client wiring for Claude Desktop /
Claude Code / Codex, and the local dashboard (`dsh-delegate ui`). Run
`dsh-delegate install` if you want those too.

## Files

| Path | Purpose |
|---|---|
| `cordis.patch.yml` | inserts `@deepseek-ai/dsh-mcp-client` with a stdio server pointing at `server/lib/mcp.js` |
| `server/` | the bundled MCP server (Node ≥18, no dependencies) |
| `locale/*.json` | plugin market title/description |
| `icon.svg` | market artwork |

## License

MIT
