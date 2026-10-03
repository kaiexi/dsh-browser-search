/**
 * DOM diagnostic: navigate to a query and report which containers actually exist,
 * without dumping the page. Run: node test/diag.mjs "query" [engine]
 */
import { ensureBrowser, openTab, closeTab, sleep } from '../lib/cdp.js';
import { ENGINES } from '../lib/search.js';

const query = process.argv[2] || 'DeepSeek Harness plugin 开发';
const engineName = process.argv[3] || 'bing';
const engine = ENGINES[engineName];
const url = engine.buildUrl(query, 10);

await ensureBrowser({});
const { targetId, session } = await openTab(9222);
try {
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  const loaded = session.once('Page.loadEventFired', 30000);
  await session.send('Page.navigate', { url }, 30000);
  await loaded.catch(() => {});
  await sleep(600);

  const report = await session.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const count = (sel) => { try { return document.querySelectorAll(sel).length; } catch { return -1; } };
      const bResults = document.getElementById('b_results');
      const kids = bResults ? [...bResults.children].slice(0, 12).map(el => el.tagName + '.' + (el.className || '(none)') + '[' + el.querySelectorAll('h2 a[href]').length + ' h2a]') : [];
      const text = (bResults ? bResults.innerText : document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 700);
      return {
        title: document.title,
        url: location.href,
        counts: {
          'li.b_algo': count('li.b_algo'),
          '#b_results > li': count('#b_results > li'),
          '#b_results h2 a[href]': count('#b_results h2 a[href]'),
          'h2 a[href]': count('h2 a[href]'),
          'li.b_algo h2 a[href]': count('li.b_algo h2 a[href]'),
          '.b_algo': count('.b_algo'),
          'a[href^="http"]': count('a[href^="http"]'),
        },
        bResultsExists: !!bResults,
        bResultsChildren: kids,
        bResultsText: text,
      };
    })()`,
  });
  console.log(JSON.stringify(report.result.value, null, 2));
} finally {
  session.close();
  await closeTab(9222, targetId);
}
