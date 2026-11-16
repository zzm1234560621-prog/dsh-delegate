'use strict';

/**
 * Keep the local service running: start it at login and bring it back if it dies.
 *
 * Windows:  a Task Scheduler task runs the hidden VBS launcher at logon and every
 *           5 minutes after that. `dsh-delegate daemon` exits straight away when the
 *           service is already up, so a tick costs one short node start. (Earlier
 *           versions used HKCU\...\Run, which only fires at login: a service that
 *           died mid-session stayed down until the next login.)
 * macOS:    ~/Library/LaunchAgents/dev.dsh-delegate.daemon.plist, restarted by
 *           launchd whenever it exits abnormally.
 * Linux:    ~/.config/autostart/dsh-delegate.desktop (login only).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const NAME = 'dsh-delegate';
const WATCH_MINUTES = 5;

function cliPath() {
  return path.join(__dirname, '..', 'bin', 'dsh-delegate.js');
}

function nodePath() {
  return process.execPath;
}

function appData() {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function vbsPath() {
  return path.join(appData(), 'dsh-delegate', 'daemon.vbs');
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
    "' dsh-delegate 自启动（隐藏窗口）",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run "${command.replace(/"/g, '""')}", 0, False`,
    '',
  ].join('\r\n');
}

function windowsRunKey() {
  return 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
}

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function localIso(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function windowsUser() {
  const name = process.env.USERNAME || os.userInfo().username;
  return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
}

/**
 * Task Scheduler definition: run the launcher at logon and every WATCH_MINUTES, for
 * this user only, also on battery, never two at once. The time trigger starts the
 * repetition right away instead of at the next logon.
 */
