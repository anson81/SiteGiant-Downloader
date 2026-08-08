/**
 * Popup UI. Holds no logic of its own — it asks the background worker for
 * state, renders it, and sends commands back.
 */
const $ = (id) => document.getElementById(id);

const BUSY = new Set(['exporting', 'downloading', 'pushing']);

const send = (msg) => chrome.runtime.sendMessage(msg);

let pollTimer = null;

function dotClass(status) {
  if (status === 'done') return 'dot done';
  if (status === 'error') return 'dot error';
  if (BUSY.has(status)) return 'dot busy';
  return 'dot';
}

function render(state) {
  const list = $('rows');
  list.textContent = '';

  const reports = state.reports || [];
  for (const report of reports) {
    const result = (state.results && state.results[report.id]) || { status: 'waiting' };

    const li = document.createElement('li');

    const dot = document.createElement('span');
    dot.className = dotClass(result.status);
    li.appendChild(dot);

    const text = document.createElement('div');
    text.className = 'row-text';

    const label = document.createElement('div');
    label.className = 'row-label';
    label.textContent = report.label;
    text.appendChild(label);

    const message = document.createElement('div');
    message.className = result.status === 'error' ? 'row-message error' : 'row-message';
    message.textContent = result.message || (result.status === 'waiting' ? 'Not run yet' : '');
    text.appendChild(message);

    li.appendChild(text);
    list.appendChild(li);
  }

  const running = Boolean(state.running);
  $('run-all').disabled = running;
  $('run-orders').disabled = running;
  $('run-stockcost').disabled = running;
  $('run-month').disabled = running;
  $('month').disabled = running;
  // Reloading mid-run would kill the worker between the download and the push,
  // leaving a file on disk that ProfitLens never receives.
  $('reload').disabled = running;
  $('cancel').hidden = !running;

  if (state.finishedAt) {
    const when = new Date(state.finishedAt);
    $('last-run').textContent = `Last run ${when.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  }

  const results = Object.values(state.results || {});
  const banner = $('banner');
  const failed = results.filter((r) => r.status === 'error');

  if (!running && failed.length > 0) {
    banner.hidden = false;
    banner.className = 'banner';
    banner.textContent = failed[0].message;
  } else if (!running && results.length > 0 && results.every((r) => r.status === 'done')) {
    banner.hidden = false;
    banner.className = 'banner ok';
    const fees = results.reduce((sum, r) => sum + (r.counts?.feeRateMissing || 0), 0);
    banner.textContent = fees
      ? `Done. ${fees} orders had no fee rate set, so their profit reads high.`
      : 'Done. Both reports are in ProfitLens.';
  } else {
    banner.hidden = true;
  }
}

async function refresh() {
  const state = await send({ type: 'getState' });
  if (state) render(state);

  if (state && state.running) {
    pollTimer = setTimeout(refresh, 700);
  } else if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
    // A run just ended, so the history has a new entry to show.
    loadHistory();
  }
}

async function run(ids, month = null) {
  await send({ type: 'run', ids, month });
  refresh();
}

/** The current month, as the month input wants it. */
function thisMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

async function runMonth() {
  const month = $('month').value;
  if (!month) {
    const banner = $('banner');
    banner.hidden = false;
    banner.className = 'banner';
    banner.textContent = 'Pick a month first.';
    return;
  }
  // Orders only: SiteGiant has no past version of stock and cost.
  await run(['orders'], month);
}

/** "8 Aug, 14:32" — enough to tell two runs apart without being a timestamp. */
function when(ms) {
  return new Date(ms).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Past runs, newest first.
 *
 * The point is the month tags: pulling a past month leaves a permanent export on
 * SiteGiant's side, so this answers "have I already done June?" without going and
 * looking at their list.
 */
function renderHistory(history) {
  const list = $('history');
  const count = $('history-count');
  list.textContent = '';

  const months = new Set(history.filter((h) => h.month).map((h) => h.month));
  count.textContent = months.size
    ? `· ${months.size} past ${months.size === 1 ? 'month' : 'months'}`
    : history.length
      ? `· ${history.length}`
      : '';

  if (history.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing yet. Runs will appear here.';
    list.appendChild(li);
    return;
  }

  for (const run of history) {
    const li = document.createElement('li');

    const head = document.createElement('div');
    head.className = 'history-when';
    const left = document.createElement('span');
    left.textContent = when(run.at);
    head.appendChild(left);

    if (run.month) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = run.month;
      head.appendChild(tag);
    } else if (run.days) {
      const tag = document.createElement('span');
      tag.textContent = `last ${run.days} days`;
      head.appendChild(tag);
    }
    li.appendChild(head);

    for (const report of run.reports ?? []) {
      const what = document.createElement('div');
      what.className = 'history-what';
      what.textContent =
        report.label + (report.status === 'done' ? '' : ` — ${report.status}`);
      li.appendChild(what);

      const detail = document.createElement('div');
      detail.className =
        report.status === 'error' ? 'history-detail error' : 'history-detail';
      detail.textContent = report.counts
        ? `${report.counts.created} new · ${report.counts.updated} updated · ${report.counts.unchanged} unchanged`
        : report.message || '';
      li.appendChild(detail);
    }

    list.appendChild(li);
  }
}

async function loadHistory() {
  const res = await send({ type: 'getHistory' });
  renderHistory(res?.history ?? []);
}

/**
 * The update bar lives here rather than in Settings.
 *
 * Checking and installing are things you do to the extension, and the extension
 * is this popup — burying them a page deep meant nobody looked.
 *
 * Installing still opens the options page: writing to the extension's own folder
 * needs a directory handle from a file picker, and opening a picker closes a
 * popup. So the button starts the job in a place that can finish it.
 */
function renderUpdate(info) {
  const bar = $('update-bar');
  const text = $('update-text');
  const action = $('update-action');

  if (!info) {
    text.textContent = 'Updates not checked yet';
    action.hidden = true;
    bar.classList.remove('available');
    return;
  }

  if (info.error) {
    text.textContent = `Could not check: ${info.error}`;
    action.hidden = true;
    bar.classList.remove('available');
    return;
  }

  if (info.available) {
    text.textContent = `Version ${info.latest} is available`;
    action.hidden = false;
    bar.classList.add('available');
    return;
  }

  text.textContent = `Up to date (v${info.current})`;
  action.hidden = true;
  bar.classList.remove('available');
}

document.addEventListener('DOMContentLoaded', async () => {
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;

  // Defaults to last month rather than this one: a part-finished month is
  // rarely what you want when reaching back for history.
  const now = new Date();
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  $('month').value = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}`;
  $('month').max = thisMonth();

  /**
   * No floor. An earlier version capped this at today-90, on the belief that
   * SiteGiant discarded anything older — it does not. Its picker only refuses
   * dates more than ~31 days from whatever is already chosen, and that window
   * ratchets backwards with every pick, so the content script can walk to any
   * month. Capping it here blocked months that were perfectly exportable.
   *
   * How far back real data goes is SiteGiant's business, and the run reports it
   * honestly if a month turns out to be empty.
   */
  $('month').removeAttribute('min');

  $('run-all').addEventListener('click', () => run(['orders', 'stockcost']));
  $('run-orders').addEventListener('click', () => run(['orders']));
  $('run-stockcost').addEventListener('click', () => run(['stockcost']));
  $('run-month').addEventListener('click', runMonth);
  $('cancel').addEventListener('click', () => send({ type: 'cancel' }));

  // Restarts the extension in place. Chrome runs the code it loaded at install
  // time, so editing a file changes nothing until this happens — which is why
  // it lives here rather than only on chrome://extensions.
  //
  // The popup closes as the extension goes down. That IS the confirmation.
  $('reload').addEventListener('click', () => chrome.runtime.reload());

  $('clear-history').addEventListener('click', async () => {
    await send({ type: 'clearHistory' });
    loadHistory();
  });

  $('open-folder').addEventListener('click', () => send({ type: 'openFolder' }));
  $('open-options').addEventListener('click', () => send({ type: 'openOptions' }));

  $('check').addEventListener('click', async () => {
    $('update-text').textContent = 'Checking…';
    renderUpdate(await send({ type: 'checkUpdate' }));
  });

  // Hands off to the options page, which is the only place a folder picker can
  // be opened without the window closing under it.
  $('update-action').addEventListener('click', () => send({ type: 'openOptions' }));

  refresh();
  loadHistory();

  const { updateInfo } = await chrome.storage.local.get('updateInfo');
  renderUpdate(updateInfo);

  // A quiet re-check; the badge only appears if something is actually newer.
  send({ type: 'checkUpdate' }).then(renderUpdate).catch(() => {});
});
