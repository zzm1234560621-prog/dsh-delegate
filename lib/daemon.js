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

async function run(options = {}) {
  const port = Number(options.port) || 7788;
  const withUi = options.ui !== false;
  const { start } = require('./ui');
  // strictPort: never drift to 7789+; the caller decides what a busy port means.
  const { server, url } = await start({ port, serveUi: withUi, strictPort: true });

  const state = { pid: process.pid, port, ui: withUi, url, startedAt: Date.now() };
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

  return { url, server };
}

module.exports = { run, status, stateFile, readState, logFile, logLine };
