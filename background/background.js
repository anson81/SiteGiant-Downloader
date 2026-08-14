/**
 * Background service worker.
 *
 * Owns orchestration, network fetches, disk writes and the update check. It
 * knows nothing about SiteGiant's DOM or ProfitLens's DOM — that lives in the
 * two content scripts. Keeping that boundary is what makes this maintainable
 * when either site is redesigned.
 */

const SITEGIANT = 'https://sitegiant.co';
const ORDERS_URL = `${SITEGIANT}/orders`;
const ORDERS_QUEUE_URL = `${SITEGIANT}/orders/export`;
const BATCH_EDIT_URL = `${SITEGIANT}/items/batch-edit`;
const ROOT_FOLDER = 'SiteGiant';

/** ProfitLens's multer limit. Anything larger is refused before it is sent. */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

const REPORTS = [
  {
    id: 'orders',
    label: 'Orders',
    endpoint: '/api/import/orders',
    marker: 'Orders_',
  },
  {
    id: 'stockcost',
    label: 'Stock & Cost',
    endpoint: '/api/import/products',
    marker: 'batch_edit_basic_info_all_',
  },
];

const DEFAULTS = {
  // ProfitLens is live at profitlens.my since 2026-08-13 (Synology NAS behind a
  // Cloudflare tunnel). The public address is the default because that is the
  // only one that works from every machine — a laptop in a cafe has no
  // localhost:3000. See MIGRATIONS below for installs that predate the launch.
  profitLensOrigin: 'https://profitlens.my',
  days: 7,
  minDays: 7,
  /**
   * SiteGiant refuses an orders export spanning more than about one month.
   * Confirmed on the live picker 2026-08-06: with a start of 2025-08-07 every
   * end date after 2025-09-07 renders as `ant-picker-cell-disabled`.
   *
   * So this is THEIR limit, not ours, and no upload-size reasoning can raise
   * it — 730 was briefly allowed here on the strength of file sizes alone,
   * which produced an export that could never be selected. 31 is the honest
   * ceiling; a longer backfill needs several exports, one month at a time.
   */
  maxDays: 31,
  push: true,
  updateSource: { owner: 'anson81', repo: 'SiteGiant-Downloader', branch: 'main' },
};

/* ------------------------------------------------------------------ *
 * State.
 * ------------------------------------------------------------------ */
let state = {
  running: false,
  cancelled: false,
  startedAt: null,
  finishedAt: null,
  folder: null,
  lastDownloadId: null,
  results: {},
};

function blankResults(ids) {
  const out = {};
  for (const id of ids) out[id] = { status: 'waiting', message: '' };
  return out;
}

function setResult(id, patch) {
  state.results[id] = { ...(state.results[id] || {}), ...patch };
  persist();
}

function persist() {
  chrome.storage.local.set({ state }).catch(() => {});
  setBadge();
}

function setBadge() {
  const values = Object.values(state.results);
  if (state.running) {
    chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
    chrome.action.setBadgeText({ text: '...' });
    return;
  }
  if (values.some((r) => r.status === 'error')) {
    chrome.action.setBadgeBackgroundColor({ color: '#dc2626' });
    chrome.action.setBadgeText({ text: '!' });
    return;
  }
  if (values.length && values.every((r) => r.status === 'done')) {
    chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
    chrome.action.setBadgeText({ text: 'OK' });
    return;
  }
  chrome.action.setBadgeText({ text: '' });
}

/* ------------------------------------------------------------------ *
 * Settings.
 * ------------------------------------------------------------------ */
async function getSettings() {
  const stored = await chrome.storage.local.get([
    'profitLensOrigin',
    'days',
    'push',
    'updateSource',
    'lastSuccessfulPush',
    'lastOrdersExport',
  ]);
  return {
    profitLensOrigin: stored.profitLensOrigin || DEFAULTS.profitLensOrigin,
    days: Number(stored.days) || DEFAULTS.days,
    push: stored.push !== false,
    updateSource: stored.updateSource || DEFAULTS.updateSource,
    lastSuccessfulPush: stored.lastSuccessfulPush || null,
    lastOrdersExport: stored.lastOrdersExport || null,
  };
}

