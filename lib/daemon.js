'use strict';

/**
 * Persistent local service. Runs the HTTP API (and optionally the dashboard)
 * so it can outlive any single agent client.
 *
 *   dsh-delegate daemon              # API + 看板
 *   dsh-delegate daemon --no-ui      # 只跑服务，不开看板
 *
 * Every start, and every exit the process can see, is appended to
 * $DSH_HOME/delegate-daemon.log. When the last line for a pid is its start, the
 * service was killed outright (taskkill /F, Stop-Process -Force, a closed console).
 */

const fs = require('node:fs');
const path = require('node:path');
const { dshHome } = require('./dsh');

function stateFile() {
  return path.join(dshHome(), 'delegate-daemon.json');
}

function logFile() {
  return path.join(dshHome(), 'delegate-daemon.log');
}

/** One timestamped line; a single rotation at 512 KB keeps it small. Never throws. */
function logLine(text) {
  try {
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > 512 * 1024) fs.renameSync(file, `${file}.1`);
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(file, `${new Date().toISOString()} pid ${process.pid} ${text}\n`);
  } catch {
    /* logging must never take the service down */
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause.code === 'EPERM';
  }
}

function status() {
  const state = readState();
  if (!state) return { running: false, file: stateFile() };
  return { ...state, running: pidAlive(state.pid), file: stateFile() };
}

function packageVersion() {
  try {
    return require('../package.json').version;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait up to timeoutMs for a process to be gone; true once it is. */
async function waitForExit(pid, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() > deadline) return false;
    await sleep(150);
  }
  return true;
}

/** The pid the service on this port reports about itself, or null. */
function servicePid(port) {
  return new Promise((resolve) => {
    const request = require('node:http').get({ host: '127.0.0.1', port, path: '/api/service', timeout: 3000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).pid || null);
        } catch {
          resolve(null);
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}

function samePath(a, b) {
  const [x, y] = [path.resolve(a), path.resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * After an upgrade, a running service still runs the old code it loaded. When its
 * version differs from `version`, start `cli daemon --replace=<old pid>` (it waits
 * for the old process to go, then takes the same port) and stop the old one. Only
 * a service that answers on its port with the pid of the state file is stopped, and
 * only one started from `cli` (or from before the state said where it came from):
 * a service run from a development checkout is left alone.
 */
async function restartIfOutdated({ version, node, cli, dryRun = false }) {
  const current = status();
  if (!current.running) return { status: 'not-running' };
  if (current.version && current.version === version) return { status: 'current', file: current.url };
  if (current.cli && !samePath(current.cli, cli)) {
    return { status: 'kept', file: current.url, detail: `服务运行的是 ${current.cli}，不是这份运行时` };
  }
  const change = `${current.url}（${current.version || '旧版'} → ${version}）`;
  if (dryRun) return { status: 'would-restart', file: change };
  if ((await servicePid(current.port)) !== current.pid) {
    return { status: 'FAILED', file: current.url, detail: '端口上的服务和状态文件对不上，没有动它' };
  }
  const args = [cli, 'daemon', `--replace=${current.pid}`, `--port=${current.port}`];
  if (current.ui === false) args.push('--no-ui');
  try {
    require('node:child_process').spawn(node, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    process.kill(current.pid);
  } catch (cause) {
    return { status: 'FAILED', file: current.url, detail: cause.message };
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const next = status();
    if (next.running && next.pid !== current.pid) return { status: 'restarted', file: change };
    await sleep(200);
  }
  return { status: 'FAILED', file: current.url, detail: '新服务 15 秒内没起来；看门狗或 dsh-delegate ui 会再拉起' };
}

async function run(options = {}) {
  const port = Number(options.port) || 7788;
  const withUi = options.ui !== false;
  const { start } = require('./ui');
  // strictPort: never drift to 7789+; the caller decides what a busy port means.
  const { server, url } = await start({ port, serveUi: withUi, strictPort: true });

  // version and cli let an upgrade tell an outdated service from a current one.
  const state = { pid: process.pid, port, ui: withUi, url, startedAt: Date.now(), version: packageVersion(), cli: process.argv[1] };
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`);
  logLine(`started ${url} (${withUi ? 'api + dashboard' : 'api only'})`);

  try {
    process.stdout.write(
      `dsh-delegate 服务已启动: ${url}\n` +
        `  模式: ${withUi ? 'API + 看板' : '仅 API（--no-ui）'}\n` +
        `  pid: ${process.pid} · 状态文件: ${stateFile()}\n` +
        '  Ctrl+C 退出。\n',
    );
  } catch {
    /* no console to write to */
  }

  let stopping = false;
  const stop = (reason) => {
    if (stopping) return;
    stopping = true;
    logLine(`stopping: ${reason}`);
    try {
      const current = readState();
      if (current && current.pid === process.pid) fs.rmSync(stateFile(), { force: true });
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref?.();
  };
  // SIGHUP is what Windows sends when the console window closes; SIGBREAK is Ctrl+Break.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(signal, () => stop(signal));
    } catch {
      /* not available on this platform */
    }
  }
  process.on('uncaughtException', (cause) => {
    logLine(`uncaught exception: ${cause && cause.stack ? cause.stack : cause}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (cause) => {
    logLine(`unhandled rejection: ${cause && cause.stack ? cause.stack : cause}`);
  });
  process.on('exit', (code) => logLine(`exit code ${code}`));

  // Auto-resume: retryable failures (gateway timeouts) are re-dispatched in the
  // background, a couple at a time so the provider is not hammered again.
  const resumeTimer = setInterval(() => {
    const resume = require('./resume');
    resume
      .autoResumeTick()
      .then((outcome) => {
        if (outcome.resumed) logLine(`auto-resume started ${outcome.resumed}`);
      })
      .catch((cause) => logLine(`auto-resume failed: ${cause.message}`));
  }, 30_000);
  resumeTimer.unref?.();

  return { url, server };
}

module.exports = { run, status, stateFile, readState, logFile, logLine, waitForExit, restartIfOutdated };
