/**
 * Minimal Chrome DevTools Protocol client + dedicated browser launcher.
 * Zero third-party dependencies: Node's global fetch and WebSocket (Node >= 22).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = Number(process.env.DSH_BROWSER_SEARCH_PORT || 9222);
export const DEFAULT_USER_DATA_DIR =
  process.env.DSH_BROWSER_SEARCH_PROFILE ||
  path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'browser-search-profile');

const BROWSER_CANDIDATES = [
  process.env.DSH_BROWSER_SEARCH_BROWSER,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe')
    : null,
].filter(Boolean);

/**
 * Headless Chromium advertises itself as `HeadlessChrome/<v>` in the User-Agent,
 * which is the first thing bot detection keys on — Baidu answered an unmodified
 * headless client with a captcha page on every attempt. Declaring a normal Edge
 * UA is what makes several engines usable at all.
 *
 * The UA is learned from the browser itself rather than hardcoded: CDP's
 * `/json/version` reports the real brand and build (e.g. `Edg/154.0.4258.48`),
 * which is cached here and reused on the next launch. DESKTOP_USER_AGENT is only
 * the first-run fallback, before any instance has reported its version.
 */
export const DESKTOP_USER_AGENT =
  process.env.DSH_BROWSER_SEARCH_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0';

const BRAND_CACHE = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'browser-search-brand.json'
);

function readBrand() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BRAND_CACHE, 'utf8'));
    return typeof parsed.browser === 'string' ? parsed.browser : null;
  } catch {
    return null;
  }
}

function writeBrand(browser) {
  if (typeof browser !== 'string' || browser.length === 0) return;
  try {
    fs.mkdirSync(path.dirname(BRAND_CACHE), { recursive: true });
    fs.writeFileSync(
      BRAND_CACHE,
      `${JSON.stringify({ browser, at: new Date().toISOString() }, null, 2)}\n`
    );
  } catch {
    /* cache is an optimisation only */
  }
}

/** Build a truthful desktop UA from a brand string such as `Edg/154.0.4258.48`. */
export function userAgentFor(brand) {
  const match = /^(?:Headless)?(Edg|Chrome)\/(\d+(?:\.\d+)*)/.exec(brand || '');
  if (!match) return null;
  const [, name, full] = match;
  const major = full.split('.')[0];
  const base =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ';
  return name === 'Edg'
    ? `${base}Chrome/${major}.0.0.0 Safari/537.36 Edg/${full}`
    : `${base}Chrome/${full} Safari/537.36`;
}

/** The UA to launch with: learned from a previous run, else the static fallback. */
export function preferredUserAgent() {
  if (process.env.DSH_BROWSER_SEARCH_UA) return process.env.DSH_BROWSER_SEARCH_UA;
  return userAgentFor(readBrand()) || DESKTOP_USER_AGENT;
}

/** Drop the residual automation tell (`navigator.webdriver`) in every new document. */
export const STEALTH_SOURCE = `
Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
`;

/** Apply per-page stealth before any navigation happens on this session. */
export async function applyStealth(session) {
  try {
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_SOURCE });
  } catch {
    /* non-fatal: the launch flags still apply */
  }
}

export function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore unreadable candidates */
    }
  }
  return null;
}

export async function httpJson(url, { method = 'GET', timeout = 2000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { method, signal: controller.signal });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`non-JSON response from ${url} (HTTP ${res.status}): ${text.slice(0, 120)}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probeVersion(port, timeout = 1000) {
  try {
    const version = await httpJson(`http://127.0.0.1:${port}/json/version`, { timeout });
    if (version && typeof version.webSocketDebuggerUrl === 'string') return version;
    return null;
  } catch {
    return null;
  }
}

/**
 * Ensure a debugging-enabled browser instance is listening on `port`, launching a
 * dedicated instance (its own user-data-dir) when nothing is listening yet.
 */
export async function ensureBrowser(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const userDataDir = options.userDataDir || DEFAULT_USER_DATA_DIR;
  const headless =
    options.headless !== undefined
      ? options.headless
      : process.env.DSH_BROWSER_SEARCH_HEADLESS !== '0';

  const existing = await probeVersion(port);
  if (existing) {
    writeBrand(existing.Browser);
    return { launched: false, executable: null, version: existing, port };
  }

  const executable = findBrowser();
  if (!executable) {
    throw new Error(
      'No Chromium-based browser found. Set DSH_BROWSER_SEARCH_BROWSER to msedge.exe or chrome.exe.'
    );
  }

  fs.mkdirSync(userDataDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--remote-allow-origins=*',
    `--user-agent=${preferredUserAgent()}`,
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-client-side-phishing-detection',
    '--disable-features=Translate,OptimizationHints,msEdgeIdentityFeatures',
    '--window-size=1280,900',
    '--lang=zh-CN',
  ];
  if (headless) args.push('--headless=new', '--disable-gpu');
  args.push('about:blank');

  const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    await sleep(250);
    const version = await probeVersion(port, 1500);
    if (version) {
      writeBrand(version.Browser);
      return { launched: true, executable, version, port, pid: child.pid };
    }
  }
  throw new Error(
    `Launched ${path.basename(executable)} but CDP port ${port} never became reachable (30s).`
  );
}

export class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else entry.resolve(msg.result);
        return;
      }
      if (msg.method) {
        const handlers = this.listeners.get(msg.method);
        if (handlers) for (const handler of [...handlers]) handler(msg.params);
      }
    });

    ws.addEventListener('close', () => {
      this.closed = true;
      for (const [, entry] of this.pending) entry.reject(new Error('CDP connection closed'));
      this.pending.clear();
    });
    ws.addEventListener('error', () => {
      /* surfaced through close / send rejections */
    });
  }

  static async connect(wsUrl, timeout = 10000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP websocket timeout: ${wsUrl}`)), timeout);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP websocket error: ${wsUrl}`));
      });
    });
    return new CdpSession(ws);
  }

  send(method, params = {}, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP session is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(handler);
    return () => this.off(method, handler);
  }

  off(method, handler) {
    const handlers = this.listeners.get(method);
    if (handlers) handlers.delete(handler);
  }

  once(method, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeout);
      const handler = (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      };
      const off = this.on(method, handler);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
    this.closed = true;
  }
}

/** Open a fresh tab and return { targetId, session }. */
export async function openTab(port, options = {}) {
  const target = await httpJson(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`,
    { method: 'PUT', timeout: options.timeout || 8000 }
  );
  if (!target || !target.webSocketDebuggerUrl) {
    throw new Error('Failed to create a browser tab via /json/new');
  }
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  return { targetId: target.id, session };
}

export async function closeTab(port, targetId) {
  try {
    await httpJson(`http://127.0.0.1:${port}/json/close/${targetId}`, { timeout: 4000 });
  } catch {
    /* the tab may already be gone */
  }
}