/**
 * The address every install carried before ProfitLens went live.
 *
 * Changing DEFAULTS alone would move nobody: the old default was written into
 * chrome.storage the first time the options page was saved, and a stored value
 * always wins. So installs that still hold the pre-launch address — and only
 * that exact address — are moved to the public one on update. A deliberately
 * chosen origin (a different port, a LAN IP) is left alone, because it cannot
 * be told apart from the old default by anything except its exact value.
 */
const PRE_LAUNCH_ORIGIN = 'http://localhost:3000';

async function migrateSettings() {
  const { profitLensOrigin } = await chrome.storage.local.get('profitLensOrigin');
  if (profitLensOrigin !== PRE_LAUNCH_ORIGIN) return;
  await chrome.storage.local.set({ profitLensOrigin: DEFAULTS.profitLensOrigin });
}

/* ------------------------------------------------------------------ *
 * Dates.
 * ------------------------------------------------------------------ */
const pad = (n) => String(n).padStart(2, '0');

/**
 * How old an export is, read from its own filename.
 *
 * SiteGiant ends every export name with the Unix time it was requested —
 * `batch_edit_basic_info_all_04-08-2026-1785830507.zip` is 2026-08-04 16:01:47,
 * which matches that row's "Time Requested" exactly. Verified against two real
 * rows, so this is read, not guessed.
 */
/**
 * When SiteGiant built an export, read from the epoch in its own filename
 * (`..._13-08-2026-1786587745.zip`). 0 when a name does not carry one.
 *
 * Checked against the live list: the stamp matches the row's Time Requested to
 * the second, so SiteGiant's clock and this machine's agree.
 */
function exportTimeMs(name) {
  const match = /-(\d{10})\.zip$/i.exec(String(name || ''));
  return match ? Number(match[1]) * 1000 : 0;
}

function exportAgeMs(name) {
  const built = exportTimeMs(name);
  return built ? Date.now() - built : Infinity;
}

/** Room for the two clocks to disagree, without letting yesterday through. */
const CLOCK_SLACK_MS = 5 * 60 * 1000;

/**
 * Reuse exists ONLY to stop a double-click or an immediate retry building two
 * identical exports. It is deliberately short.
 *
 * It started as same-day, which was plainly wrong — a 9pm press got a 2pm file.
 * Fifteen minutes was still too long in practice: pressing the button and
 * watching it skip Generate reads as a failure, and the data is not what you
 * asked for. Pressing the button should mean "go and get it".
 */
const REUSE_WINDOW_MS = 3 * 60 * 1000;

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dateFolder(d) {
  return `${pad(d.getDate())}${pad(d.getMonth() + 1)}${d.getFullYear()}-${DAY_NAMES[d.getDay()]}`;
}

/**
 * How many days of orders to ask for.
 *
 * Defaults to the configured window, but widens to cover any gap since the
 * last successful push — miss twelve days and it fetches twelve, so a skipped
 * week does not leave a permanent hole. Clamped at both ends: never less than
 * the window, never more than maxDays (the 15 MB upload cap is the real
 * ceiling).
 */
function windowDays(settings) {
  // Clamped at BOTH ends here, not only on the gap-widening path below. A
  // setting stored while the cap was higher (365 was briefly allowed) would
  // otherwise sail straight through the early return and ask SiteGiant for a
  // span it refuses.
  const base = Math.min(Math.max(settings.days, DEFAULTS.minDays), DEFAULTS.maxDays);
  if (!settings.lastSuccessfulPush) return base;

  const since = new Date(settings.lastSuccessfulPush);
  if (Number.isNaN(since.getTime())) return base;

  const elapsed = Math.ceil((Date.now() - since.getTime()) / 86400000);
  return Math.min(Math.max(base, elapsed + 1), DEFAULTS.maxDays);
}

/* ------------------------------------------------------------------ *
 * Tabs.
 * ------------------------------------------------------------------ */
async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch (_) {
    return null;
  }
}

