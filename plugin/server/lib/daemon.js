'use strict';

/**
 * Persistent local service. Runs the HTTP API (and optionally the dashboard)
 * so it can outlive any single agent client.
 *
 *   dsh-delegate daemon              # API + 看板
 *   dsh-delegate daemon --no-ui      # 只跑服务，不开看板
 */

const fs = require('node:fs');
const path = require('node:path');
const { dshHome } = require('./dsh');

function stateFile() {
  return path.join(dshHome(), 'delegate-daemon.json');
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
  const { server, url } = await start({ port, serveUi: withUi });

  const state = { pid: process.pid, port, ui: withUi, url, startedAt: Date.now() };
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), `${JSON.stringify(state, null, 2)}\n`);

  process.stdout.write(
    `dsh-delegate 服务已启动: ${url}\n` +
      `  模式: ${withUi ? 'API + 看板' : '仅 API（--no-ui）'}\n` +
      `  pid: ${process.pid} · 状态文件: ${stateFile()}\n` +
      '  Ctrl+C 退出。\n',
  );

  const stop = () => {
    try {
      const current = readState();
      if (current && current.pid === process.pid) fs.rmSync(stateFile(), { force: true });
    } catch {
      /* ignore */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref?.();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  return { url, server };
}

module.exports = { run, status, stateFile, readState };
