'use strict';

/**
 * Preloaded (`node --require`, through NODE_OPTIONS) by the regression suite around
 * installs that register autostart. The scheduled task, HKCU\...\Run and launchd
 * jobs are one per user, so running schtasks / reg / launchctl for real from a test
 * would rewrite the real entries. Calls are appended to $DSH_REGRESS_SYSCALLS
 * instead, and answered like a machine where nothing is registered.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const SYSTEM = new Set(['schtasks', 'reg', 'launchctl']);
const real = childProcess.execFileSync;

childProcess.execFileSync = function execFileSync(file, args, options) {
  const name = path.basename(String(file)).toLowerCase().replace(/\.exe$/, '');
  if (!SYSTEM.has(name)) return real.apply(this, arguments);
  const list = Array.isArray(args) ? args.map(String) : [];
  if (process.env.DSH_REGRESS_SYSCALLS) {
    fs.appendFileSync(process.env.DSH_REGRESS_SYSCALLS, `${JSON.stringify([name, ...list])}\n`);
  }
  if (list.some((arg) => /^\/?query$/i.test(arg))) throw new Error(`${name}: nothing registered (test)`);
  return options && options.encoding && options.encoding !== 'buffer' ? '' : Buffer.alloc(0);
};