async function awaitTabLoad(tabId, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  // Give the navigation a moment to actually start before sampling status.
  await new Promise((r) => setTimeout(r, 400));
  for (;;) {
    const tab = await getTab(tabId);
    if (!tab) throw new Error('The SiteGiant tab was closed');
    if (tab.status === 'complete') return tab;
    if (Date.now() > deadline) throw new Error('SiteGiant took too long to load');
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function navigate(tabId, url) {
  await chrome.tabs.update(tabId, { url, active: true });
  await awaitTabLoad(tabId);
  await waitForContentScript(tabId);
}

/**
 * Waits for the tab to actually land on a URL.
 *
 * Needed because submitting the orders dialog is a form POST that navigates,
 * and a navigation does not start the instant the button is clicked. Sampling
 * tab.status alone would see the OLD page still sitting at 'complete' and
 * charge ahead — then poll the wrong page for a queue that isn't there.
 */
async function waitForUrl(tabId, pattern, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tab = await getTab(tabId);
    if (!tab) throw new Error('The SiteGiant tab was closed');
    if (pattern.test(tab.url || '') && tab.status === 'complete') return tab;
    if (Date.now() > deadline) {
      throw new Error('SiteGiant did not open the export list after submitting');
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function sendToContent(tabId, msg) {
  const res = await chrome.tabs.sendMessage(tabId, msg);
  if (res && res.error) throw new Error(res.error);
  return res;
}

/**
 * Pings until the content script answers, injecting it if it is not there.
 *
 * The injection is not belt-and-braces, it is required. Chrome only
 * auto-injects declared content scripts into pages loaded AFTER the extension
 * starts, so every tab that was already open when the extension was installed
 * or reloaded has no script in it — and answers with "Receiving end does not
 * exist". Telling the user to refresh every tab is not a fix; injecting is.
 */
async function waitForContentScript(tabId, file = 'content/sitegiant.js', timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let injected = false;

  for (;;) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'ping' });
      if (res && res.ok) return true;
    } catch (_) {
      /* not ready — fall through to injection */
    }

    if (!injected) {
      injected = true;
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
      } catch (err) {
        // A restricted page (chrome://, the Web Store) can never take a script.
        const tab = await getTab(tabId);
        throw new Error(
          `Could not run on ${tab?.url || 'that tab'} — ${err?.message || err}`
        );
      }
    }

    if (Date.now() > deadline) throw new Error('The page did not respond');
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function ensureSiteGiantTab() {
  const tabs = await chrome.tabs.query({ url: `${SITEGIANT}/*` });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    // An already-open tab may predate the extension and hold no script.
    await waitForContentScript(tabs[0].id);
    return tabs[0].id;
  }
  const tab = await chrome.tabs.create({ url: ORDERS_QUEUE_URL, active: true });
  await awaitTabLoad(tab.id);
  await waitForContentScript(tab.id);
  return tab.id;
}

/* ------------------------------------------------------------------ *
 * Waiting for an export to finish.
 *
 * A Pending row has NO download link and an EMPTY File Name, so a new link
 * appearing is the only honest "ready" signal. Matching on "is there a
 * Download button" would be true the moment the table renders.
 *
 * Observed on the live site: orders complete in about a second, Basic Info in
 * under ten. A 2s poll is generous for both.
 *
 * "A name I had not seen" is NOT on its own proof of a new export. The list
 * does not always render every row at once, so a row can be new to us and a
 * week old in fact — on 13 Aug that handed a run a 6 Aug stock file, which was
 * then filed under today and pushed as today's costs. Each candidate must also
 * say, in its own filename, that it was built after we pressed the button.
 * ------------------------------------------------------------------ */
async function pollForNewExport(tabId, { command, before, refresh, since, timeoutMs = 120000 }) {
  const deadline = Date.now() + timeoutMs;
  const notBefore = (since || Date.now()) - CLOCK_SLACK_MS;

  for (;;) {
    if (state.cancelled) throw new Error('Cancelled');

    const { rows } = await sendToContent(tabId, { type: command });
    const fresh = rows.find((r) => {
      if (before.has(r.name)) return false;
      const built = exportTimeMs(r.name);
      // A name with no stamp cannot be judged; unseen is all we have.
      return !built || built >= notBefore;
    });
    if (fresh) return fresh;

    if (Date.now() > deadline) {
      throw new Error('SiteGiant is still building the export — try again in a minute');
    }

    await new Promise((r) => setTimeout(r, 2000));

    if (refresh === 'button') {
      await sendToContent(tabId, { type: 'batchRefresh' });
    } else {
      // The orders queue has no refresh control; a reload is how you check it.
      await chrome.tabs.reload(tabId);
      await awaitTabLoad(tabId);
      await waitForContentScript(tabId);
    }
  }
}

