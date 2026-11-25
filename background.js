/* Text Extractor — background crawler and Markdown assembly. */
'use strict';

const VERSION = browser.runtime.getManifest().version;
const MAX_QUEUE = 20000;
const FETCH_TIMEOUT = 30000;
const RENDER_TIMEOUT = 45000;
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp[34]|m4[av]|wav|ogg|oga|webm|avi|mov|mkv|flv|zip|rar|7z|gz|tgz|tar|bz2|xz|exe|dmg|msi|apk|iso|bin|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|json|xml|rss|atom|css|js|mjs|map|woff2?|ttf|eot|otf|ics|vcf)$/i;
const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|_ga|_gl|yclid|igshid)$/i;

let state = freshState();
let keepAliveTimer = null;

function freshState() {
  return {
    status: 'idle',          // idle | running | stopping | done | stopped | error
    message: '',
    settings: { ...TE_DEFAULTS },
    startUrl: '',
    startedAt: 0,
    finishedAt: 0,
    cancel: false,
    queue: [],
    seen: new Set(),
    fetched: new Set(),
    hashes: new Set(),
    pages: [],
    errors: [],
    skipped: { robots: 0, nonHtml: 0, duplicate: 0, empty: 0, outOfScope: 0 },
    inFlight: 0,
    current: new Set(),
    seq: 0,
    log: [],
    scope: null,
    robots: null,
    renderWindow: null,
    renderTabs: [],
    result: null
  };
}

// ---------------------------------------------------------------------------
// Messaging

browser.runtime.onMessage.addListener(msg => {
  switch (msg && msg.type) {
    case 'start':
      return start(msg).then(() => ({ ok: true }), e => ({ ok: false, error: e.message }));
    case 'stop':
      if (state.status === 'running') {
        state.cancel = true;
        state.status = 'stopping';
        log('Stopping — saving pages collected so far…');
      }
      return Promise.resolve({ ok: true });
    case 'dismiss':
      if (!isBusy()) {
        state.status = 'idle';
        state.message = '';
      }
      return Promise.resolve({ ok: true });
    case 'getState':
      return publicState();
    case 'getResult':
      return getResult();
    case 'download':
      return downloadResult(msg.saveAs).then(() => ({ ok: true }), e => ({ ok: false, error: e.message }));
    default:
      return undefined;
  }
});

function isBusy() {
  return state.status === 'running' || state.status === 'stopping';
}

async function publicState() {
  let result = state.result;
  if (!result) {
    const stored = await browser.storage.local.get('lastResultInfo');
    result = stored.lastResultInfo || null;
  }
  const s = state.settings;
  return {
    status: state.status,
    message: state.message,
    mode: s.mode,
    loader: s.loader,
    startUrl: state.startUrl,
    maxPages: s.mode === 'page' ? 1 : s.maxPages,
    done: state.pages.length,
    queued: state.queue.length,
    inFlight: state.inFlight,
    errors: state.errors.length,
    skipped: Object.values(state.skipped).reduce((a, b) => a + b, 0),
    current: Array.from(state.current),
    log: state.log.slice(-10),
    elapsed: state.startedAt ? (state.finishedAt || Date.now()) - state.startedAt : 0,
    result: result && { filename: result.filename, pages: result.pages, words: result.words, bytes: result.bytes }
  };
}

