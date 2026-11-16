#!/usr/bin/env node
'use strict';

/**
 * Build the release assets from a git ref, into dist/:
 *
 *   dsh-delegate-v<version>.zip   everything, with install.cmd / install.command /
 *                                 install.sh (git archive)
 *   dsh-delegate.zip              the same zip under a version-free name, so
 *                                 releases/latest/download/dsh-delegate.zip always works
 *   dsh-delegate-install.bat      one-file Windows installer that fetches the above
 *   dsh-delegate-plugin.tgz       the DSH plugin (`npm pack` of plugin/), the file the
 *                                 marketplace entry downloads
 *
 * All of them come from the ref itself, not the working tree. .gitattributes pins
 * line endings (install.sh / install.command LF, .cmd/.bat/.ps1 CRLF) and keeps the
 * marketplace notes and installers/ out of the zip, whatever this checkout's
 * core.autocrlf is.
 *
 *   npm run pack              # from HEAD
 *   npm run pack -- v1.4.0    # from a tag
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { which, spawnSyncCommand } = require('../lib/dsh');

const root = path.join(__dirname, '..');
const ref = process.argv[2] || 'HEAD';
const dist = path.join(root, 'dist');
const git = (args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options });
const size = (file) => `${(fs.statSync(file).size / 1024).toFixed(0)} KB`;

const version = JSON.parse(git(['show', `${ref}:package.json`])).version;
fs.mkdirSync(dist, { recursive: true });

// 1. The zip.
const name = `dsh-delegate-v${version}`;
const zip = path.join(dist, `${name}.zip`);
git(['-c', 'core.autocrlf=false', 'archive', '--format=zip', `--prefix=${name}/`, '-o', zip, ref], { stdio: 'inherit' });
console.log(`${path.relative(root, zip)}  ${size(zip)}  (${ref})`);

const latestZip = path.join(dist, 'dsh-delegate.zip');
fs.copyFileSync(zip, latestZip);
console.log(`${path.relative(root, latestZip)}  ${size(latestZip)}  (same zip, version-free name)`);

// The one-file Windows installer; cmd.exe wants CRLF, the blob is stored with LF.
let batch = null;
try {
  batch = git(['show', `${ref}:installers/dsh-delegate-install.bat`], { stdio: ['ignore', 'pipe', 'ignore'] });
} catch {
  console.log('(no installers/dsh-delegate-install.bat at this ref, skipped)');
}
if (batch) {
  const bat = path.join(dist, 'dsh-delegate-install.bat');
  fs.writeFileSync(bat, batch.replace(/\r?\n/g, '\r\n'));
  console.log(`${path.relative(root, bat)}  ${size(bat)}`);
}

// 2. The plugin tarball, packed from a clean checkout of the same ref.
const npm = which('npm');
if (!npm) throw new Error('npm not found on PATH; cannot pack the plugin');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-delegate-pack-'));
const tree = path.join(tmp, 'tree');
git(['worktree', 'add', '--detach', '--quiet', tree, ref]);
try {
  const packed = spawnSyncCommand(npm, ['pack', '--silent', '--pack-destination', dist], {
    cwd: path.join(tree, 'plugin'),
    encoding: 'utf8',
  });
  if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr || packed.stdout}`);
  const produced = path.join(dist, packed.stdout.trim().split(/\r?\n/).pop());
  const tgz = path.join(dist, 'dsh-delegate-plugin.tgz');
  fs.rmSync(tgz, { force: true });
  fs.renameSync(produced, tgz);
  const pluginVersion = JSON.parse(fs.readFileSync(path.join(tree, 'plugin', 'package.json'), 'utf8')).version;
  console.log(`${path.relative(root, tgz)}  ${size(tgz)}  (plugin ${pluginVersion})`);
  if (pluginVersion !== version) console.warn(`warning: plugin/package.json is ${pluginVersion}, package.json is ${version}`);
} finally {
  git(['worktree', 'remove', '--force', tree]);
  fs.rmSync(tmp, { recursive: true, force: true });
}