/* ------------------------------------------------------------------ *
 * The two reports.
 * ------------------------------------------------------------------ */

/**
 * Orders.
 *
 * Reuse rule: only reuse a same-day export that THIS extension created for the
 * same window. The queue shows a request date but not the range a file covers,
 * so reusing an arbitrary same-day file could import the wrong period — a
 * manual export Anson made for one day would silently stand in for seven.
 */
/**
 * The Malaysian calendar month `2026-07` as a start/end pair.
 *
 * A calendar month is never more than 31 days, so it always fits SiteGiant's
 * span limit — which is why picking a month is a better way to reach history
 * than asking for "the last N days" and hoping N is small enough.
 */
function monthRange(month) {
  const [year, m] = String(month).split('-').map(Number);
  if (!year || !m || m < 1 || m > 12) return null;

  // LOCAL dates, deliberately. The extension runs in the seller's browser, which
  // is already on Malaysian time, and the content script reads the calendar with
  // getFullYear/getMonth/getDate. Converting through UTC here would shift the
  // first and last of the month by eight hours and pick the wrong days.
  const start = new Date(year, m - 1, 1);
  // Day 0 of the next month is the last day of this one, whatever its length.
  const end = new Date(year, m, 0);
  return { start, end, label: `${year}-${String(m).padStart(2, '0')}` };
}

async function runOrders(tabId, settings, { month } = {}) {
  await navigate(tabId, ORDERS_QUEUE_URL);

  const range = month ? monthRange(month) : null;
  if (month && !range) throw new Error(`"${month}" is not a month I understand`);

  const days = range ? null : windowDays(settings);
  const { rows } = await sendToContent(tabId, { type: 'ordersQueue' });
  const remembered = settings.lastOrdersExport;

  // Only an export this extension made, for this same window, minutes ago.
  // The queue shows a request time but not the range a file covers, so a
  // manual one-day export must never stand in for seven — and a rolling
  // seven-day file must never stand in for a specific month.
  if (
    remembered &&
    remembered.days === days &&
    remembered.month === (range?.label ?? null) &&
    exportAgeMs(remembered.name) < REUSE_WINDOW_MS &&
    rows.some((r) => r.name === remembered.name)
  ) {
    const row = rows.find((r) => r.name === remembered.name);
    return { ...row, reused: true, days, month: range?.label ?? null };
  }

  const before = new Set(rows.map((r) => r.name));

  const end = range ? range.end : new Date();
  const start = range ? range.start : addDays(end, -(days - 1));

  await navigate(tabId, ORDERS_URL);

  const since = Date.now();

  // Submitting is a form POST that NAVIGATES. The page can tear down before it
  // acknowledges the message, so a closed port here means the click landed —
  // not that it failed. Any other error is real and must surface.
  try {
    await sendToContent(tabId, {
      type: 'ordersSubmit',
      startISO: start.toISOString(),
      endISO: end.toISOString(),
    });
  } catch (err) {
    const message = err?.message || String(err);
    const navigatedAway = /message port closed|Receiving end does not exist|Extension context/i.test(
      message
    );
    if (!navigatedAway) throw err;
  }

  await waitForUrl(tabId, /\/orders\/export/);
  await waitForContentScript(tabId);

  // A 7-day export finishes in about a second; a busy month is a bigger job.
  // Scaled by the days actually asked for, not by the setting.
  const spanDays = Math.round((end - start) / 86400000) + 1;
  const row = await pollForNewExport(tabId, {
    command: 'ordersQueue',
    before,
    refresh: 'reload',
    since,
    timeoutMs: Math.min(120000 + spanDays * 1000, 600000),
  });

  await chrome.storage.local.set({
    lastOrdersExport: { name: row.name, days, month: range?.label ?? null },
  });
  return { ...row, reused: false, days, month: range?.label ?? null };
}

/**
 * Stock & Cost (Batch Edit -> Basic Info -> All).
 *
 * No date range exists for this export: it is always a full snapshot of every
 * SKU. So any same-day file is equivalent to one we would create, and reuse is
 * unconditional — unlike orders.
 */