function log(text, level = 'info') {
  state.log.push({ t: Date.now(), level, text });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

function keepAlive(on) {
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
  // Any extension API call resets the idle timer of a non-persistent background page.
  if (on) keepAliveTimer = setInterval(() => browser.runtime.getPlatformInfo().catch(() => {}), 20000);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Run control

async function start({ settings, tabId, url }) {
  if (isBusy()) throw new Error('An extraction is already running.');
  const s = sanitizeSettings(settings);
  if (!url) throw new Error('No page to extract.');
  const u = new URL(url);
  if (s.mode === 'site' && !/^https?:$/.test(u.protocol)) {
    throw new Error('Website crawling only works for http(s) pages.');
  }

  const previous = state.result;
  state = freshState();
  state.result = previous;
  state.settings = s;
  state.startUrl = url;
  state.startedAt = Date.now();
  state.status = 'running';
  log(s.mode === 'page' ? `Extracting ${url}` : `Crawling ${u.host} (max ${s.maxPages} pages, depth ${s.maxDepth}, ${s.loader})`);

  run(tabId); // not awaited — progress is polled by the popup
}

function sanitizeSettings(input) {
  const s = { ...TE_DEFAULTS, ...(input || {}) };
  const int = (v, min, max, def) => {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? def : Math.min(max, Math.max(min, n));
  };
  s.maxPages = int(s.maxPages, 1, 10000, TE_DEFAULTS.maxPages);
  s.maxDepth = int(s.maxDepth, 0, 50, TE_DEFAULTS.maxDepth);
  s.delay = int(s.delay, 0, 60000, TE_DEFAULTS.delay);
  s.renderWait = int(s.renderWait, 0, 30000, TE_DEFAULTS.renderWait);
  s.concurrency = int(s.concurrency, 1, s.loader === 'render' ? 3 : 8, TE_DEFAULTS.concurrency);
  if (!['host', 'domain', 'path'].includes(s.scope)) s.scope = 'host';
  if (!['fetch', 'render'].includes(s.loader)) s.loader = 'fetch';
  if (!['page', 'site'].includes(s.mode)) s.mode = 'page';
  s.excludeRules = String(s.exclude || '')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const m = /^\/(.+)\/([a-z]*)$/.exec(l);
      if (m) {
        try { const re = new RegExp(m[1], m[2]); return u => re.test(u); } catch { /* fall through */ }
      }
      const needle = l.toLowerCase();
      return u => u.toLowerCase().includes(needle);
    });
  return s;
}

function extractOptions() {
  const s = state.settings;
  return {
    mainOnly: s.mainOnly,
    skipHidden: s.skipHidden,
    includeLinks: s.includeLinks,
    includeImages: s.includeImages,
    headingOffset: 2
  };
}

async function run(tabId) {
  keepAlive(true);
  try {
    if (state.settings.mode === 'page') {
      const data = await extractInTab(tabId);
      addPage(data, { depth: 0, seq: 0 });
      log(`Extracted "${data.title || data.url}" (${data.words} words)`);
    } else {
      await crawl();
    }

    if (!state.pages.length) {
      state.status = state.cancel ? 'stopped' : 'error';
      state.message = state.cancel ? 'Stopped before any page was extracted.' : 'No text could be extracted.';
      return;
    }

    await buildResult();
    state.status = state.cancel ? 'stopped' : 'done';
    log(`Finished: ${state.pages.length} page(s), ${state.result.words} words`);
  } catch (e) {
    state.status = 'error';
    state.message = e.message || String(e);
    log(state.message, 'error');
  } finally {
    state.finishedAt = Date.now();
    state.current.clear();
    keepAlive(false);
    await closeRenderWindow();
  }
}

// ---------------------------------------------------------------------------
// Crawling

async function crawl() {
  const s = state.settings;
  const start = new URL(state.startUrl);
  state.scope = makeScope(start, s.scope);

  if (s.respectRobots || s.useSitemap) {
    state.robots = await loadRobots(start.origin);
    if (!s.respectRobots) state.robots.allowed = () => true;
  }

  enqueue(state.startUrl, 0, true);

  if (s.useSitemap) {
    const urls = await loadSitemaps(start.origin, state.robots ? state.robots.sitemaps : []);
    const before = state.queue.length;
    for (const u of urls) enqueue(u, 1);
    log(`Sitemap: ${urls.length} URL(s) found, ${state.queue.length - before} queued`);
  }

  if (s.loader === 'render') await openRenderWindow(s.concurrency);

  await Promise.all(Array.from({ length: s.concurrency }, (_, i) => worker(i)));
}

async function worker(index) {
  const s = state.settings;
  while (!state.cancel) {
    if (state.pages.length + state.inFlight >= s.maxPages || !state.queue.length) {
      if (!state.inFlight) return;
      await sleep(150);
      continue;
    }

    const item = state.queue.shift();
    state.inFlight++;
    state.current.add(item.url);
    try {
      const data = s.loader === 'render'
        ? await renderAndExtract(index, item.url)
        : await fetchAndExtract(item.url);
      if (data) handlePage(data, item);
    } catch (e) {
      const error = e.name === 'AbortError' ? 'Timed out' : e.message || String(e);
      state.errors.push({ url: item.url, error });
      log(`✗ ${item.url} — ${error}`, 'error');
    } finally {
      state.inFlight--;
      state.current.delete(item.url);
    }
    if (s.delay && !state.cancel) await sleep(s.delay);
  }
}

