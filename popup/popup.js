/* Text Extractor — popup controller. */
'use strict';

const $ = id => document.getElementById(id);
const NUMBER_FIELDS = ['maxPages', 'maxDepth', 'concurrency', 'delay'];
const SELECT_FIELDS = ['scope', 'loader', 'sort'];
const CHECK_FIELDS = ['respectRobots', 'useSitemap', 'mainOnly', 'skipHidden', 'includeLinks', 'includeImages', 'saveAs'];

let settings = { ...TE_DEFAULTS };
let activeTab = null;
let pollTimer = null;
let resultDismissed = false;
let lastView = null;

init();

async function init() {
  const stored = await browser.storage.local.get('settings');
  settings = { ...TE_DEFAULTS, ...(stored.settings || {}) };
  applySettings();

  [activeTab] = await browser.tabs.query({ active: true, currentWindow: true });
  $('target').textContent = activeTab ? activeTab.url : 'No active tab';
  $('target').title = activeTab ? activeTab.title || activeTab.url : '';

  document.querySelectorAll('input, select, textarea').forEach(el => el.addEventListener('change', onSettingChange));
  $('start').addEventListener('click', onStart);
  $('stop').addEventListener('click', () => send({ type: 'stop' }));
  $('again').addEventListener('click', async () => {
    resultDismissed = true;
    await send({ type: 'dismiss' });
    refresh();
  });
  document.querySelectorAll('[data-action="download"]').forEach(b => b.addEventListener('click', onDownload));
  document.querySelectorAll('[data-action="copy"]').forEach(b => b.addEventListener('click', onCopy));

  updateModeUi();
  await refresh();
  pollTimer = setInterval(refresh, 500);
}

function send(msg) {
  return browser.runtime.sendMessage(msg);
}

// ---------------------------------------------------------------------------
// Settings

function applySettings() {
  document.querySelectorAll('input[name="mode"]').forEach(r => { r.checked = r.value === settings.mode; });
  NUMBER_FIELDS.forEach(k => { $(k).value = settings[k]; });
  SELECT_FIELDS.forEach(k => { $(k).value = settings[k]; });
  CHECK_FIELDS.forEach(k => { $(k).checked = !!settings[k]; });
  $('exclude').value = settings.exclude;
}

function readSettings() {
  const mode = document.querySelector('input[name="mode"]:checked');
  settings.mode = mode ? mode.value : 'page';
  NUMBER_FIELDS.forEach(k => {
    const n = parseInt($(k).value, 10);
    settings[k] = Number.isNaN(n) ? TE_DEFAULTS[k] : n;
  });
  SELECT_FIELDS.forEach(k => { settings[k] = $(k).value; });
  CHECK_FIELDS.forEach(k => { settings[k] = $(k).checked; });
  settings.exclude = $('exclude').value;
  return settings;
}

function onSettingChange(e) {
  if (e.target.id === 'loader') {
    // Rendering real tabs is heavy — keep parallelism modest.
    const c = $('concurrency');
    if ($('loader').value === 'render' && +c.value > 3) c.value = 2;
  }
  readSettings();
  browser.storage.local.set({ settings });
  updateModeUi();
}

function updateModeUi() {
  const site = settings.mode === 'site';
  $('siteOpts').hidden = !site;
  $('sortRow').hidden = !site;
  $('concurrency').max = settings.loader === 'render' ? 3 : 8;
  $('start').textContent = site ? 'Crawl website → Markdown' : 'Extract page → Markdown';

  const url = activeTab && activeTab.url ? activeTab.url : '';
  let problem = '';
  if (!/^(https?|file):/i.test(url)) {
    problem = 'Open a regular web page (http/https) to extract its text.';
  } else if (site && !/^https?:/i.test(url)) {
    problem = 'Website crawling requires an http(s) page.';
  }
  const notice = $('notice');
  notice.textContent = problem;
  notice.hidden = !problem;
  $('start').disabled = !!problem;
}

// ---------------------------------------------------------------------------
// Actions

async function onStart() {
  // Must be the first call in the click handler so Firefox treats it as user-initiated.
  let granted = false;
  try {
    granted = await browser.permissions.request({ origins: ['<all_urls>'] });
  } catch {
    granted = await browser.permissions.contains({ origins: ['<all_urls>'] });
  }
  if (!granted && settings.mode === 'site') {
    showNotice('Crawling needs permission to access websites.');
    return;
  }

  readSettings();
  await browser.storage.local.set({ settings });
  resultDismissed = false;
  $('start').disabled = true;
  const res = await send({ type: 'start', settings, tabId: activeTab.id, url: activeTab.url });
  if (!res || !res.ok) {
    showNotice((res && res.error) || 'Could not start.');
    $('start').disabled = false;
  }
  refresh();
}