function windowsTaskXml({ vbs, userId, start, minutes = WATCH_MINUTES }) {
  const repeat = `<Repetition><Interval>PT${minutes}M</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>dsh-delegate: start the local service (127.0.0.1) at logon and restart it within ${minutes} minutes if it stops.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(userId)}</UserId>
      ${repeat}
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>${xmlEscape(start)}</StartBoundary>
      ${repeat}
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>//B "${xmlEscape(vbs)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** launchd restarts it after a crash or kill, not after a clean exit. */
function macPlist({ args, log }) {
  const items = args.map((value) => `    <string>${xmlEscape(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.dsh-delegate.daemon</string>
  <key>ProgramArguments</key>
  <array>
${items}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xmlEscape(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(log)}</string>
</dict>
</plist>
`;
}

function quiet(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
}

/** The scheduled task and the legacy Run value, and whether each starts *our* launcher. */
function windowsEntries() {
  const vbs = vbsPath().toLowerCase();
  let task = { exists: false, ours: false };
  try {
    const out = quiet('schtasks', ['/query', '/tn', NAME, '/v', '/fo', 'LIST']);
    task = { exists: true, ours: out.toLowerCase().includes(vbs) };
  } catch {
    /* no task */
  }
  let run = { exists: false, ours: false };
  try {
    const out = quiet('reg', ['query', windowsRunKey(), '/v', NAME]);
    const exists = /dsh-delegate/.test(out);
    run = { exists, ours: exists && out.toLowerCase().includes(vbs) };
  } catch {
    /* no value */
  }
  return { task, run };
}

/**
 * `ours`: the entry starts this install's launcher. Task names and HKCU\...\Run are
 * one per user, so a copy running with another APPDATA (a test sandbox, a second
 * install) must never switch off the real entry.
 */
function status() {
  if (process.platform === 'win32') {
    const { task, run } = windowsEntries();
    const target = vbsPath();
    if (task.exists) {
      return { enabled: true, ours: task.ours, watchdog: true, mechanism: `计划任务（登录时 + 每 ${WATCH_MINUTES} 分钟检查）`, target };
    }
    return { enabled: run.exists, ours: run.ours, watchdog: false, mechanism: 'HKCU Run（仅登录时）', target };
  }
  if (process.platform === 'darwin') {
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'dev.dsh-delegate.daemon.plist');
    const enabled = fs.existsSync(plist);
    const watchdog = enabled && fs.readFileSync(plist, 'utf8').includes('SuccessfulExit');
    return { enabled, ours: enabled, watchdog, mechanism: 'LaunchAgent', target: plist };
  }
  const desktop = path.join(os.homedir(), '.config', 'autostart', 'dsh-delegate.desktop');
  const enabled = fs.existsSync(desktop);
  return { enabled, ours: enabled, watchdog: false, mechanism: 'XDG autostart（仅登录时）', target: desktop };
}

function enableWindows(port) {
  const vbs = vbsPath();
  fs.mkdirSync(path.dirname(vbs), { recursive: true });
  fs.writeFileSync(vbs, windowsVbs(port));

  const xmlFile = path.join(os.tmpdir(), `dsh-delegate-task-${process.pid}.xml`);
  try {
    // schtasks wants the definition as UTF-16 with a BOM.
    fs.writeFileSync(xmlFile, `﻿${windowsTaskXml({ vbs, userId: windowsUser(), start: localIso(new Date()) })}`, 'utf16le');
    quiet('schtasks', ['/create', '/tn', NAME, '/xml', xmlFile, '/f']);
  } catch (cause) {
    // No Task Scheduler (policy, odd environment): fall back to the login-only Run value.
    execFileSync('reg', ['add', windowsRunKey(), '/v', NAME, '/t', 'REG_SZ', '/d', `wscript.exe //B "${vbs}"`, '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return { enabled: true, watchdog: false, mechanism: `HKCU Run（计划任务创建失败：${cause.message.split('\n')[0]}）`, target: vbs };
  } finally {
    fs.rmSync(xmlFile, { force: true });
  }

  // The task covers login too; a leftover Run value would race it at the next login.
  if (windowsEntries().run.ours) {
    try {
      quiet('reg', ['delete', windowsRunKey(), '/v', NAME, '/f']);
    } catch {
      /* already gone */
    }
  }
  return { enabled: true, watchdog: true, mechanism: `计划任务（登录时 + 每 ${WATCH_MINUTES} 分钟检查）`, target: vbs };
}

function enable(options = {}) {
  const port = Number(options.port) || 7788;

  if (process.platform === 'win32') return enableWindows(port);

  if (process.platform === 'darwin') {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    const plist = path.join(dir, 'dev.dsh-delegate.daemon.plist');
    fs.writeFileSync(plist, macPlist({ args: [nodePath(), ...daemonArgs(port)], log: path.join(os.homedir(), '.dsh', 'delegate-daemon.out.log') }));
    try {
      execFileSync('launchctl', ['unload', plist], { stdio: 'ignore' });
    } catch {
      /* was not loaded */
    }
    try {
      execFileSync('launchctl', ['load', '-w', plist], { stdio: 'ignore' });
    } catch {
      /* it still loads at next login */
    }
    return { enabled: true, watchdog: true, mechanism: 'LaunchAgent', target: plist };
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
Exec="${nodePath()}" "${cliPath()}" ${daemonArgs(port).slice(1).join(' ')}
Terminal=false
X-GNOME-Autostart-enabled=true
`,
  );
  return { enabled: true, watchdog: false, mechanism: 'XDG autostart（仅登录时）', target: desktop };
}

function disable() {
  const current = status();
  if (process.platform === 'win32') {
    const { task, run } = windowsEntries();
    if (task.ours) {
      try {
        quiet('schtasks', ['/delete', '/tn', NAME, '/f']);
      } catch {
        /* already gone */
      }
    }
    if (run.ours) {
      try {
        quiet('reg', ['delete', windowsRunKey(), '/v', NAME, '/f']);
      } catch {
        /* already gone */
      }
    }
    // Only our own launcher; another install's entry keeps pointing at its own file.
    if (task.ours || run.ours || (!task.exists && !run.exists)) {
      fs.rmSync(current.target, { force: true });
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

module.exports = { enable, disable, status, windowsTaskXml, macPlist, WATCH_MINUTES };
