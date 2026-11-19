#!/usr/bin/env node
'use strict';

/**
 * Copy the runtime into plugin/server, so the DSH plugin carries everything the
 * install script does: installing the plugin alone sets up the same things
 * (plugin/index.js runs `install` from this copy). The regression suite checks
 * that the copies match.
 *
 *   npm run sync:plugin
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = path.join(root, 'plugin', 'server');

for (const dir of ['lib', 'bin', 'assets']) {
  fs.rmSync(path.join(server, dir), { recursive: true, force: true });
  fs.cpSync(path.join(root, dir), path.join(server, dir), { recursive: true });
}
fs.copyFileSync(path.join(root, 'package.json'), path.join(server, 'package.json'));
console.log(`synced lib/, bin/, assets/ and package.json into ${path.relative(root, server)}`);