function handlePage(data, item) {
  const s = state.settings;
  const finalUrl = normalizeUrl(data.url) || item.url;
  const key = urlKey(finalUrl);

  if (finalUrl !== item.url) {
    // Followed a redirect: make sure the target is still in scope.
    if (!state.scope(new URL(finalUrl))) { state.skipped.outOfScope++; return; }
    state.seen.add(key);
  }
  // The canonical URL identifies copies such as "?nocache=…" variants. Only trust it for the
  // same path: some sites wrongly point every page's canonical at the home page.
  const canonical = data.canonical && normalizeUrl(data.canonical);
  const canonicalKey = canonical && pathKey(canonical) === pathKey(finalUrl) ? urlKey(canonical) : null;
  if (state.fetched.has(key) || (canonicalKey && state.fetched.has(canonicalKey))) {
    state.skipped.duplicate++;
    log(`– ${finalUrl} — duplicate of an exported page`);
    return;
  }
  state.fetched.add(key);
  if (canonicalKey) {
    state.fetched.add(canonicalKey);
    state.seen.add(canonicalKey);
  }
  data.url = canonicalKey ? canonical : finalUrl;

  if (item.depth < s.maxDepth) {
    for (const link of data.links) enqueue(link, item.depth + 1);
  }

  if (!data.words) {
    state.skipped.empty++;
    log(`– ${finalUrl} — no text`);
    return;
  }
  const hash = hashString(data.markdown);
  if (state.hashes.has(hash)) {
    state.skipped.duplicate++;
    log(`– ${finalUrl} — duplicate content`);
    return;
  }
  state.hashes.add(hash);
  addPage(data, item);
  log(`✓ ${data.url} (${data.words} words)`);
}

function addPage(data, item) {
  state.pages.push({
    url: data.url,
    title: data.title,
    description: data.description,
    lang: data.lang,
    markdown: data.markdown,
    words: data.words,
    depth: item.depth,
    seq: item.seq
  });
}

function enqueue(rawUrl, depth, force = false) {
  const url = normalizeUrl(rawUrl);
  if (!url) return;
  const key = urlKey(url);
  if (state.seen.has(key)) return;
  const u = new URL(url);
  if (!force) {
    if (!state.scope(u)) return;
    if (SKIP_EXT.test(u.pathname)) return;
    if (state.settings.excludeRules.some(rule => rule(url))) return;
    if (state.queue.length >= MAX_QUEUE) return;
  }
  state.seen.add(key);
  if (state.robots && !state.robots.allowed(u)) {
    state.skipped.robots++;
    if (force) log(`robots.txt disallows ${url}`, 'error');
    return;
  }
  state.queue.push({ url, depth, seq: state.seq++ });
}

function normalizeUrl(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  for (const k of Array.from(u.searchParams.keys())) {
    if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  }
  if (u.search === '?') u.search = '';
  return u.href;
}

// Identity used for de-duplication: ignores scheme, "www." and a trailing slash.
function urlKey(url) {
  const u = new URL(url);
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
  return u.hostname.replace(/^www\./i, '').toLowerCase() + (u.port ? ':' + u.port : '') + path + u.search;
}

function pathKey(url) {
  return urlKey(url).replace(/\?.*$/, '');
}

function makeScope(start, mode) {
  const bare = h => h.replace(/^www\./i, '').toLowerCase();
  const host = bare(start.hostname);
  const dir = start.pathname.replace(/[^/]*$/, '');
  return u => {
    const h = bare(u.hostname);
    if (mode === 'domain') return h === host || h.endsWith('.' + host);
    if (h !== host) return false;
    return mode === 'path' ? u.pathname.startsWith(dir) : true;
  };
}

function hashString(str) {
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
}

// ---------------------------------------------------------------------------
// Loaders

