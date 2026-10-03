/**
 * Two questions this answers:
 *  1. How is a Baidu result card structured (title / snippet / real URL)?
 *  2. Can the wrapper links Baidu (/link?url=) and Google (/goto?url=) use be
 *     resolved to the true destination with a server-side fetch that reads the
 *     Location header? Browsers hide it behind an opaque redirect, but Node's
 *     fetch does not.
 *
 * Run: node test/probe-redirects.mjs
 */
import { ensureBrowser, openTab, closeTab, sleep, applyStealth } from '../lib/cdp.js';

const q = encodeURIComponent('DeepSeek Harness');

async function grab(engine, url, selectorExpr) {
  const { targetId, session } = await openTab(9222);
  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await applyStealth(session);
    await session.send('Page.navigate', { url }, 20000).catch(() => {});
    let out;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      await sleep(500);
      try {
        const res = await session.send(
          'Runtime.evaluate',
          { returnByValue: true, expression: selectorExpr },
          8000
        );
        out = res.result.value;
      } catch {
        continue;
      }
      if (out && out.ok) break;
    }
    return out;
  } finally {
    session.close();
    await closeTab(9222, targetId);
  }
}

const BAIDU_SHAPE = `(() => {
  const cards = [...document.querySelectorAll('div.cosc-card-content, div.result, div.c-container')];
  const card = cards.find((c) => c.querySelector('h3 a[href]'));
  if (!card) return { ok: false, cards: cards.length };
  const link = card.querySelector('h3 a[href]');
  const links = [...card.querySelectorAll('a[href]')].map((a) => ({
    cls: a.className, href: a.getAttribute('href').slice(0, 70), text: (a.textContent || '').trim().slice(0, 40),
  }));
  return {
    ok: true,
    html: card.outerHTML.replace(/\\s+/g, ' ').slice(0, 1500),
    title: (link.textContent || '').trim().slice(0, 60),
    titleHref: link.getAttribute('href'),
    allLinks: links.slice(0, 8),
    cardText: (card.innerText || '').replace(/\\s+/g, ' ').slice(0, 260),
  };
})()`;

const GOOGLE_SHAPE = `(() => {
  const node = [...document.querySelectorAll('div.MjjYud, div.g')].find((n) => n.querySelector('h3'));
  if (!node) return { ok: false };
  const a = node.querySelector('h3').closest('a[href]') || node.querySelector('a[href]');
  return { ok: true, href: a ? a.getAttribute('href') : null };
})()`;

const baidu = await grab('baidu', `https://www.baidu.com/s?wd=${q}&ie=utf-8`, BAIDU_SHAPE);
console.log('=== BAIDU CARD ===');
console.log(JSON.stringify(baidu, null, 2));

const google = await grab('google', `https://www.google.com/search?q=${q}&num=5&gbv=1&hl=en`, GOOGLE_SHAPE);
console.log('\n=== GOOGLE WRAPPER ===');
console.log(JSON.stringify(google));

// Can Node resolve the wrappers server-side by reading Location?
async function resolve(label, href) {
  if (!href) return console.log(`${label}: (no href)`);
  const absolute = href.startsWith('http') ? href : `https://www.google.com${href}`;
  try {
    const res = await fetch(absolute, {
      redirect: 'manual',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0' },
    });
    const loc = res.headers.get('location');
    console.log(`${label}: status=${res.status} location=${loc ? loc.slice(0, 110) : '(none)'}`);
  } catch (err) {
    console.log(`${label}: fetch failed -> ${err.message}`);
  }
}

console.log('\n=== SERVER-SIDE WRAPPER RESOLUTION ===');
await resolve('baidu  /link?url=', baidu && baidu.titleHref);
await resolve('google /goto?url=', google && google.href);
