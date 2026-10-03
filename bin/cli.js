#!/usr/bin/env node
/**
 * CLI for the browser-driven search core.
 *   node bin/cli.js "query" [--engine bing] [--count 8] [--json] [--headed] [--html]
 */

import { search, ENGINE_NAMES } from '../lib/search.js';

function parseArgs(argv) {
  const opts = { json: false, html: false, count: 8, engine: 'bing' };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--html') opts.html = true;
    else if (arg === '--headed') opts.headless = false;
    else if (arg === '--headless') opts.headless = true;
    else if (arg === '--engine') opts.engine = argv[++i];
    else if (arg === '--count' || arg === '-n') opts.count = Number(argv[++i]) || 8;
    else if (arg === '--timeout') opts.timeout = Number(argv[++i]) || 30000;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    else positional.push(arg);
  }
  opts.query = positional.join(' ').trim();
  return opts;
}

function usage() {
  process.stdout.write(
    [
      'dsh-browser-search — search the web through a real local browser tab',
      '',
      'Usage: node bin/cli.js "your query" [options]',
      '',
      'Options:',
      `  --engine <name>   ${ENGINE_NAMES.join(' | ')}   (default: bing)`,
      '  --count, -n <n>   max results (default: 8)',
      '  --json            print raw JSON',
      '  --html            print the page HTML when extraction is blocked',
      '  --headed          show the browser window (default: headless)',
      '  --timeout <ms>    navigation timeout (default: 30000)',
      '',
    ].join('\n')
  );
}

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}
if (opts.help || !opts.query) {
  usage();
  process.exit(opts.help ? 0 : 2);
}

try {
  const out = await search(opts.query, opts);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(out.results.length ? 0 : 3);
  }
  process.stdout.write(
    `${out.engineLabel} · "${out.query}" · ${out.results.length} result(s) in ${out.durationMs} ms\n`
  );
  process.stdout.write(`${out.finalUrl}\n\n`);
  out.results.forEach((r, i) => {
    process.stdout.write(`${i + 1}. ${r.title}\n   ${r.url}\n`);
    if (r.snippet) process.stdout.write(`   ${r.snippet}\n`);
  });
  if (!out.results.length) {
    process.stdout.write('No results extracted (page may be a consent or blocked page).\n');
    if (opts.html && out.html) process.stdout.write(`\n--- html ---\n${out.html}\n`);
    process.exit(3);
  }
} catch (err) {
  process.stderr.write(`ERROR: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
}