async function fetchWithTimeout(url, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  try {
    return await fetch(url, { credentials: 'include', redirect: 'follow', ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAndExtract(url) {
  const res = await fetchWithTimeout(url, {
    headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (type && !/html/i.test(type)) {
    state.skipped.nonHtml++;
    return null;
  }
  const html = decodeBody(await res.arrayBuffer(), type);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return TextExtractor.extract(doc, res.url || url, extractOptions());
}

function decodeBody(buffer, contentType) {
  let charset = (/charset=["']?([\w.:-]+)/i.exec(contentType) || [])[1];
  if (!charset) {
    const head = new TextDecoder('windows-1252').decode(buffer.slice(0, 4096));
    charset = (/<meta[^>]+charset=["']?([\w.:-]+)/i.exec(head) || [])[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

async function extractInTab(tabId) {
  const target = { tabId };
  await browser.scripting.executeScript({ target, files: ['lib/html2md.js'] });
  const [res] = await browser.scripting.executeScript({
    target,
    func: opts => globalThis.TextExtractor.extract(document, location.href, { ...opts, live: true }),
    args: [extractOptions()]
  });
  if (!res) throw new Error('The page could not be read.');
  if (res.error) throw new Error(res.error.message || String(res.error));
  if (!res.result) throw new Error('The page returned no content.');
  return res.result;
}

async function openRenderWindow(count) {
  const win = await browser.windows.create({ url: 'about:blank', state: 'minimized' });
  state.renderWindow = win.id;
  state.renderTabs = [win.tabs[0].id];
  for (let i = 1; i < count; i++) {
    const tab = await browser.tabs.create({ windowId: win.id, url: 'about:blank', active: false });
    state.renderTabs.push(tab.id);
  }
  log(`Opened a minimized window with ${count} render tab(s)`);
}

async function closeRenderWindow() {
  if (state.renderWindow == null) return;
  const id = state.renderWindow;
  state.renderWindow = null;
  state.renderTabs = [];
  try { await browser.windows.remove(id); } catch { /* already closed */ }
}

browser.windows.onRemoved.addListener(id => {
  if (id === state.renderWindow && isBusy()) {
    state.renderWindow = null;
    state.cancel = true;
    state.status = 'stopping';
    log('Render window was closed — stopping.', 'error');
  }
});

async function renderAndExtract(index, url) {
  // Avoid navigating the tab to downloads or media: check the type first.
  try {
    const head = await fetchWithTimeout(url, { method: 'HEAD' });
    const type = head.headers.get('content-type') || '';
    if (head.ok && type && !/html/i.test(type)) {
      state.skipped.nonHtml++;
      return null;
    }
  } catch { /* HEAD not supported — try loading anyway */ }

  const tabId = state.renderTabs[index];
  if (tabId == null) throw new Error('Render tab is not available.');
  await loadInTab(tabId, url);
  if (state.settings.renderWait) await sleep(state.settings.renderWait);
  return extractInTab(tabId);
}

function loadInTab(tabId, url) {
  return new Promise((resolve, reject) => {
    let started = false;
    const cleanup = () => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    };
    // On timeout, extract whatever has loaded so far.
    const timer = setTimeout(() => { cleanup(); resolve(); }, RENDER_TIMEOUT);
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') started = true;
      else if (info.status === 'complete' && started) { cleanup(); resolve(); }
    };
    const onRemoved = id => {
      if (id === tabId) { cleanup(); reject(new Error('Render tab was closed.')); }
    };
    browser.tabs.onUpdated.addListener(onUpdated, { tabId, properties: ['status'] });
    browser.tabs.onRemoved.addListener(onRemoved);
    browser.tabs.update(tabId, { url }).catch(e => { cleanup(); reject(e); });
  });
}

// ---------------------------------------------------------------------------
// robots.txt & sitemaps

async function loadRobots(origin) {
  const robots = { sitemaps: [], allowed: () => true };
  let text = '';
  try {
    const res = await fetchWithTimeout(origin + '/robots.txt', { credentials: 'omit' });
    if (res.ok) text = await res.text();
  } catch { /* no robots.txt */ }
  if (!text) return robots;

  const groups = [];
  let group = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'user-agent') {
      if (!group || !lastWasAgent) groups.push((group = { agents: [], rules: [] }));
      group.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') robots.sitemaps.push(value);
    else if (group && (key === 'allow' || key === 'disallow') && value) {
      group.rules.push({ allow: key === 'allow', path: value, re: robotsPattern(value) });
    }
  }

  let chosen = groups.filter(g => g.agents.some(a => a !== '*' && 'textextractor'.includes(a)));
  if (!chosen.length) chosen = groups.filter(g => g.agents.includes('*'));
  const rules = chosen.flatMap(g => g.rules);
  log(`robots.txt: ${rules.length} rule(s), ${robots.sitemaps.length} sitemap(s)`);

  robots.allowed = u => {
    const path = u.pathname + u.search;
    let best = null;
    for (const r of rules) {
      if (!r.re.test(path)) continue;
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
    return !best || best.allow;
  };
  return robots;
}

function robotsPattern(path) {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path)
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + body + (anchored ? '$' : ''));
}

async function loadSitemaps(origin, declared) {
  const pending = declared.length ? [...declared] : [origin + '/sitemap.xml'];
  const visited = new Set();
  const urls = new Set();
  const limit = state.settings.maxPages * 5;

  while (pending.length && visited.size < 25 && urls.size < limit && !state.cancel) {
    const sitemapUrl = pending.shift();
    if (visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);
    try {
      const res = await fetchWithTimeout(sitemapUrl);
      if (!res.ok) continue;
      const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
      if (xml.querySelector('parsererror')) continue;
      const isIndex = xml.documentElement.localName === 'sitemapindex';
      for (const loc of xml.getElementsByTagNameNS('*', 'loc')) {
        const value = loc.textContent.trim();
        if (!value) continue;
        if (isIndex) pending.push(value);
        else urls.add(value);
      }
    } catch (e) {
      log(`Sitemap ${sitemapUrl} failed: ${e.message}`, 'error');
    }
  }
  return Array.from(urls).slice(0, limit);
}

// ---------------------------------------------------------------------------
// Markdown document

function pathSegments(url) {
  const u = new URL(url);
  return u.pathname.split('/').filter(Boolean).map(decodeSafe);
}

function decodeSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function compareByStructure(a, b) {
  const ua = new URL(a.url);
  const ub = new URL(b.url);
  const ha = ua.hostname.replace(/^www\./, '');
  const hb = ub.hostname.replace(/^www\./, '');
  if (ha !== hb) return ha.localeCompare(hb);
  const sa = pathSegments(a.url);
  const sb = pathSegments(b.url);
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) {
    const c = sa[i].localeCompare(sb[i], undefined, { numeric: true, sensitivity: 'base' });
    if (c) return c;
  }
  return sa.length - sb.length || ua.search.localeCompare(ub.search);
}

const escapeLinkText = s => s.replace(/[[\]\\]/g, '\\$&');
const yamlString = s => JSON.stringify(String(s == null ? '' : s));

function pageTitle(p) {
  if (p.title) return p.title;
  const segs = pathSegments(p.url);
  return segs.length ? segs[segs.length - 1] : new URL(p.url).hostname;
}

const countWords = md => md.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length;
const TITLE_SEP = /(\s+[|–—·•:-]\s+|\s+::\s+)/;

function mostCommon(values) {
  const counts = new Map();
  for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  for (const [v, n] of counts) if (!best || n > best.n) best = { v, n };
  return best;
}

// Removes the site name that most titles share ("Presse | Site" → "Presse"). Returns the site name.
function stripSiteName(pages) {
  const split = pages.map(p => (p.title || '').split(TITLE_SEP));
  const multi = split.filter(parts => parts.length > 1);
  const min = Math.max(2, Math.ceil(pages.length * 0.5));
  const suffix = mostCommon(multi.map(parts => parts[parts.length - 1].trim()));
  const prefix = mostCommon(multi.map(parts => parts[0].trim()));
  const useSuffix = suffix && suffix.n >= min && (!prefix || suffix.n >= prefix.n);
  const affix = useSuffix ? suffix : prefix && prefix.n >= min ? prefix : null;
  if (!affix) return '';
  split.forEach((parts, i) => {
    if (parts.length < 2) return;
    if (useSuffix && parts[parts.length - 1].trim() === affix.v) pages[i].title = parts.slice(0, -2).join('').trim();
    else if (!useSuffix && parts[0].trim() === affix.v) pages[i].title = parts.slice(2).join('').trim();
  });
  return affix.v;
}

// Moves blocks that repeat on many pages (footer, contact box) out of the pages.
function extractSharedBlocks(pages) {
  if (pages.length < 3) return { blocks: [], min: 0 };
  const split = pages.map(p => TextExtractor.splitBlocks(p.markdown));
  const counts = new Map();
  for (const blocks of split) for (const b of new Set(blocks)) counts.set(b, (counts.get(b) || 0) + 1);
  const min = Math.max(3, Math.ceil(pages.length * 0.5));
  const shared = new Set();
  for (const [b, n] of counts) if (n >= min) shared.add(b);
  if (!shared.size) return { blocks: [], min };

  const ordered = new Set();
  split.forEach((blocks, i) => {
    for (const b of blocks) if (shared.has(b) && /[\p{L}\p{N}]/u.test(b)) ordered.add(b);
    pages[i].markdown = blocks.filter(b => !shared.has(b)).join('\n\n');
    pages[i].words = countWords(pages[i].markdown);
  });
  return { blocks: Array.from(ordered), min };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

async function buildResult() {
  const s = state.settings;
  const start = new URL(state.startUrl);
  const pages = state.pages.map(p => ({ ...p }));
  const isPage = s.mode === 'page';
  if (!isPage) {
    pages.sort(s.sort === 'crawl' ? (a, b) => a.seq - b.seq : compareByStructure);
  }
  const siteName = isPage ? '' : stripSiteName(pages);
  const shared = isPage ? { blocks: [], min: 0 } : extractSharedBlocks(pages);
  const sharedWords = countWords(shared.blocks.join('\n\n'));

  // One language line for the whole export unless pages differ.
  const commonLang = mostCommon(pages.map(p => p.lang));
  const lang = commonLang ? commonLang.v : '';

  const now = new Date();
  const words = pages.reduce((n, p) => n + p.words, 0) + sharedWords;
  const host = start.hostname.replace(/^www\./, '');
  const docTitle = isPage ? pageTitle(pages[0]) : `${siteName || host} — Website Text Export`;
  const out = [];

  out.push(
    '---',
    `title: ${yamlString(docTitle)}`,
    `source: ${yamlString(state.startUrl)}`,
    ...(siteName ? [`site: ${yamlString(siteName)}`] : []),
    ...(lang ? [`language: ${yamlString(lang)}`] : []),
    `exported: ${now.toISOString()}`,
    `mode: ${isPage ? 'single-page' : 'website-crawl'}`,
    `pages: ${pages.length}`,
    `words: ${words}`,
    `generator: "Text Extractor ${VERSION}"`,
    '---',
    '',
    `# ${docTitle}`,
    ''
  );

  const summary = [
    `**Source:** <${state.startUrl}>`,
    `**Exported:** ${now.toLocaleString()}`,
    `**Pages:** ${pages.length} · **Words:** ${words.toLocaleString()}${lang ? ` · **Language:** ${lang}` : ''}`
  ];
  if (isPage && pages[0].description) summary.push(`**Description:** ${pages[0].description}`);
  if (!isPage) {
    const scopeLabel = { host: 'same host', domain: 'host + subdomains', path: 'current folder' }[s.scope];
    summary.push(
      `**Crawl:** depth ≤ ${s.maxDepth}, max ${s.maxPages} pages, ${scopeLabel}, ${s.loader === 'render' ? 'rendered with JavaScript' : 'raw HTML'}`
    );
    if (state.cancel) summary.push('**Note:** crawl was stopped early; the export is partial.');
  }
  out.push(summary.map(l => `> ${l}  `).join('\n'), '');

  if (!isPage) {
    out.push('## Table of Contents', '');
    const minDepth = Math.min(...pages.map(p => pathSegments(p.url).length));
    let prevIndent = -1;
    pages.forEach((p, i) => {
      const path = new URL(p.url);
      let indent = 0;
      if (s.sort !== 'crawl') {
        indent = Math.max(0, Math.min(pathSegments(p.url).length - minDepth, prevIndent + 1));
        prevIndent = indent;
      }
      const label = escapeLinkText(pageTitle(p));
      const shown = decodeSafe(path.pathname + path.search);
      out.push(`${'  '.repeat(indent)}- [${label}](#page-${i + 1}) — \`${shown.replace(/`/g, '')}\``);
    });
    if (shared.blocks.length) out.push('- [Site-wide content](#site-wide)');
    out.push('', '---', '');
  }

  pages.forEach((p, i) => {
    if (isPage) {
      out.push(p.markdown || '_No text content found._', '');
      return;
    }
    out.push(`<a id="page-${i + 1}"></a>`, '', `## ${i + 1}. ${pageTitle(p)}`, '');
    const meta = [`**URL:** <${p.url}> · **Words:** ${p.words}`];
    if (p.lang && p.lang !== lang) meta[0] += ` · **Language:** ${p.lang}`;
    if (p.description) meta.push(`**Description:** ${p.description}`);
    out.push(meta.join('  \n'), '');
    out.push(p.markdown || '_Only site-wide content (see the end of this file)._', '', '---', '');
  });

  if (shared.blocks.length) {
    out.push(
      '<a id="site-wide"></a>',
      '',
      '## Site-wide content',
      '',
      `_Text found on ${shared.min} or more of the ${pages.length} pages, such as the footer. It appears only here._`,
      '',
      shared.blocks.join('\n\n'),
      '',
      '---',
      ''
    );
  }

  const sk = state.skipped;
  const skippedTotal = Object.values(sk).reduce((a, b) => a + b, 0);
  if (!isPage && (state.errors.length || skippedTotal || state.queue.length)) {
    out.push('## Crawl Report', '', '| Item | Count |', '| --- | --- |');
    out.push(`| Pages exported | ${pages.length} |`);
    if (state.queue.length) out.push(`| URLs left in queue (limit reached or stopped) | ${state.queue.length} |`);
    if (sk.duplicate) out.push(`| Duplicate pages skipped | ${sk.duplicate} |`);
    if (sk.empty) out.push(`| Pages without text | ${sk.empty} |`);
    if (sk.nonHtml) out.push(`| Non-HTML resources skipped | ${sk.nonHtml} |`);
    if (sk.robots) out.push(`| Blocked by robots.txt | ${sk.robots} |`);
    if (sk.outOfScope) out.push(`| Redirected out of scope | ${sk.outOfScope} |`);
    if (state.errors.length) out.push(`| Errors | ${state.errors.length} |`);
    out.push('');
    if (state.errors.length) {
      out.push('### Errors', '');
      for (const e of state.errors.slice(0, 500)) out.push(`- <${e.url}> — ${e.error}`);
      if (state.errors.length > 500) out.push(`- …and ${state.errors.length - 500} more`);
      out.push('');
    }
  }

  const markdown = out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  const stamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  const slug = isPage
    ? `${host}${start.pathname}`.replace(/\/+$/, '')
    : host;
  const filename = `${slug.replace(/[^\w.-]+/g, '_').slice(0, 80)}_${stamp}.md`;

  state.result = {
    markdown,
    filename,
    pages: pages.length,
    words,
    bytes: new Blob([markdown]).size
  };

  const info = { filename, pages: pages.length, words, bytes: state.result.bytes };
  try {
    await browser.storage.local.set({ lastResult: markdown, lastResultInfo: info });
  } catch (e) {
    log(`Could not store the result for later: ${e.message}`, 'error');
  }
}

async function getResult() {
  if (state.result) return state.result;
  const { lastResult, lastResultInfo } = await browser.storage.local.get(['lastResult', 'lastResultInfo']);
  return lastResult && lastResultInfo ? { markdown: lastResult, ...lastResultInfo } : null;
}

async function downloadResult(saveAs) {
  const result = await getResult();
  if (!result) throw new Error('There is no export to download yet.');
  const blob = new Blob([result.markdown], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    await browser.downloads.download({ url, filename: result.filename, saveAs: !!saveAs, conflictAction: 'uniquify' });
    log(`Saved ${result.filename}`);
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }
}
