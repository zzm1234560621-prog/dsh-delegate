'use strict';

/**
 * The dsh-delegate plugin in the DSH desktop app's profile ($DSH_HOME/profiles/desktop).
 *
 * `install` adds it there as link:$DSH_HOME/bridge/plugin, so installing with the
 * script also brings the panel inside DSH, the same as installing from the plugin
 * market, and DSH then runs the runtime the script deployed. It only does so when
 * the profile exists (DSH has been opened once) and has no dsh-delegate yet: a
 * market install or a developer's own link stays as it is. DSH wants the app fully
 * quit before `dsh plugin --profile desktop`, so nothing changes while it runs.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { dshHome, runDshSync } = require('./dsh');

const NAME = 'dsh-delegate';
const PROFILE = 'desktop';
const APP_NAMES = ['DSH NEXT', 'DSH', 'DeepSeek Harness'];

function profilePackage() {
  return path.join(dshHome(), 'profiles', PROFILE, 'package.json');
}

/** The dependency spec dsh-delegate has in the desktop profile, or null. */
function currentSpec() {
  try {
    const json = JSON.parse(fs.readFileSync(profilePackage(), 'utf8'));
    return (json.dependencies && json.dependencies[NAME]) || null;
  } catch {
    return null;
  }
}

/** The entry `install` adds: a link to the plugin copy inside the bridge. */
function ownSpec(bridge) {
  return `link:${path.join(bridge, 'plugin').replace(/\\/g, '/')}`;
}

function sameSpec(a, b) {
  const norm = (value) => String(value).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

/**
 * Is the DSH desktop app running? DSH_DELEGATE_DESKTOP_RUNNING=0/1 overrides the
 * check (tests, or an app name not listed here).
 */
function desktopRunning() {
  const forced = process.env.DSH_DELEGATE_DESKTOP_RUNNING;
  if (forced === '0' || forced === '1') return forced === '1';
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).toLowerCase();
      return APP_NAMES.some((name) => out.includes(`"${name.toLowerCase()}.exe"`));
    }
    const out = execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').some((line) => APP_NAMES.some((name) => line.includes(`${name}.app/Contents/MacOS/`)));
  } catch {
    return false;
  }
}

function lastLine(result) {
  const text = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return (text.split('\n').pop() || (result.error && result.error.message) || `退出码 ${result.status}`).slice(0, 160);
}

/** Add the plugin to the desktop profile (see above). */
function add(launch, options = {}) {
  if (!fs.existsSync(profilePackage())) {
    return { status: 'skip', detail: '没有 DSH 桌面版的 profile（没装桌面版，或还没打开过）' };
  }
  const spec = currentSpec();
  if (spec) return { status: 'ok', file: `${NAME}@${spec}`, detail: '已装，不改动' };
  const bridge = options.bridge;
  if (!fs.existsSync(path.join(bridge, 'plugin', 'package.json'))) {
    return { status: 'skip', detail: '运行时里没有插件文件' };
  }
  const want = ownSpec(bridge);
  if (options.dryRun) return { status: 'would-install', file: want };
  if (desktopRunning()) {
    return {
      status: 'skipped',
      detail: 'DSH 桌面版正在运行：完全退出后重跑安装，或在 DSH 的插件市场里装 dsh-delegate',
    };
  }
  const result = runDshSync(launch, ['plugin', '--profile', PROFILE, 'add', want], { timeout: 300000 });
  if (result.status === 0) return { status: 'installed', file: want, detail: '下次打开 DSH 时出现委派面板' };
  return { status: 'FAILED', file: want, detail: lastLine(result) };
}

/** Remove the plugin again, but only the entry `install` added. */
function remove(launch, options = {}) {
  const spec = currentSpec();
  if (!spec) return { status: 'absent' };
  if (!sameSpec(spec, ownSpec(options.bridge))) {
    return { status: 'kept', file: `${NAME}@${spec}`, detail: '不是安装器加的，未删除' };
  }
  if (!launch) return { status: 'FAILED', file: spec, detail: '找不到 DSH，没法卸载插件' };
  if (desktopRunning()) {
    return { status: 'skipped', file: spec, detail: 'DSH 桌面版正在运行：完全退出后重跑卸载，或在 DSH 里卸载 dsh-delegate' };
  }
  const result = runDshSync(launch, ['plugin', '--profile', PROFILE, 'remove', NAME], { timeout: 300000 });
  return result.status === 0 ? { status: 'removed', file: spec } : { status: 'FAILED', file: spec, detail: lastLine(result) };
}

module.exports = { add, remove, currentSpec, ownSpec, desktopRunning, profilePackage };
