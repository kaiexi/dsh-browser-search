/**
 * Find the element that actually holds a Startpage result title.
 * Polls until the SERP has rendered, then dumps the element tree of one block.
 * Run: node test/diag-startpage.mjs
 */
import { ensureBrowser, openTab, closeTab, sleep, applyStealth } from '../lib/cdp.js';

await ensureBrowser({});
const { targetId, session } = await openTab(9222);
try {
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await applyStealth(session);
  await session.send(
    'Page.navigate',
    { url: 'https://www.startpage.com/sp/search?query=DeepSeek%20Harness' },
    25000
  ).catch(() => {});

  const FIND = `(() => {
    const blocks = [...document.querySelectorAll('div.result, div.w-gl__result')];
    const block = blocks.find((n) => n.querySelector('a[href^="http"]'));
    if (!block) return { ok: false, blocks: blocks.length, ready: document.readyState };
    const tree = [];
    const walk = (el, depth) => {
      if (depth > 3) return;
      const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
      tree.push({
        d: depth,
        tag: el.tagName,
        cls: String(el.className || '').slice(0, 52),
        len: text.length,
        text: text.slice(0, 58),
      });
      for (const child of el.children) walk(child, depth + 1);
    };
    walk(block, 0);
    return { ok: true, tree: tree.slice(0, 30) };
  })()`;

  let report;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    await sleep(700);
    try {
      const res = await session.send('Runtime.evaluate', { returnByValue: true, expression: FIND }, 8000);
      report = res.result.value;
    } catch {
      continue;
    }
    if (report && report.ok) break;
  }
  if (!report || !report.ok) {
    console.log('no block found:', JSON.stringify(report));
  } else {
    for (const row of report.tree) {
      console.log(
        `${'  '.repeat(row.d)}${row.tag}.${row.cls}  [len=${row.len}]  ${JSON.stringify(row.text)}`
      );
    }
  }
} finally {
  session.close();
  await closeTab(9222, targetId);
}
