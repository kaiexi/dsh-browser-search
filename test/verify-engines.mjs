/**
 * Verify every declared engine end to end and audit URL quality: a result whose
 * host is still the search engine's own host means a wrapper link survived
 * unresolved, which would be useless to the model.
 *
 * Run: node test/verify-engines.mjs ["query"]
 */
import { search, ENGINES } from '../lib/search.js';

const query = process.argv[2] || 'DeepSeek Harness';
console.log(`query: "${query}"\n`);
console.log('engine     n  ms     wrappers  first result');
console.log('-'.repeat(96));

for (const name of Object.keys(ENGINES)) {
  const engine = ENGINES[name];
  try {
    const out = await search(query, { engine: name, count: 5 });
    // A surviving wrapper is a same-host URL on a REDIRECTOR path — not merely a
    // same-host URL, since e.g. baike.baidu.com is a legitimate Baidu result.
    const wrappers = out.results.filter((r) => {
      try {
        const u = new URL(r.url);
        return engine.hosts.test(u.hostname) && /^\/(link|goto|ck\/a|url|redirect)\b/i.test(u.pathname);
      } catch {
        return true;
      }
    }).length;
    const first = out.results[0];
    console.log(
      `${name.padEnd(10)} ${String(out.results.length).padStart(2)} ${String(out.durationMs).padStart(6)} ` +
        `${String(wrappers).padStart(8)}  ${first ? first.url.slice(0, 52) : '(none: ' + (out.noResults ? 'no results' : out.blocked ? 'blocked' : 'not extracted') + ')'}`
    );
    if (first) console.log(`${' '.repeat(28)}« ${first.title.slice(0, 74)} »`);
  } catch (err) {
    console.log(`${name.padEnd(10)} ERROR ${err.message}`);
  }
}