async function runStockCost(tabId) {
  await navigate(tabId, BATCH_EDIT_URL);

  const { rows } = await sendToContent(tabId, { type: 'batchQueue' });

  // Newest first, but sort explicitly rather than trusting the table's order.
  const newest = rows.slice().sort((a, b) => exportAgeMs(a.name) - exportAgeMs(b.name))[0];
  if (newest && exportAgeMs(newest.name) < REUSE_WINDOW_MS) {
    return { ...newest, reused: true };
  }

  const before = new Set(rows.map((r) => r.name));
  const since = Date.now();
  await sendToContent(tabId, { type: 'batchGenerate' });

  const row = await pollForNewExport(tabId, {
    command: 'batchQueue',
    before,
    refresh: 'button',
    since,
  });

  return { ...row, reused: false };
}

/* ------------------------------------------------------------------ *
 * Fetching and saving.
 *
 * The CDN links carry no token and need no cookie, so the worker can fetch
 * them directly. (Worth knowing: that also means anyone holding a link can
 * retrieve the file. SiteGiant's design, not ours.)
 * ------------------------------------------------------------------ */
async function fetchZip(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const buffer = await res.arrayBuffer();

  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return { base64: btoa(binary), size: bytes.length };
}

/**
 * downloads.download({filename}) is a SUGGESTION, not an instruction — another
 * extension listening on onDeterminingFilename can override it, which is how
 * files ended up loose in Downloads on the Shopee twin. We re-assert our path
 * through the same listener. Saves are serial, so one pending path is enough.
 */
let pendingPath = null;

/* ------------------------------------------------------------------ *
 * Surviving the service worker
 *
 * `pendingPath` and `state.folder` lived only in this worker's memory, and
 * MV3 stops an idle worker — which a run spends minutes being, while it waits
 * on SiteGiant to generate an export. When the worker came back for the
 * download event both were gone, no name was suggested, and Chrome fell back
 * to its own: "download.zip". The extension then correctly reported that
 * something had overridden it, and pointed at other extensions, when the name
 * had in fact been dropped here.
 *
 * storage.session holds this across worker restarts without touching disk,
 * and Chrome clears it on exit, so a stale run cannot outlive the browser.
 * ------------------------------------------------------------------ */
function persistRun() {
  return chrome.storage.session
    .set({
      runtimeState: {
        running: state.running,
        folder: state.folder,
        pendingPath,
      },
    })
    .catch(() => {});
}

async function hydrateRun() {
  if (state.running) return;
  try {
    const { runtimeState } = await chrome.storage.session.get('runtimeState');
    if (runtimeState && runtimeState.running) {
      state.running = true;
      state.folder = runtimeState.folder;
      if (!pendingPath) pendingPath = runtimeState.pendingPath || null;
    }
  } catch (_) {
    /* nothing worth restoring */
  }
}

// Started at module evaluation, so a woken worker is already catching up
// before the download event it was woken for is handled. `hydrated` flips once
// it has settled, which is what lets the filename listener answer without
// waiting — see the listener for why that decides where the file lands.
let hydrated = false;
const hydrating = hydrateRun().then(() => {
  hydrated = true;
});

/**
 * A run waits minutes on SiteGiant, and Chrome stops an idle worker after
 * about 30 seconds. Any extension API call resets that timer; hydrateRun() is
 * the safety net for when this is not enough.
 */
let keepAliveTimer = null;

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 20000);
}

function stopKeepAlive() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

/**
 * The path this download should take, or null to leave it to Chrome.
 *
 * Deliberately synchronous: it only reads what is already in memory.
 */
function decideDownloadPath(item) {
  if (!pendingPath) return null;
  if (item.byExtensionId !== chrome.runtime.id) return null;
  return pendingPath;
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  // ANSWER SYNCHRONOUSLY WHENEVER POSSIBLE.
  //
  // This listener used to await hydration on every download, even a warm
  // worker mid-run with the path sitting in memory. That looked correct and
  // was not: an answer that arrives after Chrome has settled on a filename is
  // the same as no answer at all, and Chrome falls back to its own name —
  // "download.zip", then "download (1).zip" for the second file of the run.
  // It is a race, so it passed here and failed on a slower machine, which is
  // the worst way for a bug to behave. The Shopee twin lost a whole run to
  // this on 10 Aug and has answered synchronously ever since.
  //
  // On a worker that is already awake — which the keep-alive exists to ensure
  // during a run — everything needed is in memory, so this is decided before
  // the listener returns.
  // `pendingPath` in memory is authoritative — hydration only ever fills a
  // blank one — so it is as good a reason to answer at once as hydration is.
  if (hydrated || pendingPath) {
    const path = decideDownloadPath(item);
    if (path) suggest({ filename: path, conflictAction: 'overwrite' });
    else suggest();
    return;
  }

  // The only remaining case: a worker woken by this very event with nothing in
  // memory yet. Returning true is what buys the wait. Answering late is a
  // gamble on Chrome still listening, but saying nothing loses the name for
  // certain.
  hydrating
    .then(() => {
      const path = decideDownloadPath(item);
      if (path) suggest({ filename: path, conflictAction: 'overwrite' });
      else suggest();
    })
    .catch(() => suggest());
  return true;
});

