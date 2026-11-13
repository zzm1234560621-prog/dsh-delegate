/**
 * DSH Delegate — bootstrap host plugin.
 *
 * Installing the bundle gives DSH its own MCP client (see cordis.patch.yml).
 * This host plugin additionally wires *external* clients (Claude Desktop,
 * Claude Code, Codex) to the same MCP server, so a user who installs only the
 * plugin can call DSH from Claude without running the standalone installer.
 *
 * It is idempotent and backs up every config it touches. Set
 * `wireClients: false` in the plugin config to opt out.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));

function resolveDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const home = process.env.USERPROFILE || process.env.HOME || '.';
  return path.join(home, '.dsh');
}

/**
 * The MCP server this bundle ships. Derived from the plugin's own location, so it
 * works no matter which profile installed it or whether DSH_PROFILE_DIR is set.
 */
function resolveMcpPath() {
  // Prefer the standalone deployment: its path survives profile reinstall and is
  // what other clients on this machine already point at. Fall back to the copy
  // that ships inside this bundle.
  const bridge = path.join(resolveDshHome(), 'bridge', 'lib', 'mcp.js');
  if (fs.existsSync(bridge)) return bridge;
  return path.join(HERE, 'server', 'lib', 'mcp.js');
}

/** External clients must spawn a real Node, not the Electron app they see as execPath. */
function resolveNodePath() {
  if (process.env.DSH_DELEGATE_NODE && fs.existsSync(process.env.DSH_DELEGATE_NODE)) {
    return process.env.DSH_DELEGATE_NODE;
  }
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, `node${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function apply(ctx, config = {}) {
  if (config.wireClients === false) {
    ctx.logger?.info?.('dsh-delegate: wireClients disabled, skipping client wiring');
    return;
  }

  const nodePath = resolveNodePath();
  if (!nodePath) {
    ctx.logger?.warn?.('dsh-delegate: no node.exe on PATH; skipping external client wiring');
    return;
  }

  let targets;
  try {
    targets = require('./server/lib/targets.js');
  } catch (cause) {
    ctx.logger?.warn?.(`dsh-delegate: cannot load client targets: ${cause.message}`);
    return;
  }

  const mcpPath = resolveMcpPath();
  if (!fs.existsSync(mcpPath)) {
    ctx.logger?.warn?.(`dsh-delegate: MCP server missing at ${mcpPath}`);
    return;
  }

  try {
    const results = targets.applyAll(
      ['claude-desktop', 'claude-code', 'codex'],
      { nodePath, mcpPath, dshHome: resolveDshHome() },
      { dryRun: false },
    );
    const summary = results.map((item) => `${item.target}:${item.status}`).join(', ');
    ctx.logger?.info?.(`dsh-delegate: wired external clients (${summary}) → node ${mcpPath}`);
  } catch (cause) {
    ctx.logger?.warn?.(`dsh-delegate: client wiring failed: ${cause.message}`);
  }
}
