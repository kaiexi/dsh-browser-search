#!/usr/bin/env node
/**
 * Build the dev-only module shim the test harnesses need.
 *
 * The plugin itself has ZERO runtime dependencies — it only uses Node's built-in
 * fetch/WebSocket and (at load time) `@deepseek-ai/dsh-tools`, which DSH provides.
 * But `test/tool-smoke.mjs` imports `@deepseek-ai/dsh-tools` directly so the tool
 * definition can be validated offline against the real `defineTool`. That package
 * ships inside DSH's `app.asar`, which plain Node cannot import.
 *
 * This script reads the asar container and extracts its `dsh/node_modules` tree
 * into `./node_modules`, making the tests runnable on any machine that has DSH
 * installed. Everything it writes is gitignored.
 *
 * Run: node scripts/link-dev-deps.mjs [--force] [--asar <path>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const destRoot = path.join(repo, 'node_modules');
const force = process.argv.includes('--force');

const asarIndex = process.argv.indexOf('--asar');

/**
 * Locate app.asar without hardcoding a drive letter. Per-user installs commonly
 * live on a non-system drive (`LOCALAPPDATA` itself can be redirected), so this
 * scans environment values, then the usual layout on every existing drive.
 */
function findAsarCandidates() {
  const found = [];
  if (asarIndex >= 0 && process.argv[asarIndex + 1]) found.push(process.argv[asarIndex + 1]);
  if (process.env.DSH_ASAR) found.push(process.env.DSH_ASAR);
  for (const value of Object.values(process.env)) {
    if (typeof value === 'string' && /app\.asar$/i.test(value.trim())) found.push(value.trim());
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base) found.push(path.join(base, 'DeepSeek Harness', 'resources', 'app.asar'));
  }
  for (const local of [process.env.LOCALAPPDATA, process.env.APPDATA]) {
    if (local) found.push(path.join(local, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'));
  }
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const drive = `${letter}:\\`;
    if (!fs.existsSync(drive)) continue;
    for (const dir of ['Program Files', 'Program Files (x86)']) {
      found.push(path.join(drive, dir, 'DeepSeek Harness', 'resources', 'app.asar'));
    }
    const users = path.join(drive, 'Users');
    if (!fs.existsSync(users)) continue;
    let names = [];
    try {
      names = fs.readdirSync(users);
    } catch {
      continue;
    }
    for (const name of names) {
      found.push(
        path.join(users, name, 'AppData', 'Local', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'),
        path.join(users, name, 'AppData', 'Local', 'DeepSeek Harness', 'resources', 'app.asar')
      );
    }
  }
  return [...new Set(found)];
}

const ASAR_CANDIDATES = findAsarCandidates();

const asar = ASAR_CANDIDATES.find((candidate) => {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
});

if (!asar) {
  console.error('Could not find app.asar. Pass --asar <path> or set DSH_ASAR.');
  console.error(`Tried ${ASAR_CANDIDATES.length} locations, e.g.:\n  ` + ASAR_CANDIDATES.slice(0, 8).join('\n  '));
  process.exit(1);
}
console.log(`using app.asar: ${asar}`);

/** Electron asar layout: two UInt32LE size fields, then a JSON header. */
function readHeader(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const pickleSize = head.readUInt32LE(4);
    const buf = Buffer.alloc(pickleSize);
    fs.readSync(fd, buf, 0, pickleSize, 8);
    const jsonSize = buf.readUInt32LE(4);
    const json = buf.toString('utf8', 8, 8 + jsonSize);
    return { header: JSON.parse(json), dataOffset: 8 + pickleSize };
  } finally {
    fs.closeSync(fd);
  }
}

function walk(node, prefix, out) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (entry.files) walk(entry, full, out);
    else out.push({ path: full, size: entry.size, offset: entry.offset, unpacked: !!entry.unpacked });
  }
  return out;
}

/** Remove a link without ever following it into its target. */
function removeLink(p) {
  let stat;
  try {
    stat = fs.lstatSync(p);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(p);
    return true;
  }
  return false;
}

const scoped = path.join(destRoot, '@deepseek-ai');
if (removeLink(scoped)) {
  console.log('removed an existing node_modules/@deepseek-ai link (not its target)');
}
if (fs.existsSync(path.join(scoped, 'dsh-tools', 'package.json')) && !force) {
  console.log(`shim already present at ${scoped} — pass --force to rebuild.`);
  process.exit(0);
}

const { header, dataOffset } = readHeader(asar);
const all = walk(header, '', []).filter((f) => f.path.startsWith('dsh/node_modules/'));
// Unpacked entries are the archive's large native/binary payloads (LibreOffice,
// desktop host, ...). None of them are in `dsh-tools`' import graph, and copying
// them triples this shim for no benefit, so they are opt-in.
const withUnpacked = process.argv.includes('--with-unpacked');
const files = withUnpacked ? all : all.filter((f) => !f.unpacked);
if (files.length === 0) {
  console.error('No dsh/node_modules entries found in the archive.');
  process.exit(1);
}

const unpackedRoot = path.join(path.dirname(asar), 'app.asar.unpacked');
const fd = fs.openSync(asar, 'r');
let written = 0;
let bytes = 0;
let unpacked = 0;
try {
  for (const file of files) {
    const relative = file.path.slice('dsh/node_modules/'.length);
    const dest = path.join(destRoot, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (file.unpacked) {
      const source = path.join(unpackedRoot, file.path);
      if (!fs.existsSync(source)) continue;
      fs.copyFileSync(source, dest);
      unpacked++;
    } else {
      const buf = Buffer.alloc(file.size);
      fs.readSync(fd, buf, 0, file.size, dataOffset + Number(file.offset));
      fs.writeFileSync(dest, buf);
    }
    written++;
    bytes += file.size;
  }
} finally {
  fs.closeSync(fd);
}

console.log(
  `extracted ${written} files (${(bytes / 1024 / 1024).toFixed(1)} MB${unpacked ? `, ${unpacked} unpacked` : ''}) ` +
    `from ${asar}\n  -> ${destRoot}`
);
console.log('Dev shim ready. `node test/tool-smoke.mjs "query"` should now import defineTool.');
