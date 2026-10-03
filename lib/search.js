/**
 * Browser-driven web search: navigates a real Chromium tab to a search engine and
 * extracts structured results from the rendered DOM.
 *
 * Engines are DECLARATIVE: each entry lists the URLs to try and the container /
 * title / snippet selectors measured from that engine's live DOM. Adding an
 * engine is a data change, not a new code branch. Every selector below was read
 * off a real page with `test/discover-engines.mjs`, not guessed.
 *
 * Measured 2026-10 on this machine (headless Edge 154, zh-CN locale), AFTER the
 * User-Agent fix — see lib/cdp.js for why the UA matters:
 *
 *   works   bing 0.9s | baidu 1.0s (4/4 runs) | google 1.5s
 *           yandex 0.9s when it works, but ~1 run in 3 lands on /showcaptcha
 *   blocked sogou (interstitial) | brave (interstitial) | duckduckgo html+lite
 *           (no server-rendered results) | mojeek (HTTP 403)
 *   rejected ecosia — 0/5 runs. A single early run returned 5 results, but every
 *           repeat got a "请稍候…" JS challenge that never clears headless.
 *   rejected so360 — 5 English results once, then 0/4 on Chinese queries, every
 *           run redirected to qcaptcha.so.com ("访问异常页面").
 *   rejected startpage — returned results but rendered the site URL where every
 *           other engine renders the headline, and its layout was unstable
 *           between runs (a re-probe found zero result blocks on a fully loaded
 *           page).
 *
 * Flaky engines were found with test/flakiness.mjs, which repeats a query and
 * reports the success rate. A single success proves nothing: ecosia and so360
 * both looked fine on their first run and failed every run after.
 *
 * A note on wrapper links: engines hide destinations behind redirectors —
 * Bing /ck/a?u=a1<base64>, Baidu /link?url=<token>, Google /goto?url=<opaque>.
 * Baidu cards carry the true destination in a `mu` attribute and Bing's base64 is
 * decodable, so those are exact. Google's token is NOT decodable, so Google URLs
 * are rebuilt from the visible <cite> and can lose deep path detail; a
 * server-side follow-up (fetch with redirect:manual) recovers the rest.
 */

import {
  ensureBrowser,
  openTab,
  closeTab,
  sleep,
  applyStealth,
  preferredUserAgent,
  DEFAULT_PORT,
} from './cdp.js';

