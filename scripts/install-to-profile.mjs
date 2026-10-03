#!/usr/bin/env node
/**
 * Copy the plugin's runtime files into the DSH profile's node_modules so the
 * cordis loader can resolve the bundle by name.
 *
 * A copy (not a symlink) is deliberate: the dev checkout keeps its own
 * node_modules shim for standalone tests, and a symlink would let that shim
 * shadow the installation's own @deepseek-ai packages, risking two live copies
 * of the same module (duplicate `instanceof` checks inside the tool registry).
 *
 * Run: node scripts/install-to-profile.mjs [--profile-dir <dir>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const profileIndex = process.argv.indexOf('--profile-dir');
const profileDir =
  profileIndex >= 0
    ? process.argv[profileIndex + 1]
    : path.join(
        process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'),
        'profiles',
        process.env.DSH_PROFILE || 'desktop'
      );

const target = path.join(profileDir, 'node_modules', 'dsh-browser-search');

/** Runtime files only — no tests, no dev node_modules, no scratch. */
const ENTRIES = ['package.json', 'index.js', 'cordis.patch.yml', 'README.md', 'LICENSE', 'lib', 'bin'];

if (!fs.existsSync(profileDir)) {
  console.error(`profile directory not found: ${profileDir}`);
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
for (const entry of ENTRIES) {
  const from = path.join(here, entry);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(target, entry), { recursive: true });
}

const installed = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
console.log(`installed ${installed.name}@${installed.version} -> ${target}`);

// Report whether the manifest actually activates the bundle yet.
const manifestPath = path.join(profileDir, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const bundles = manifest.dsh?.profile?.bundles ?? [];
console.log(`dsh.profile.bundles: ${JSON.stringify(bundles)}`);
console.log(
  bundles.includes(installed.name)
    ? 'bundle is ACTIVE in the profile manifest.'
    : `bundle is NOT listed yet — add "${installed.name}" to dsh.profile.bundles in ${manifestPath}`
);
