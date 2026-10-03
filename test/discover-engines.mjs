/**
 * Engine discovery probe.
 *
 * For each candidate engine it navigates a real tab (with stealth applied), then
 * infers WHICH container holds the results by grouping candidate links by their
 * nearest class-bearing ancestor. That turns "guess a selector" into "read the
 * DOM", so engines are added from measurement rather than guesswork.
 *
 * Run: node test/discover-engines.mjs ["query"]
 */
import { ensureBrowser, openTab, closeTab, sleep, applyStealth } from '../lib/cdp.js';

const q = encodeURIComponent(process.argv[2] || 'DeepSeek Harness');

const CANDIDATES = [
  ['baidu', `https://www.baidu.com/s?wd=${q}&ie=utf-8`],
  ['baidu-m', `https://m.baidu.com/s?word=${q}`],
  ['yandex', `https://yandex.com/search/?text=${q}`],
  ['sogou', `https://www.sogou.com/web?query=${q}`],
  ['so360', `https://www.so.com/s?q=${q}`],
  ['ddg-html', `https://html.duckduckgo.com/html/?q=${q}`],
  ['brave', `https://search.brave.com/search?q=${q}`],
  ['ecosia', `https://www.ecosia.org/search?q=${q}`],
  ['mojeek', `https://www.mojeek.com/search?q=${q}`],
  ['startpage', `https://www.startpage.com/sp/search?query=${q}`],
  ['wikipedia-zh', `https://zh.wikipedia.org/w/index.php?search=${q}`],
];

const FIND = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const sig = (el) => {
    const parts = [];
    let node = el;
    for (let i = 0; i < 4 && node && node.tagName; i++) {
      const cls = (node.className && typeof node.className === 'string')
        ? '.' + node.className.trim().split(/\\s+/).slice(0, 2).join('.')
        : '';
      parts.push(node.tagName.toLowerCase() + cls);
      node = node.parentElement;
    }
    return parts.join(' < ');
  };
  const groups = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    const text = clean(a.textContent);
    if (text.length < 10 || text.length > 200) continue;
    if (a.closest('header, nav, footer, [role="navigation"]')) continue;
    const href = a.getAttribute('href') || '';
    if (!/^https?:|^\\/url\\?|^\\/link\\?|^\\/goto\\?/.test(href)) continue;
    const key = sig(a.parentElement || a);
    if (!groups.has(key)) groups.set(key, { n: 0, t: text.slice(0, 46), h: href.slice(0, 74) });
    groups.get(key).n++;
  }
  const top = [...groups.entries()].filter(([, v]) => v.n >= 2)
    .sort((a, b) => b[1].n - a[1].n).slice(0, 3)
    .map(([k, v]) => ({ sig: k, n: v.n, t: v.t, h: v.h }));

  const body = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ');
  return {
    host: location.hostname,
    title: document.title.slice(0, 50),
    ua: navigator.userAgent.slice(0, 60),
    webdriver: String(navigator.webdriver),
    blocked: /wappass\\.|captcha|验证码|安全验证|consent\\.|Before you continue|unusual traffic|异常流量|are you a robot|robot check/i.test(
      location.href + ' ' + location.hostname + ' ' + body.slice(0, 500)
    ),
    top,
  };
})()`;

await ensureBrowser({});
let first = true;
for (const [label, url] of CANDIDATES) {
  const { targetId, session } = await openTab(9222);
  const started = Date.now();
  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await applyStealth(session);
    await session.send('Page.navigate', { url }, 20000).catch(() => {});
    let report;
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) {
      await sleep(450);
      try {
        const res = await session.send('Runtime.evaluate', { returnByValue: true, expression: FIND }, 7000);
        report = res.result.value;
      } catch {
        continue;
      }
      if (report && report.top && report.top.length) break;
    }
    if (first && report) {
      console.log(`stealth check: webdriver=${report.webdriver} ua="${report.ua}"`);
      first = false;
    }
    const t = (report && report.top) || [];
    console.log(
      `\n${label.padEnd(12)} host=${String((report && report.host) || '?').padEnd(22)} ` +
        `blocked=${report && report.blocked ? 'Y' : 'n'} ${String(Date.now() - started).padStart(5)}ms ${t.length ? '' : ' <-- NO SIGNATURE'}`
    );
    console.log(`${' '.repeat(12)} title="${(report && report.title) || ''}"`);
    for (const row of t) {
      console.log(`${' '.repeat(14)}n=${String(row.n).padStart(3)} ${row.sig}`);
      console.log(`${' '.repeat(16)}« ${row.t} » ${row.h}`);
    }
  } catch (err) {
    console.log(`\n${label.padEnd(12)} ERROR ${err.message}`);
  } finally {
    session.close();
    await closeTab(9222, targetId);
  }
}
