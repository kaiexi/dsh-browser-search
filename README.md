# dsh-browser-search

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) cordis plugin that exposes a
native **`browser_search`** tool. It drives a dedicated local Edge/Chromium instance over the Chrome
DevTools Protocol, so results are rendered by a real browser rather than fetched by an HTTP client —
independent of DSH's built-in `web_search` provider.

## Why

DSH's built-in `web_search` calls a DeepSeek-hosted search endpoint. When that endpoint is unreachable,
rate-limited, or returns poor results, this tool offers a local alternative that runs entirely on this
machine across several engines. No API key, no third-party npm dependency, no browser extension.

## Layout

| Path | Role |
|---|---|
| `index.js` | cordis plugin: registers `browser_search` (`export const name/inject`, `export function apply`) |
| `lib/cdp.js` | Minimal CDP client, browser launcher, User-Agent + stealth handling |
| `lib/search.js` | Declarative engine table, in-page DOM extraction, wrapper-link resolution |
| `cordis.patch.yml` | Bundle patch: inserts the plugin row into the profile |
| `bin/cli.js` | Standalone CLI for the same search core |
| `scripts/install-to-profile.mjs` | Copies runtime files into the DSH profile |
| `test/` | Standalone harnesses (smoke, engine discovery, flakiness, DOM diagnostics) |

## Install

### From a checkout

```powershell
node scripts/install-to-profile.mjs     # copies the runtime files into the profile's node_modules
```

Then add `"dsh-browser-search"` to `dsh.profile.bundles` in that profile's `package.json`
(`%DSH_HOME%\profiles\<profile>\package.json`):

```json
"dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-browser-search"] } }
```

The manifest change alone recomposes the running app — the plugin loads and the tool appears without
restarting DSH. On success the plugin writes `%DSH_HOME%\dsh-browser-search.status.json`:

```json
{ "plugin": "dsh-browser-search", "tool": "browser_search", "pid": 41920, "at": "..." }
```

The `pid` should belong to a running `DeepSeek Harness.exe`.

> **Layout note.** The installer **copies** rather than symlinks. A checkout keeps its own
> `node_modules/@deepseek-ai` dev shim (see Development); a symlink would let that shim shadow the
> installation's own `@deepseek-ai` packages, risking two live copies of `dsh-tools` in one process.

### From npm — not published

This package is **not on the npm registry**; the maintainer chose to distribute it via GitHub only. The
usual flow would be:

```powershell
# inside your DSH profile directory
npm install dsh-browser-search
```

`PUBLISHING.md` documents how to change that decision. Until then, install from a checkout as above.

## Use

```
browser_search(query: "…", count?: 8, engine?: "bing" | "google" | "baidu" | "yandex")
```

```powershell
node bin/cli.js "your query" --count 5 --engine baidu
node bin/cli.js "your query" --json
node bin/cli.js "your query" --headed        # show the browser window
node bin/cli.js "your query" --html          # dump the page when extraction fails
```

The browser runs **headless by default** with its own user-data-dir at
`%DSH_HOME%\browser-search-profile`, so it never touches your normal Edge windows, tabs, or cookies.
Warm searches take roughly 1–2 s; the browser process is launched once and reused.

Environment: `DSH_BROWSER_SEARCH_ENGINE`, `DSH_BROWSER_SEARCH_HEADLESS=0`, `DSH_BROWSER_SEARCH_UA`,
`DSH_BROWSER_SEARCH_PORT`, `DSH_BROWSER_SEARCH_PROFILE`, `DSH_BROWSER_SEARCH_BROWSER`,
`DSH_BROWSER_SEARCH_STATUS`.

## Engines — measured, then measured again

| Engine | Status | Notes |
|---|---|---|
| `bing` (default) | **works** | ~0.9 s. `cn.bing.com` first, `www.bing.com` fallback. Exact URLs decoded from `/ck/a?u=a1<base64>`. |
| `baidu` | **works** | ~1.0 s, **4/4 runs**. The real destination comes from each card's `mu` attribute, so URLs are exact. |
| `google` | **works** | ~1.5 s. `gbv=1` variant first. Titles/snippets accurate; URLs rebuilt from `<cite>` (see limitations). |
| `yandex` | **intermittent** | ~0.9 s when it works, but roughly **1 run in 3** lands on `/showcaptcha`. Detected and reported in ~3 s rather than hanging. |