async function onDownload(e) {
  const btn = e.currentTarget;
  btn.disabled = true;
  const res = await send({ type: 'download', saveAs: $('saveAs').checked });
  btn.disabled = false;
  if (!res.ok) flash(btn, res.error || 'Failed');
  else flash(btn, 'Saved ✓');
}

async function onCopy(e) {
  const btn = e.currentTarget;
  try {
    const result = await send({ type: 'getResult' });
    if (!result) throw new Error('Nothing to copy');
    await navigator.clipboard.writeText(result.markdown);
    flash(btn, 'Copied ✓');
  } catch (err) {
    flash(btn, err.message || 'Copy failed');
  }
}

function flash(btn, text) {
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = original; }, 1600);
}

function showNotice(text) {
  const notice = $('notice');
  notice.textContent = text;
  notice.hidden = false;
}

// ---------------------------------------------------------------------------
// Rendering

async function refresh() {
  let st;
  try {
    st = await send({ type: 'getState' });
  } catch {
    return;
  }
  if (!st) return;

  const busy = st.status === 'running' || st.status === 'stopping';
  const finished = ['done', 'stopped', 'error'].includes(st.status) && !resultDismissed;

  $('setup').hidden = busy || finished;
  $('progress').hidden = !busy;
  $('result').hidden = busy || !finished;

  const view = busy ? 'busy' : finished ? 'result' : 'idle';
  if (busy) renderProgress(st);
  else if (finished) renderResult(st);
  else renderIdle(st);
  lastView = view;
}

function renderIdle(st) {
  if (lastView !== 'idle') updateModeUi();
  const hasResult = !!st.result;
  $('lastExport').hidden = !hasResult;
  if (hasResult) $('lastExportName').textContent = st.result.filename;
}

function renderProgress(st) {
  $('progressTitle').textContent =
    st.status === 'stopping' ? 'Stopping…' : st.mode === 'site' ? `Crawling ${hostOf(st.startUrl)}` : 'Extracting page…';
  $('elapsed').textContent = formatDuration(st.elapsed);
  $('statDone').textContent = st.done;
  $('statQueued').textContent = st.queued;
  $('statSkipped').textContent = st.skipped;
  $('statErrors').textContent = st.errors;

  const total = Math.max(1, Math.min(st.maxPages, st.done + st.queued + st.inFlight));
  $('barFill').style.width = `${Math.min(100, (st.done / total) * 100)}%`;

  renderList($('current'), st.current.map(u => ({ text: u })));
  renderLog($('log'), st.log);
  $('stop').disabled = st.status === 'stopping';
  $('stop').hidden = st.mode === 'page';
}

function renderResult(st) {
  const ok = st.status !== 'error';
  $('resultBox').classList.toggle('bad', !ok);
  $('resultTitle').textContent =
    st.status === 'done' ? 'Export ready' : st.status === 'stopped' ? 'Stopped — partial export' : 'Something went wrong';

  const r = st.result;
  const hasFile = ok && !!r;
  $('resultInfo').textContent = hasFile
    ? `${r.filename} · ${r.pages} page(s) · ${r.words.toLocaleString()} words · ${formatBytes(r.bytes)} · ${formatDuration(st.elapsed)}`
    : '';
  $('resultMessage').textContent = st.message;
  $('resultMessage').hidden = !st.message;
  $('downloadBtn').disabled = !hasFile;
  $('copyBtn').disabled = !hasFile;
  renderLog($('resultLog'), st.mode === 'site' || !ok ? st.log : []);
}

function renderList(el, items) {
  const html = items.map(i => i.text).join('\n');
  if (el.dataset.sig === html) return;
  el.dataset.sig = html;
  el.replaceChildren(
    ...items.map(i => {
      const li = document.createElement('li');
      li.textContent = i.text;
      li.title = i.text;
      if (i.cls) li.className = i.cls;
      return li;
    })
  );
}

function renderLog(el, entries) {
  const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  renderList(el, entries.map(e => ({ text: e.text, cls: e.level === 'error' ? 'error' : '' })));
  if (stick) el.scrollTop = el.scrollHeight;
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return url; }
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

window.addEventListener('unload', () => clearInterval(pollTimer));