/** Waits for Chrome to finish writing, so "saved" is a fact and not a hope. */
async function verifyDownload(downloadId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item) throw new Error('Chrome lost track of the download');
    if (item.state === 'complete') return item;
    if (item.state === 'interrupted') {
      throw new Error(`Chrome could not save the file: ${item.error || 'interrupted'}`);
    }
    if (Date.now() > deadline) throw new Error('The download did not finish');
    await new Promise((r) => setTimeout(r, 400));
  }
}

function basename(p) {
  return String(p || '').split(/[\\/]/).pop();
}

async function saveFile(base64, filename) {
  const path = `${ROOT_FOLDER}/${state.folder}/${filename}`;
  pendingPath = path;
  // Awaited, not fired and forgotten: the download starts on the next line and
  // the listener may be reading this back from a worker that restarted since.
  await persistRun();

  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: `data:application/zip;base64,${base64}`,
      filename: path,
      conflictAction: 'overwrite',
      saveAs: false,
    });
  } finally {
    // Cleared on a beat: onDeterminingFilename fires just after download()
    // resolves, so releasing it immediately would race the listener.
    setTimeout(() => {
      pendingPath = null;
      persistRun();
    }, 5000);
  }

  const item = await verifyDownload(downloadId);

  // If Chrome saved it elsewhere, something overrode us. Say so rather than
  // ticking a file that is not where we claim it is.
  const saved = basename(item.filename);
  if (saved && saved !== filename) {
    throw new Error(
      `Chrome saved this as "${saved}" instead of "${filename}". ` +
        'Another extension may be overriding download filenames — check chrome://extensions.'
    );
  }

  state.lastDownloadId = downloadId;
  persist();
  return { downloadId, path: item.filename };
}

/* ------------------------------------------------------------------ *
 * Pushing into ProfitLens.
 * ------------------------------------------------------------------ */
/**
 * Finds a ProfitLens tab we can actually run in.
 *
 * Two traps, both hit in practice:
 *  - Chrome match patterns cannot contain a port, so `http://localhost:3000/*`
 *    matches nothing. Origins are compared in JS instead, which keeps the port
 *    meaningful when choosing a tab while the manifest stays portless.
 *  - The first matching tab is not necessarily a usable one. A discarded
 *    (memory-saved) or errored tab reports the right URL but cannot be
 *    scripted at all. So every candidate is tried, and if none answer, a fresh
 *    tab is opened — a new load auto-injects the declared content script.
 */
async function ensureProfitLensTab(origin) {
  const all = await chrome.tabs.query({});
  const candidates = all.filter(
    (t) => t.url && (t.url === origin || t.url.startsWith(`${origin}/`))
  );

  for (const tab of candidates) {
    if (tab.discarded) continue;
    try {
      await waitForContentScript(tab.id, 'content/profitlens.js', 6000);
      return tab.id;
    } catch (_) {
      /* unusable — try the next one */
    }
  }

  const tab = await chrome.tabs.create({ url: origin, active: false });
  await awaitTabLoad(tab.id);
  await waitForContentScript(tab.id, 'content/profitlens.js');
  return tab.id;
}

async function pushToProfitLens(report, filename, base64, settings) {
  const origin = settings.profitLensOrigin.replace(/\/+$/, '');

  let tabId;
  try {
    tabId = await ensureProfitLensTab(origin);
  } catch (err) {
    // Chrome withholding host access is a settings problem, not a code one,
    // and the raw message gives no clue what to do about it.
    if (/Cannot access contents|must request permission/i.test(err?.message || '')) {
      throw new Error(
        `Chrome is blocking access to ${origin}. Open chrome://extensions → ` +
          'SiteGiant Downloader → Details → Site access → "On all sites". ' +
          'The file is saved either way.'
      );
    }
    throw err;
  }

  const res = await chrome.tabs.sendMessage(tabId, {
    type: 'push',
    endpoint: report.endpoint,
    filename,
    base64,
  });

  if (res && res.error) {
    if (res.error === 'NOT_LOGGED_IN') {
      throw new Error('Not logged in to ProfitLens — the file is saved, log in and press Push');
    }
    throw new Error(res.error);
  }
  return res;
}

