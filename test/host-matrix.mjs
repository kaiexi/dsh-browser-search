/**
 * Host matrix: for several queries, compare how many results cn.bing.com vs
 * www.bing.com yield. Run: node test/host-matrix.mjs
 */
import { ensureBrowser, openTab, closeTab, sleep } from '../lib/cdp.js';

const queries = [
  'DeepSeek Harness',
  '上海 天气',
  'DeepSeek Harness plugin 开发',
  'cordis plugin 注册',
];

const hosts = [
  ['cn', 'https://cn.bing.com/search?q=%Q%&count=10&setlang=zh-CN'],
  ['www', 'https://www.bing.com/search?q=%Q%&count=10'],
];

await ensureBrowser({});
console.log('query'.padEnd(34), hosts.map(([h]) => h.padStart(5)).join(''));

for (const query of queries) {
  const row = [];
  for (const [, template] of hosts) {
    const url = template.replace('%Q%', encodeURIComponent(query));
    const { targetId, session } = await openTab(9222);
    try {
      await session.send('Page.enable');
      await session.send('Runtime.enable');
      const loaded = session.once('Page.loadEventFired', 30000);
      await session.send('Page.navigate', { url }, 30000);
      await loaded.catch(() => {});
      await sleep(500);
      const res = await session.send('Runtime.evaluate', {
        returnByValue: true,
        expression: "document.querySelectorAll('li.b_algo').length",
      });
      row.push(String(res.result.value).padStart(5));
    } finally {
      session.close();
      await closeTab(9222, targetId);
    }
  }
  console.log(query.padEnd(34), row.join(''));
}
