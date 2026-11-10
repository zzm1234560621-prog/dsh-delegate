'use strict';

/**
 * pi-ai provider + model catalog, read from the installed DSH app.
 *
 * DSH ships pi-ai with a JSON catalog per provider inside app.asar. Plain Node
 * cannot open asar paths, so this module parses the archive header and reads the
 * entries directly — no extraction to disk, no network.
 */

const fs = require('node:fs');
const path = require('node:path');
const { discover } = require('./dsh');

let cache = null;

function asarPathFrom(exe) {
  // <app>/DSH NEXT.exe → <app>/resources/app.asar
  return path.join(path.dirname(exe), 'resources', 'app.asar');
}

function findLaunch() {
  try {
    const launch = discover();
    if (launch.kind === 'desktop') return { asar: asarPathFrom(launch.command), base: 8 };
    if (launch.kind === 'cli') {
      // npm install of @deepseek-ai/dsh: siblings hold the bundled packages
      const root = path.dirname(path.dirname(launch.command));
      return { asar: null, root };
    }
  } catch {
    /* ignore */
  }
  return { asar: null };
}

function readAsarEntries(asar) {
  const fd = fs.openSync(asar, 'r');
  const head = Buffer.alloc(8 * 1024 * 1024);
  const read = fs.readSync(fd, head, 0, head.length, 0);
  const text = head.slice(0, read).toString('utf8');
  const start = text.indexOf('{"files"');
  if (start === -1) {
    fs.closeSync(fd);
    throw new Error('app.asar header not found');
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = start; i < read; i += 1) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const header = JSON.parse(text.slice(start, end));
  // The data section begins right after the pickled header.
  const base = 8 + head.readUInt32LE(4);

  const files = new Map();
  (function walk(node, prefix) {
    if (node.files) {
      for (const key of Object.keys(node.files)) walk(node.files[key], `${prefix}/${key}`);
      return;
    }
    files.set(prefix, { size: node.size, offset: Number(node.offset || 0) });
  })(header, '');

  return {
    base,
    read(entryPath) {
      const entry = files.get(entryPath);
      if (!entry) return null;
      const buffer = Buffer.alloc(entry.size);
      fs.readSync(fd, buffer, 0, entry.size, base + entry.offset);
      return buffer.toString('utf8');
    },
    close() {
      fs.closeSync(fd);
    },
  };
}

const DATA_DIR = '/node_modules/@earendil-works/pi-ai/dist/providers/data';

/** @returns {{models: Array<{id:string,name:string,reasoning:boolean}>, source:string}|null} */
function load(force = false) {
  if (cache && !force) return cache;

  const launch = findLaunch();
  const result = { providers: {}, source: null };

  if (launch.asar && fs.existsSync(launch.asar)) {
    let archive;
    try {
      archive = readAsarEntries(launch.asar);
      const manifest = archive.read(`${DATA_DIR}/.manifest.json`);
      if (manifest) {
        // manifest.files maps "<provider>.json" to a digest.
        const parsedManifest = JSON.parse(manifest);
        const names = new Set(
          Object.keys(parsedManifest.files || {}).map((name) => name.replace(/\.json$/, '')),
        );
        for (const name of names) {
          const text = archive.read(`${DATA_DIR}/${name}.json`);
          if (!text) continue;
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            continue;
          }
          const models = [];
          for (const group of Object.values(parsed)) {
            if (!group || typeof group !== 'object') continue;
            for (const model of Object.values(group)) {
              if (model && model.id) {
                models.push({ id: model.id, name: model.name || model.id, reasoning: Boolean(model.reasoning) });
              }
            }
          }
          if (models.length) result.providers[name] = models;
        }
        result.source = launch.asar;
      }
    } catch {
      /* fall through to empty catalog */
    } finally {
      if (archive) archive.close();
    }
  }

  cache = result;
  return result;
}

function modelsFor(provider) {
  const catalog = load();
  return catalog.providers[provider] || [];
}

module.exports = { load, modelsFor };