Rejected, with the measurement that rejected them:

| Engine | Why |
|---|---|
| `ecosia` | Looked fine once (5 results, 1.1 s), then **0/5 runs** — a `请稍候…` JS challenge that never clears headless. |
| `so360` | 5 English results once, then **0/4 on Chinese queries**, every run bounced to `qcaptcha.so.com`. |
| `startpage` | Returned results, but rendered the site URL where every other engine renders the headline, and its layout was unstable between runs (a re-probe found zero result blocks on a fully loaded page). |
| `sogou`, `brave` | Interstitial/challenge pages. |
| `duckduckgo` | `html.` and `lite.` endpoints render no server-side results for this client. |
| `mojeek` | HTTP 403. |

**A single successful run proves nothing.** `ecosia` and `so360` each looked healthy on their first run
and failed every run afterwards. `test/flakiness.mjs` repeats a query and reports the success rate; that
is what separates a working engine from a lucky one. Engines were removed rather than left advertised but
broken, because a tool that claims six engines when two work misleads the model.

## The User-Agent is the unlock

Headless Chromium advertises `HeadlessChrome/<v>` in its User-Agent. Baidu answered that with a captcha
page on **every** attempt — in headless *and* headed mode — which is why it was originally dropped.

Two changes fixed it, and neither needs a browser extension:

1. **A truthful desktop UA**, learned from the browser itself. CDP's `/json/version` reports the real
   brand and build (e.g. `Edg/154.0.4258.48`); `userAgentFor()` turns that into a normal Edge UA, caches
   it in `%DSH_HOME%\browser-search-brand.json`, and reuses it on the next launch. The hardcoded string is
   only a first-run fallback. Override with `DSH_BROWSER_SEARCH_UA` if you want a specific one.
2. **`--disable-blink-features=AutomationControlled`** plus a per-document script clearing
   `navigator.webdriver` (`applyStealth`).

Baidu went from a captcha to 1.0 s / 4-of-4. If you would rather manage the UA by hand, the launch flag
is the single place to change it — an extension would need `--disable-extensions` removed, the extension
installed into the dedicated profile, and its per-site rules pre-seeded, and it still could not run in
the headless path.

## Wrapper links are resolved in two tiers

Search engines hide destinations behind redirectors — Bing `/ck/a?u=a1<base64>`, Baidu `/link?url=<token>`,
Google `/goto?url=<opaque>`, 360 `/link?m=<token>`. A result whose URL is still a redirector is useless to
the model, so `unwrapResults()` resolves them:

1. **Engine-native**: Baidu cards carry the true destination in `mu`; Bing's `u=` parameter is decodable
   base64. Both are exact and free.
2. **Server-side**: `fetch(url, { redirect: 'manual' })` and read `Location`. Browsers hide this behind an
   opaque redirect; Node does not. Verified working for Baidu (`302 → https://www.deepseek.com/harness/`).
3. **In-browser fallback**: if the redirector only moves client-side (360 answers `200 text/html`), open
   the wrapper in a real parallel tab and read where it lands. Verified: 360 → `deepseekharness.online`
   in ~1.1 s.

Google's `/goto?url=` resists all three — it needs a Google session — so Google URLs come from the
visible `<cite>` instead.

## Three design decisions that came out of measurement

1. **Navigation never awaits `Page.loadEventFired`.** Google keeps subresources open, so that event did not
   fire within 20 s on the `gbv=1` page even though results were fully rendered. The extractor polls until
   results appear, the page definitively has none, or the budget expires. This cut one engine from
   ~63 s/0 results to ~1.5 s/3 results.
2. **Extraction is strict.** An unrecognised page yields **zero** results instead of harvesting `a[href]`
   navigation links. A loose fallback previously returned DuckDuckGo's own homepage links as if they were
   search results. A failure is now reported as a failure. A URL/domain-shaped title is also rejected in
   favour of a real headline.
3. **Challenges are detected by URL and document title**, never by loose body keywords — cookie banners
   mention "consent" and footers mention "captcha", and matching those aborted Ecosia before its results
   rendered. A detected challenge now stops the wait early (Yandex fails in ~3 s instead of hanging for
   20 s) and is reported as a captcha rather than as "no results".