/* ------------------------------------------------------------------ *
 * The run.
 * ------------------------------------------------------------------ */
async function runReports(ids, { month } = {}) {
  if (state.running) return publicState();

  const settings = await getSettings();

  // A month can only mean orders. SiteGiant's Batch Edit exports the stock and
  // cost as they are RIGHT NOW — there is no historical version to ask for, so
  // running it for July would quietly file today's stock under July.
  const wanted = month ? ids.filter((id) => id === 'orders') : ids;
  const selected = REPORTS.filter((r) => wanted.includes(r.id));

  if (selected.length === 0) {
    return publicState();
  }

  state = {
    running: true,
    cancelled: false,
    startedAt: Date.now(),
    finishedAt: null,
    // A month's export is filed under that month, not under today. Twelve
    // backfill runs would otherwise all land in one folder named for the day
    // they happened to be fetched, which tells you nothing about what is in it.
    folder: month ? `${month}-monthly` : dateFolder(new Date()),
    lastDownloadId: null,
    results: blankResults(selected.map((r) => r.id)),
  };
  persist();
  persistRun();
  startKeepAlive();

  let tabId;
  try {
    tabId = await ensureSiteGiantTab();
    const login = await sendToContent(tabId, { type: 'checkLogin' });
    if (!login.ok) throw new Error('Please log in to SiteGiant first');
  } catch (err) {
    for (const r of selected) setResult(r.id, { status: 'error', message: err.message });
    state.running = false;
    state.finishedAt = Date.now();
    persist();
    persistRun();
    stopKeepAlive();
    return publicState();
  }

  let anyPushed = false;

  for (const report of selected) {
    if (state.cancelled) {
      setResult(report.id, { status: 'error', message: 'Cancelled' });
      continue;
    }

    try {
      setResult(report.id, { status: 'exporting', message: 'Asking SiteGiant…' });

      const row =
        report.id === 'orders'
          ? await runOrders(tabId, settings, { month })
          : await runStockCost(tabId);

      // Say WHY a file was reused. "Reusing today's export" looked like a
      // failure to generate — the age is the whole explanation.
      const ageMin = Math.max(0, Math.round(exportAgeMs(row.name) / 60000));
      setResult(report.id, {
        status: 'downloading',
        message: row.reused
          ? `Reusing the export from ${ageMin} min ago`
          : 'Built a fresh export · downloading…',
        filename: row.name,
      });

      const { base64, size } = await fetchZip(row.url);
      await saveFile(base64, row.name);

      setResult(report.id, {
        status: settings.push ? 'pushing' : 'done',
        message: settings.push ? 'Sending to ProfitLens…' : `Saved (${Math.round(size / 1024)} KB)`,
        filename: row.name,
        size,
      });

      if (settings.push) {
        // Designed from the start, but only written once a backfill made it
        // reachable. multer rejects anything over 15 MB, and its error says
        // nothing about what to do next.
        if (size > MAX_UPLOAD_BYTES) {
          throw new Error(
            `That export is ${(size / 1048576).toFixed(1)} MB and ProfitLens accepts 15 MB. ` +
              'The file is saved — lower "days of orders" in Settings and run again.'
          );
        }

        const pushed = await pushToProfitLens(report, row.name, base64, settings);
        anyPushed = true;
        setResult(report.id, {
          status: 'done',
          message:
            `${pushed.created} new · ${pushed.updated} updated · ${pushed.unchanged} unchanged` +
            (row.reused ? ` · from a ${ageMin} min old export` : ''),
          counts: pushed,
        });
      }
    } catch (err) {
      setResult(report.id, { status: 'error', message: err?.message || String(err) });
    }
  }

  if (anyPushed) {
    await chrome.storage.local.set({ lastSuccessfulPush: new Date().toISOString() });
  }

  await recordHistory({ month, days: month ? null : windowDays(settings), selected });

  state.running = false;
  state.finishedAt = Date.now();
  persist();
  persistRun();
  stopKeepAlive();
  return publicState();
}

