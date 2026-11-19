/**
 * DSH Delegate — bootstrap host plugin.
 *
 * Installing this plugin sets up the same things as the install script. server/
 * carries the whole runtime (lib/, bin/, assets/), and on every DSH start this:
 *
 *   1. runs `install` from that copy when $DSH_HOME/bridge is missing or older than
 *      the plugin: the runtime, the skill, the delegation notes, the `dsh` launcher
 *      and the MCP entries of Claude Desktop, Claude Code and Codex. Otherwise it
 *      only re-checks those MCP entries, which are written only when they differ;
 *   2. starts the local service when it is not running: the API behind the panel
 *      and the dashboard where models and keys are set.
 *
 * DSH does not wait for any of it; the last run is logged to
 * $DSH_HOME/delegate-plugin.log. Config (cordis.patch.yml): wireClients (true),
 * startService (true), autostart (false; like `install --autostart`), usageHooks
 * (false; like `install --usage-hooks`).
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server');
const CLIENTS = ['claude-desktop', 'claude-code', 'codex'];

function resolveDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const home = process.env.USERPROFILE || process.env.HOME || '.';
  return path.join(home, '.dsh');
}

function readVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** -1 / 0 / 1 for x.y.z versions; a pre-release suffix is ignored. */
export function compareVersions(a, b) {
  const parts = (value) => String(value).split('-')[0].split('.').map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0) ? 1 : -1;
  }
  return 0;
}

/** Install from this plugin when the bridge is missing, incomplete or older. */
export function needsInstall(bridge = path.join(resolveDshHome(), 'bridge'), server = SERVER) {
  const complete = ['bin/dsh-delegate.js', 'lib/mcp.js'].every((file) => fs.existsSync(path.join(bridge, file)));
  const have = readVersion(bridge);
  return !complete || !have || compareVersions(readVersion(server), have) > 0;
}

/**
 * The Node DSH ships for its own runtime:
 *   Windows  <app>/resources/runtime/<arch>/primary-runtime/dependencies/node/bin/node.exe
 *   macOS    <App>.app/Contents/Resources/runtime/[<arch>/]primary-runtime/dependencies/node/bin/node
 */
export function bundledNode(execPath, platform = process.platform, arch = process.arch) {
  const resources =
    platform === 'darwin'
      ? path.join(path.dirname(path.dirname(execPath)), 'Resources')
      : path.join(path.dirname(execPath), 'resources');
  const exe = platform === 'win32' ? 'node.exe' : 'node';
  for (const base of [path.join(resources, 'runtime', arch), path.join(resources, 'runtime')]) {
    const candidate = path.join(base, 'primary-runtime', 'dependencies', 'node', 'bin', exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * A real Node for the clients and for our own processes. DSH runs plugins with its
 * app binary acting as Node (process.versions.electron), which a client cannot
 * start as plain node. Without a Node on PATH (the norm for apps started from the
 * Dock), DSH's own Node does.
 */
export function resolveNodePath({
  execPath = process.execPath,
  versions = process.versions,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
} = {}) {
  if (env.DSH_DELEGATE_NODE && fs.existsSync(env.DSH_DELEGATE_NODE)) return env.DSH_DELEGATE_NODE;
  if (!versions.electron) return execPath;
  const exts = platform === 'win32' ? ['.exe', ''] : [''];
  for (const dir of (env.PATH || '').split(platform === 'win32' ? ';' : ':')) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `node${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return bundledNode(execPath, platform, arch);
}

/** Our child processes run on a real Node, not as DSH's Electron. */
function childEnv() {
  const env = { ...process.env, DSH_HOME: resolveDshHome() };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function run(node, args) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(node, args, { env: childEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (cause) {
      resolve({ code: 1, out: String(cause && cause.message) });
      return;
    }
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.stderr.on('data', (chunk) => {
      out += chunk;
    });
    child.on('error', (cause) => resolve({ code: 1, out: `${out}${cause.message}` }));
    child.on('close', (code) => resolve({ code, out }));
  });
}

/** Two profiles with the plugin (desktop and web) must not install at once. */
function takeLock(file) {
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < 10 * 60 * 1000) return false;
    fs.rmSync(file, { force: true });
  } catch {
    /* no lock yet */
  }
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export async function bootstrap(config = {}) {
  const home = resolveDshHome();
  const bridge = path.join(home, 'bridge');
  const node = resolveNodePath();
  const summary = { node, installed: false, wired: false, service: false };
  const lines = [`${new Date().toISOString()} dsh-delegate ${readVersion(SERVER) || '?'}  ${HERE}`];

  if (!node) {
    lines.push('找不到 Node：装 Node.js，或设置 DSH_DELEGATE_NODE 指向 node 可执行文件。');
  } else {
    lines.push(`Node: ${node}`);
    fs.mkdirSync(home, { recursive: true });
    if (needsInstall(bridge)) {
      const lock = path.join(home, 'delegate-plugin.lock');
      if (takeLock(lock)) {
        try {
          const args = [path.join(SERVER, 'bin', 'dsh-delegate.js'), 'install', '--no-dsh-plugin'];
          if (config.wireClients === false) args.push('--no-clients');
          if (config.autostart) args.push('--autostart');
          if (config.usageHooks) args.push('--usage-hooks');
          const result = await run(node, args);
          summary.installed = result.code === 0;
          lines.push(`install 退出码 ${result.code}`, result.out.trim());
        } finally {
          fs.rmSync(lock, { force: true });
        }
      } else {
        lines.push('另一个 DSH profile 正在安装，这次跳过。');
      }
    } else if (config.wireClients !== false) {
      const targets = require('./server/lib/targets.js');
      const ctx = {
        nodePath: node,
        mcpPath: path.join(bridge, 'lib', 'mcp.js'),
        cliPath: path.join(bridge, 'bin', 'dsh-delegate.js'),
        dshHome: home,
      };
      const results = targets.applyAll(CLIENTS, ctx, { dryRun: false });
      summary.wired = true;
      lines.push(`客户端：${results.map((item) => `${item.target}:${item.status}`).join(', ')}`);
    }

    const cli = path.join(bridge, 'bin', 'dsh-delegate.js');
    if (config.startService !== false && fs.existsSync(cli)) {
      // `daemon` returns at once when the service already runs.
      try {
        spawn(node, [cli, 'daemon'], { detached: true, stdio: 'ignore', windowsHide: true, env: childEnv() }).unref();
        summary.service = true;
        lines.push('本机服务：已在运行，或已启动');
      } catch (cause) {
        lines.push(`本机服务没能启动：${cause.message}`);
      }
    }
  }

  try {
    fs.writeFileSync(path.join(home, 'delegate-plugin.log'), `${lines.join('\n')}\n`);
  } catch {
    /* the summary still reaches the DSH log */
  }
  return summary;
}

export function apply(ctx, config = {}) {
  bootstrap(config).then(
    (summary) =>
      ctx.logger?.info?.(
        `dsh-delegate: node=${summary.node || 'none'} installed=${summary.installed} wired=${summary.wired} ` +
          `service=${summary.service}（详情见 $DSH_HOME/delegate-plugin.log）`,
      ),
    (cause) => ctx.logger?.warn?.(`dsh-delegate: ${cause && cause.message ? cause.message : cause}`),
  );
}
