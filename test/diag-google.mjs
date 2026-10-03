/**
 * Focused Google diagnostic: what page does Google actually serve right now?
 * Run: node test/diag-google.mjs ["query"]
 */
import { ensureBrowser, openTab, closeTab, sleep } from '../lib/cdp.js';

const q = encodeURIComponent(process.argv[2] || 'DeepSeek Harness');
const urls = [
  `https://www.google.com/search?q=${q}&num=10&gbv=1&hl=en`,
  `https://www.google.com/search?q=${q}&num=10`,
];

await ensureBrowser({});
for (const url of urls) {
  const { targetId, session } = await openTab(9222);
  const started = Date.now();
  let loadFired = false;
  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    const loaded = session.once('Page.loadEventFired', 20000);
    await session.send('Page.navigate', { url }, 20000);
    await loaded.then(
      () => {
        loadFired = true;
      },
      () => {}
    );
    await sleep(800);
    const res = await session.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const body = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ');
        const c = (s) => { try { return document.querySelectorAll(s).length; } catch { return -1; } };
        return {
          host: location.hostname, href: location.href.slice(0, 110),
          title: document.title.slice(0, 70),
          counts: { 'div.g': c('div.g'), 'div.MjjYud': c('div.MjjYud'), 'h3': c('h3'), 'a[href^=http]': c('a[href^="http"]') },
          extract: (() => {
            const nodes = [...document.querySelectorAll('div.MjjYud, div.g, div[data-snc]')];
            const withH3 = nodes.filter((n) => n.querySelector('h3')).length;
            const withAnchor = nodes.filter((n) => n.querySelector('h3') && (n.querySelector('h3').closest('a[href]') || n.querySelector('a[href]'))).length;
            const sample = nodes.slice(0, 3).map((n) => {
              const h = n.querySelector('h3');
              const a = h && (h.closest('a[href]') || n.querySelector('a[href]'));
              return { t: (h ? h.textContent : '').trim().slice(0, 30), href: a ? (a.getAttribute('href') || '').slice(0, 60) : null };
            });
            return { nodes: nodes.length, withH3, withAnchor, sample };
          })(),
          bodyHead: body.slice(0, 320),
        };
      })()`,
    });
    const v = res.result.value;
    console.log(`\n--- ${url.slice(0, 78)}`);
    console.log(`loadEventFired=${loadFired} elapsed=${Date.now() - started}ms`);
    console.log(`host=${v.host} title=${JSON.stringify(v.title)}`);
    console.log(`counts=${JSON.stringify(v.counts)}`);
    console.log(`extract=${JSON.stringify(v.extract)}`);
    console.log(`href=${v.href}`);
    console.log(`body: ${v.bodyHead}`);
  } finally {
    session.close();
    await closeTab(9222, targetId);
  }
}