/** Bing wraps result links: /ck/a?...&u=a1<base64url>&... — this part is decodable. */
export function decodeBingUrl(href) {
  if (!href) return href;
  try {
    const url = new URL(href);
    if (!/(^|\.)bing\.com$/.test(url.hostname)) return href;
    if (!url.pathname.startsWith('/ck/a')) return href;
    const raw = url.searchParams.get('u');
    if (!raw) return href;
    const b64 = raw.startsWith('a1') ? raw.slice(2) : raw;
    const padded = b64
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .padEnd(Math.ceil(b64.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : href;
  } catch {
    return href;
  }
}

/**
 * Engine table.
 *
 * Per shape:
 *   container  selector for one result block
 *   title      selector for the title element (its text is the result title)
 *   snippet    optional selector for the summary
 *   attr       optional attribute holding the TRUE destination (Baidu `mu`)
 *   cite       optional selector whose text is a display URL ("host › path")
 *   relative   'allow' to absolutize a relative wrapper href (then resolved
 *              server-side), default 'httpOnly' which prefers cite over wrappers
 *   hosts      hostnames this shape is valid for (extraction is host-dispatched)
 */
export const ENGINES = {
  bing: {
    label: 'Bing',
    hosts: /(^|\.)bing\.com$/,
    buildUrls: (query, count) => {
      const q = encodeURIComponent(query);
      const n = clamp(count, 1, 50);
      return [
        `https://cn.bing.com/search?q=${q}&count=${n}&setlang=zh-CN`,
        `https://www.bing.com/search?q=${q}&count=${n}`,
      ];
    },
    shapes: [
      {
        container: 'li.b_algo',
        title: 'h2 a',
        snippet: '.b_caption p, .b_lineclamp2, .b_algoSlug, .b_snippet, p',
      },
      { container: '#b_results > li', title: 'h2 a' },
    ],
    decode: 'bing',
  },

  google: {
    label: 'Google',
    hosts: /(^|\.)google\./,
    buildUrls: (query, count) => {
      const q = encodeURIComponent(query);
      const n = clamp(count, 1, 30);
      return [
        `https://www.google.com/search?q=${q}&num=${n}&gbv=1&hl=en`,
        `https://www.google.com/search?q=${q}&num=${n}`,
      ];
    },
    shapes: [
      {
        container: 'div.MjjYud, div.g, div[data-snc]',
        title: 'h3',
        snippet: 'div[data-sncf], .VwiC3b, .yXK7lf, div.IsZvec, span.aCOpRe',
        cite: 'cite',
      },
    ],
    decode: 'plain',
  },

  baidu: {
    label: 'Baidu',
    hosts: /(^|\.)baidu\.com$/,
    buildUrls: (query, count) => [
      `https://www.baidu.com/s?wd=${encodeURIComponent(query)}&ie=utf-8&rn=${clamp(count, 1, 50)}`,
    ],
    shapes: [
      {
        container: 'div.result.c-container, div.c-container',
        title: 'h3 a, h3',
        attr: 'mu',
        snippet: '.c-abstract, .c-span-last, [class*="content-right"]',
        cite: 'cite, .cosc-source-a',
        relative: 'allow',
      },
    ],
    decode: 'plain',
  },

  yandex: {
    label: 'Yandex',
    hosts: /(^|\.)yandex\./,
    buildUrls: (query) => [`https://yandex.com/search/?text=${encodeURIComponent(query)}`],
    shapes: [
      {
        container: 'li.serp-item',
        title: '.OrganicTitle a, .OrganicTitle, h2 a',
        snippet: '.OrganicTextContentSpan, .TextContainer, .OrganicText',
      },
    ],
    decode: 'plain',
  },
};

export const ENGINE_NAMES = Object.keys(ENGINES);

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/**
 * Build the extraction expression for one engine. Kept as a string so it can be
 * handed to Runtime.evaluate; the shape table travels with it as JSON.
 */
function buildExtractExpression(shapes) {
  return `(() => {
  const SHAPES = ${JSON.stringify(shapes)};
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const seen = new Set();
  const results = [];
  const push = (title, url, snippet) => {
    title = clean(title); url = clean(url);
    if (!title || !url || !/^https?:/i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    results.push({ title, url, snippet: clean(snippet) });
  };
  const asAnchor = (el) =>
    !el ? null : el.tagName === 'A' ? el : el.querySelector('a[href]') || el.closest('a[href]');
  const absolutize = (raw) => {
    if (!raw) return '';
    if (/^https?:/i.test(raw)) return raw;
    if (raw.startsWith('//')) return location.protocol + raw;
    if (raw.startsWith('/')) return location.origin + raw;
    return '';
  };
  /** Legacy Google /url?q=<encoded target> is decodable; /goto?url= is not. */
  const decodeUrlParam = (raw) => {
    const m = /^\\/url\\?(?:[^#]*&)?q=([^&]+)/.exec(raw || '');
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch { return ''; }
  };
  /** "www.host.com › path" -> "https://www.host.com/path" */
  const fromCite = (text) => {
    const t = clean(text).replace(/\\s*[›>]\\s*/g, '/').replace(/\\s+/g, '');
    if (!t) return '';
    if (/^https?:\\/\\//i.test(t)) return t;
    if (/^[a-z0-9-]+(\\.[a-z0-9-]+)+([/?#].*)?$/i.test(t)) return 'https://' + t;
    return '';
  };

  for (const shape of SHAPES) {
    for (const node of document.querySelectorAll(shape.container)) {
      const titleEl = node.querySelector(shape.title);
      // Prefer the declared title element, but reject a URL/domain-shaped "title":
      // Startpage renders the site URL where other engines render the headline.
      const looksLikeUrl = (t) =>
        /^(https?:\\/\\/)?[a-z0-9-]+(\\.[a-z0-9-]+)+([/?#]\\S*)?$/i.test(t);
      const candidates = [];
      if (titleEl) candidates.push(clean(titleEl.textContent));
      for (const alt of node.querySelectorAll(
        'h1, h2, h3, h4, [class*="result-title"], [class*="result__title"], [class*="resultTitle"]'
      )) {
        candidates.push(clean(alt.textContent));
      }
      const title =
        candidates.find((t) => t && !looksLikeUrl(t)) ||
        candidates.filter(Boolean).sort((a, b) => b.length - a.length)[0] ||
        '';
      if (!title) continue;

      let url = '';
      if (shape.attr) {
        url = node.getAttribute(shape.attr) || '';
        if (!/^https?:/i.test(url)) {
          const holder = node.querySelector('[' + shape.attr + ']');
          url = holder ? holder.getAttribute(shape.attr) || '' : '';
        }
      }

      if (!/^https?:/i.test(url)) {
        const anchor = asAnchor(titleEl) || asAnchor(node.querySelector('a[href]'));
        if (anchor) {
          const raw = anchor.getAttribute('href') || '';
          const decoded = decodeUrlParam(raw);
          if (decoded) url = decoded;
          else if (/^https?:/i.test(raw)) url = raw;
          else if (shape.relative === 'allow') url = absolutize(raw);
        }
      }

      if (!/^https?:/i.test(url) && shape.cite) {
        const cite = node.querySelector(shape.cite);
        url = fromCite(cite && cite.textContent);
      }

      const snipEl = shape.snippet ? node.querySelector(shape.snippet) : null;
      push(title, url, snipEl && snipEl.textContent);
    }
    if (results.length) break;
  }

  const bodyText = (document.body && document.body.innerText) || '';
  const head = bodyText.slice(0, 400);
  const title = document.title || '';
  // A workable "no results" phrase is safe to act on immediately.
  const noResults =
    /没有与此相关的结果|没有找到与此相关的结果|There are no results|no results found|did not match any documents|找不到和查询匹配|ничего не найдено/i.test(
      bodyText
    );
  // Challenge detection keys on the URL and the DOCUMENT TITLE, which stay stable
  // across engines. A loose keyword match on body text is what previously aborted
  // Ecosia before its results rendered: cookie banners mention "consent"/"captcha"
  // too, but they do not rename the page.
  // NOTE: this whole function is emitted from a template literal, so every
  // backslash that must survive into the page source is doubled here. An
  // unescaped slash inside a regex literal terminates it early and produces a
  // page-side SyntaxError, which looks exactly like "no results".
  const challenge =
    /wappass\\.|consent\\.google|\\/sorry\\/index|\\/showcaptcha|recaptcha|hcaptcha|geetest/i.test(
      location.href
    ) ||
    /are you not a robot|just a moment|checking your browser|attention required|verify you are human|unusual traffic|请稍候|异常流量/i.test(
      title
    ) ||
    (results.length === 0 &&
      /验证码|安全验证|unusual traffic|异常流量|are you a robot|robot check|Подтвердите, что запросы|enable javascript and cookies to continue/i.test(
        head
      ));

  return {
    host: location.hostname,
    finalUrl: location.href,
    pageTitle: title,
    noResults,
    challenge,
    results: results.slice(0, 60),
    html: results.length ? '' : document.documentElement.outerHTML.slice(0, 200000),
  };
})()`;
}

async function evaluate(session, expression, timeout = 30000) {
  const res = await session.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    timeout
  );
  if (res.exceptionDetails) {
    const detail =
      (res.exceptionDetails.exception && res.exceptionDetails.exception.description) ||
      res.exceptionDetails.text ||
      'unknown page error';
    throw new Error(`In-page extraction failed: ${detail}`);
  }
  return res.result ? res.result.value : undefined;
}

/** Absolutize a search-engine wrapper href so it can be followed server-side. */
function absolutizeWrapper(href, base) {
  if (!href) return null;
  try {
    const url = new URL(href, base);
    if (!/^\/(link|goto|ck\/a|url|redirect)\b/i.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Resolve an engine wrapper link to its true destination by following the
 * redirect server-side. Browsers hide the Location header behind an opaque
 * redirect; Node's fetch exposes it. Returns null when it cannot be resolved
 * (Google's /goto?url= needs a Google session and never resolves here).
 */
async function resolveWrapper(url, timeout = 4000) {
  try {
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeout),
      headers: { 'user-agent': preferredUserAgent() },
    });
    const location = res.headers.get('location');
    if (location && /^https?:\/\//i.test(location)) return location;
    return null;
  } catch {
    return null;
  }
}

/** True when a URL actually left the search engine's own host. */
function leavesEngine(url, engine) {
  try {
    return !engine.hosts.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** How many wrappers may be chased with a real tab before we stop paying for it. */
const MAX_BROWSER_UNWRAP = 6;

/**
 * Follow wrapper links in a real tab. 360's /link?m= answers 200 HTML rather than
 * a 302, so the server-side path cannot resolve it; a browser follows whatever
 * the page does and reports where it landed. Tabs run in parallel.
 */
async function resolveInBrowser(pending, engine, port, timeoutMs = 9000) {
  const resolved = new Map();
  if (pending.length === 0) return resolved;

  const tabs = [];
  for (const item of pending) {
    try {
      const { targetId, session } = await openTab(port);
      await session.send('Page.enable');
      await session.send('Runtime.enable');
      await applyStealth(session);
      await session.send('Page.navigate', { url: item.wrapper }, timeoutMs).catch(() => {});
      tabs.push({ ...item, targetId, session });
    } catch {
      /* skip this one */
    }
  }

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline && resolved.size < tabs.length) {
      await sleep(400);
      await Promise.all(
        tabs.map(async (tab) => {
          if (resolved.has(tab.index)) return;
          try {
            const res = await tab.session.send(
              'Runtime.evaluate',
              { returnByValue: true, expression: 'location.href' },
              5000
            );
            const href = res.result && res.result.value;
            if (href && /^https?:/i.test(href) && leavesEngine(href, engine)) {
              resolved.set(tab.index, href);
            }
          } catch {
            /* keep polling until the deadline */
          }
        })
      );
    }
  } finally {
    await Promise.all(
      tabs.map(async (tab) => {
        tab.session.close();
        await closeTab(port, tab.targetId);
      })
    );
  }
  return resolved;
}

/**
 * Replace surviving wrapper URLs with their real destinations: server-side first
 * (cheap, works for Bing base64 and Baidu /link), then a real browser for the
 * engines whose redirector only moves client-side.
 */
async function unwrapResults(results, engine, base, port) {
  const out = [...results];
  const stillWrapped = [];

  await Promise.all(
    out.map(async (result, index) => {
      const wrapper = absolutizeWrapper(result.url, base);
      if (!wrapper) return;
      const real = await resolveWrapper(wrapper);
      if (real && leavesEngine(real, engine)) out[index] = { ...result, url: real };
      else stillWrapped.push({ index, wrapper });
    })
  );

  if (stillWrapped.length === 0) return out;
  const resolved = await resolveInBrowser(
    stillWrapped.slice(0, MAX_BROWSER_UNWRAP),
    engine,
    port
  );
  for (const [index, href] of resolved) out[index] = { ...out[index], url: href };
  return out;
}

/**
 * One navigation pass against a single URL.
 *
 * Deliberately does not await Page.loadEventFired: search pages routinely keep
 * subresources open, so that event can lag far behind the results. Poll instead
 * and stop as soon as results appear or the page is definitively empty.
 */
async function attemptUrl(url, engine, { port, timeoutMs, settleMs, signal }) {
  const { targetId, session } = await openTab(port);
  const started = Date.now();
  const expression = buildExtractExpression(engine.shapes);
  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
    await applyStealth(session);

    signal?.throwIfAborted?.();
    const nav = await session.send('Page.navigate', { url }, timeoutMs);
    if (nav && nav.errorText) throw new Error(`Navigation failed: ${nav.errorText}`);

    const deadline = started + timeoutMs;
    let raw;
    let challengeStreak = 0;
    let lastError = null;
    let errorStreak = 0;
    while (Date.now() < deadline) {
      await sleep(settleMs);
      try {
        raw = await evaluate(
          session,
          expression,
          Math.min(8000, Math.max(1000, deadline - Date.now()))
        );
        errorStreak = 0;
      } catch (err) {
        // A broken extractor throws identically on every poll, so surface the
        // reason instead of silently reporting "no results", and stop early
        // rather than burning the whole budget.
        lastError = err && err.message ? err.message : String(err);
        if (++errorStreak >= 3) break;
        continue;
      }
      if (raw && raw.results && raw.results.length) break;
      // Only a genuine "no results" phrase short-circuits the wait.
      if (raw && raw.noResults && Date.now() - started > 2500) break;
      // A challenge must persist across two consecutive polls before we stop
      // waiting, so a transient interstitial title during load cannot abort a
      // search that would have produced results.
      challengeStreak = raw && raw.challenge ? challengeStreak + 1 : 0;
      if (challengeStreak >= 2 && Date.now() - started > 3000) break;
    }

    let results = ((raw && raw.results) || []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.snippet || '',
    }));
    if (engine.decode === 'bing') results = results.map((r) => ({ ...r, url: decodeBingUrl(r.url) }));
    results = await unwrapResults(results, engine, (raw && raw.finalUrl) || url, port);

    return {
      url,
      results,
      finalUrl: (raw && raw.finalUrl) || url,
      pageTitle: (raw && raw.pageTitle) || '',
      noResults: Boolean(raw && raw.noResults),
      blocked: Boolean(raw && raw.challenge),
      error: lastError,
      html: raw && raw.html,
    };
  } finally {
    session.close();
    await closeTab(port, targetId);
  }
}