Extraction failures are surfaced, not swallowed: a broken extractor used to look like an empty result set,
so the reason is now carried back and shown in the tool's error message.

## Known limitations

- **Google URLs can be truncated.** `/goto?url=<opaque encrypted token>` is not decodable and does not
  resolve server-side. Titles and snippets are accurate; the URL is rebuilt from the visible `<cite>`
  (`www.host › path` → `https://host/path`) and loses detail on deep paths. Prefer `bing` or `baidu` when
  you need to fetch a result URL.
- **Yandex captchas intermittently** (~1 run in 3). The dedicated profile persists cookies, so running
  once with `--headed` and solving the challenge can raise the success rate.
- **Bot detection can appear on any engine** after many rapid queries. A challenge is reported as such.
- **Source edits require a restart.** DSH's HMR recomposes on config/manifest changes (which is why
  registration is live), but module watching is disabled by default (`hmr.root: []`) and ignores
  `node_modules`, so **changed plugin code is not hot-reloaded**. Re-run the install script and restart
  DSH to pick up code changes.

## Rollback

```powershell
$p = "$env:USERPROFILE\.dsh\profiles\desktop"
Copy-Item "$p\package.json.bak-before-browser-search" "$p\package.json" -Force
Remove-Item "$p\node_modules\dsh-browser-search" -Recurse -Force
```

Removing a local package from the manifest requires a process restart (DSH's own resolver states this),
so expect the tool to disappear only after DSH restarts.

## Development

The plugin has **zero runtime dependencies** — only Node's built-in `fetch`/`WebSocket`, plus
`@deepseek-ai/dsh-tools`, which DSH itself provides at load time.

The tests, however, import `@deepseek-ai/dsh-tools` directly so the tool definition can be validated
offline against the *real* `defineTool` (it is not a no-op: it converts the parameter DSL into JSON
Schema and builds the argument validator). That package ships inside DSH's `app.asar`, which plain Node
cannot import, so build a dev shim once:

```powershell
npm run dev:link          # extracts dsh/node_modules out of the local app.asar into ./node_modules
```

The shim script finds the install automatically (environment values, then every drive's usual layout),
skips the archive's large unpacked binaries, and is idempotent. Everything it writes is gitignored and is
never published.

```powershell
node test/tool-smoke.mjs "some query"      # registers against the real defineTool, executes, renders
node test/verify-engines.mjs "query"       # every engine end to end + wrapper-URL audit
node test/flakiness.mjs baidu 5 "query"    # success rate over N runs (keep-vs-drop evidence)
node test/discover-engines.mjs             # infer a new engine's selectors from its live DOM
node test/probe-redirects.mjs              # wrapper resolution + Baidu card anatomy
node test/host-matrix.mjs                  # Bing cn vs www — the evidence for the URL order
node test/diag.mjs "query"                 # what containers a SERP actually has
node test/diag-google.mjs "query"          # Google /goto?url= wrapper internals
node test/diag-startpage.mjs               # one block's element tree (kept: why Startpage was rejected)
```

## Contributing

Adding an engine is a data change in `lib/search.js` — no new code branch. Follow the measured workflow,
because guessing selectors does not survive:

1. **Discover** — add the candidate URL to `test/discover-engines.mjs` and run it. It groups candidate
   links by their nearest class-bearing ancestor, which tells you the real container/title selectors.
2. **Implement** — add an `ENGINES` entry with `buildUrls` (list every URL worth trying), `shapes`
   (container/title/snippet, plus `attr` for a true-URL attribute and `cite` for a display URL), and
   `hosts` so extraction is host-dispatched.
3. **Prove reliability** — run `test/flakiness.mjs <engine> 5 "<query>"` with both an English and a
   Chinese query. A single success proves nothing: `ecosia` and `so360` both looked healthy once and
   failed every subsequent run.
4. **Check URL quality** — `test/verify-engines.mjs` reports surviving redirector URLs. A result whose
   URL is still a wrapper is useless, so either resolve it (see the three-tier `unwrapResults`) or drop
   the engine.

Engines that only work sometimes are removed rather than shipped, because the model cannot tell a
flaky engine from a broken query.

## License

MIT © 本地浏览器部署大肥鱼搜索

