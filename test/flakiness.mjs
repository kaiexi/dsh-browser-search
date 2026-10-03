/**
 * Flakiness measurement: run one engine N times and report the success rate plus
 * what the failing runs actually got. A search engine that fails intermittently
 * is worse than no engine at all, so this decides keep-vs-drop.
 *
 * Run: node test/flakiness.mjs [engine] [runs] ["query"]
 */
import { search } from '../lib/search.js';

const engine = process.argv[2] || 'ecosia';
const runs = Number(process.argv[3] || 4);
const query = process.argv[4] || 'DeepSeek Harness';

let ok = 0;
const failures = [];
for (let i = 0; i < runs; i++) {
  const out = await search(query, { engine, count: 5 });
  const good = out.results.length > 0;
  if (good) ok++;
  else failures.push({ i: i + 1, ms: out.durationMs, blocked: out.blocked, noResults: out.noResults, finalUrl: (out.finalUrl || '').slice(0, 70), title: out.pageTitle });
  console.log(
    `run ${i + 1}: ${good ? 'OK  ' : 'FAIL'} ${String(out.results.length).padStart(2)} results ${String(out.durationMs).padStart(6)}ms` +
      (good ? `  ${out.results[0].url.slice(0, 46)}` : `  blocked=${out.blocked} noResults=${out.noResults} title="${out.pageTitle}"`)
  );
}
console.log(`\n${engine}: ${ok}/${runs} succeeded`);
for (const f of failures) console.log(`  fail #${f.i}: ${f.ms}ms blocked=${f.blocked} ${f.finalUrl} "${f.title}"`);
