'use strict';

/**
 * Login auto-start for the local service, so opening the machine (and then
 * Claude) finds it already running.
 *
 * Windows:  HKCU\...\Run → hidden VBS launcher
 * macOS:    ~/Library/LaunchAgents/dev.dsh-delegate.daemon.plist
 * Linux:    ~/.config/autostart/dsh-delegate.desktop
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const NAME = 'dsh-delegate';

function cliPath() {
  return path.join(__dirname, '..', 'bin', 'dsh-delegate.js');
}

function nodePath() {
  return process.execPath;
}

/** Autostart follows the saved mode: dashboard or API-only. */
function daemonArgs(port) {
  const ui = require('./config').readSettings().daemonUi !== false;
  return [cliPath(), 'daemon', ...(ui ? [] : ['--no-ui']), `--port=${port}`];
}

function windowsVbs(port) {
  const ui = require('./config').readSettings().daemonUi !== false;
  const command = `"${nodePath()}" "${cliPath()}" daemon${ui ? '' : ' --no-ui'} --port=${port}`;
  return [
    "' dsh-delegate 登录自启动（隐藏窗口）",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${command.replace(/"/g, '""')}", 0, False`,
    '',
  ].join('\r\n');
}

function windowsRunKey() {
  return 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
}

/**
 * `ours`: the entry starts this install's launcher. HKCU\...\Run is one per user, so
 * a copy running with another APPDATA (a test sandbox, a second install) must never
 * switch off the real entry.
 */
function status() {
  if (process.platform === 'win32') {
    const vbs = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dsh-delegate', 'daemon.vbs');
    try {
      const out = execFileSync('reg', ['query', windowsRunKey(), '/v', NAME], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const enabled = /dsh-delegate/.test(out);
      return { enabled, ours: enabled && out.toLowerCase().includes(vbs.toLowerCase()), mechanism: 'HKCU Run', target: vbs };
    } catch {
      return { enabled: false, ours: false, mechanism: 'HKCU Run', target: vbs };
    }
  }
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.dsh-delegate.daemon.plist');
    const enabled = fs.existsSync(plist);
    return { enabled, ours: enabled, mechanism: 'LaunchAgent', target: plist };
  }
  const desktop = path.join(os.homedir(), '.config', 'autostart', 'dsh-delegate.desktop');
  const enabled = fs.existsSync(desktop);
  return { enabled, ours: enabled, mechanism: 'XDG autostart', target: desktop };
}

function enable(options = {}) {
  const port = Number(options.port) || 7788;

  if (process.platform === 'win32') {
    const dir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'dsh-delegate');
    fs.mkdirSync(dir, { recursive: true });
    const vbs = path.join(dir, 'daemon.vbs');
    fs.writeFileSync(vbs, windowsVbs(port));
    execFileSync('reg', [
      'add',
      windowsRunKey(),
      '/v',
      NAME,
      '/t',
      'REG_SZ',
      '/d',
      `wscript.exe //B "${vbs}"`,
      '/f',
    ]);
    return { enabled: true, mechanism: 'HKCU Run', target: vbs };
  }

  if (process.platform === 'darwin') {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    const plist = path.join(dir, 'dev.dsh-delegate.daemon.plist');
    const args = [nodePath(), ...daemonArgs(port)]
      .map((value) => `    <string>${value}</string>`)
      .join('\n');
    fs.writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.dsh-delegate.daemon</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>StandardOutPath</key><string>${path.join(os.homedir(), '.dsh', 'delegate-daemon.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(os.homedir(), '.dsh', 'delegate-daemon.log')}</string>
</dict>
</plist>
`,
    );
    try {
      execFileSync('launchctl', ['load', '-w', plist], { stdio: 'ignore' });
    } catch {
      /* it still loads at next login */
    }
    return { enabled: true, mechanism: 'LaunchAgent', target: plist };
  }

  const dir = path.join(os.homedir(), '.config', 'autostart');
  fs.mkdirSync(dir, { recursive: true });
  const desktop = path.join(dir, 'dsh-delegate.desktop');
  fs.writeFileSync(
    desktop,
    `[Desktop Entry]
Type=Application
Name=dsh-delegate
Comment=Local DSH delegation service
Exec="${nodePath()}" "${cliPath()}" ${daemonArgs(port).slice(1).join(" ")}
Terminal=false
X-GNOME-Autostart-enabled=true
`,
  );
  return { enabled: true, mechanism: 'XDG autostart', target: desktop };
}

function disable() {
  const current = status();
  if (process.platform === 'win32') {
    if (current.ours) {
      try {
        execFileSync('reg', ['delete', windowsRunKey(), '/v', NAME, '/f']);
      } catch {
        /* already gone */
      }
    }
    try {
      fs.rmSync(current.target, { force: true });
    } catch {
      /* ignore */
    }
  } else if (process.platform === 'darwin') {
    try {
      execFileSync('launchctl', ['unload', '-w', current.target], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
    fs.rmSync(current.target, { force: true });
  } else {
    fs.rmSync(current.target, { force: true });
  }
  return status();
}

module.exports = { enable, disable, status };
