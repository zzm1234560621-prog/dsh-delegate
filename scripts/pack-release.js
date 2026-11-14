#!/usr/bin/env node
'use strict';

/**
 * Build the release zip from a git ref: dist/dsh-delegate-v<version>.zip
 *
 * Built with `git archive`, so it holds exactly the tracked files of that ref.
 * .gitattributes pins line endings (install.sh LF, .cmd/.ps1 CRLF) and drops
 * the marketplace notes, whatever this checkout's core.autocrlf is.
 *
 *   npm run pack              # from HEAD
 *   npm run pack -- v1.1.0    # from a tag
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const ref = process.argv[2] || 'HEAD';
const git = (args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options });

const version = JSON.parse(git(['show', `${ref}:package.json`])).version;
const name = `dsh-delegate-v${version}`;
const out = path.join(root, 'dist', `${name}.zip`);
fs.mkdirSync(path.dirname(out), { recursive: true });

git(['-c', 'core.autocrlf=false', 'archive', '--format=zip', `--prefix=${name}/`, '-o', out, ref], { stdio: 'inherit' });
console.log(`${path.relative(root, out)}  ${(fs.statSync(out).size / 1024).toFixed(0)} KB  (${ref})`);