/** How many past runs to keep. Enough to answer "did I already do June?". */
const HISTORY_LIMIT = 60;

/**
 * Appends this run to the history the popup shows.
 *
 * Exists because of the month picker: pulling a past month creates a permanent
 * export on SiteGiant's side, so "have I already done June?" is a question worth
 * being able to answer without going and looking at their Exported list.
 *
 * Records what was ASKED FOR and what came back, including failures — a run that
 * errored is exactly the one you need to see again.
 */
async function recordHistory({ month, days, selected }) {
  const entry = {
    at: Date.now(),
    month: month ?? null,
    days: days ?? null,
    folder: state.folder,
    reports: selected.map((report) => {
      const result = state.results[report.id] ?? {};
      return {
        id: report.id,
        label: report.label,
        status: result.status ?? 'unknown',
        filename: result.filename ?? null,
        message: result.message ?? '',
        counts: result.counts
          ? {
              created: result.counts.created ?? 0,
              updated: result.counts.updated ?? 0,
              unchanged: result.counts.unchanged ?? 0,
            }
          : null,
      };
    }),
  };

  const { history = [] } = await chrome.storage.local.get('history');
  history.unshift(entry);
  await chrome.storage.local.set({ history: history.slice(0, HISTORY_LIMIT) });
}

function publicState() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    folder: state.folder,
    results: state.results,
    reports: REPORTS.map((r) => ({ id: r.id, label: r.label })),
  };
}

async function revealFolder() {
  if (state.lastDownloadId != null) {
    try {
      await chrome.downloads.show(state.lastDownloadId);
      return { ok: true };
    } catch (_) {
      /* fall through */
    }
  }
  chrome.downloads.showDefaultFolder();
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Update check.
 *
 * The worker only CHECKS. Installing writes to the extension's own folder,
 * which only the options page can do (it needs a user-granted directory
 * handle), so that half lives there.
 * ------------------------------------------------------------------ */
function currentVersion() {
  return chrome.runtime.getManifest().version;
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function rawUrl(cfg, file) {
  return `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}/${file}`;
}

async function checkUpdate() {
  const settings = await getSettings();
  const cfg = settings.updateSource;

  try {
    const res = await fetch(`${rawUrl(cfg, 'update.json')}?t=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const manifest = await res.json();

    const available = compareVersions(manifest.version, currentVersion()) > 0;
    const info = {
      checkedAt: Date.now(),
      available,
      latest: manifest.version,
      current: currentVersion(),
      notes: manifest.notes || [],
    };
    await chrome.storage.local.set({ updateInfo: info });
    return info;
  } catch (err) {
    const info = {
      checkedAt: Date.now(),
      available: false,
      current: currentVersion(),
      error: err?.message || String(err),
    };
    await chrome.storage.local.set({ updateInfo: info });
    return info;
  }
}

/* ------------------------------------------------------------------ *
 * Messages.
 * ------------------------------------------------------------------ */
async function handle(msg) {
  switch (msg.type) {
    case 'ping':
      return { ok: true };
    case 'getState':
      return publicState();
    case 'run':
      return runReports(msg.ids && msg.ids.length ? msg.ids : REPORTS.map((r) => r.id), {
        month: msg.month ?? null,
      });
    case 'cancel':
      state.cancelled = true;
      return { ok: true };
    case 'openFolder':
      return revealFolder();
    case 'openOptions':
      chrome.runtime.openOptionsPage();
      return { ok: true };
    case 'checkUpdate':
      return checkUpdate();
    case 'getHistory': {
      const { history = [] } = await chrome.storage.local.get('history');
      return { history };
    }
    case 'clearHistory':
      await chrome.storage.local.remove('history');
      return { ok: true };
    case 'getSettings':
      return getSettings();
    case 'saveSettings':
      await chrome.storage.local.set(msg.values || {});
      return getSettings();
    default:
      return { error: `Unknown command: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ error: err?.message || String(err) }));
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get('state').then(({ state: saved }) => {
    if (saved) state = { ...saved, running: false };
    setBadge();
  });
  migrateSettings().catch(() => {});
  checkUpdate();
});