/**
 * Run one search through the browser.
 * @param query - the search query.
 * @param options - engine, count, port, headless, timeout, settleMs, signal.
 */
export async function search(query, options = {}) {
  if (!query || !String(query).trim()) throw new Error('search: query must be a non-empty string');
  const engineName = String(
    options.engine || process.env.DSH_BROWSER_SEARCH_ENGINE || 'bing'
  ).toLowerCase();
  const engine = ENGINES[engineName];
  if (!engine) {
    throw new Error(
      `Unknown engine "${engineName}". Available: ${ENGINE_NAMES.join(', ')}`
    );
  }
  const count = clamp(options.count || 8, 1, 50);
  const port = options.port || DEFAULT_PORT;
  const settleMs = options.settleMs !== undefined ? options.settleMs : 400;
  const timeoutMs = options.timeout || 20000;
  const signal = options.signal;
  const started = Date.now();

  signal?.throwIfAborted?.();
  await ensureBrowser({ port, userDataDir: options.userDataDir, headless: options.headless });

  const urls = engine.buildUrls(query, count);
  const attempts = [];

  for (const url of urls) {
    signal?.throwIfAborted?.();
    const attempt = await attemptUrl(url, engine, { port, timeoutMs, settleMs, signal });
    attempts.push(attempt);
    if (attempt.results.length > 0) {
      return {
        query,
        engine: engineName,
        engineLabel: engine.label,
        url,
        finalUrl: attempt.finalUrl,
        pageTitle: attempt.pageTitle,
        durationMs: Date.now() - started,
        blocked: false,
        noResults: false,
        results: attempt.results.slice(0, count),
      };
    }
  }

  const last = attempts[attempts.length - 1] || {};
  const out = {
    query,
    engine: engineName,
    engineLabel: engine.label,
    url: last.url || urls[0],
    finalUrl: last.finalUrl || '',
    pageTitle: last.pageTitle || '',
    durationMs: Date.now() - started,
    blocked: Boolean(last.blocked),
    noResults: Boolean(last.noResults),
    error: last.error || null,
    results: [],
    attemptedUrls: urls,
  };
  if (last.html) out.html = last.html;
  return out;
}
