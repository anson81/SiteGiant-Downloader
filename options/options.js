/**
 * Options page.
 *
 * Also owns update INSTALLATION, which the background worker cannot do: writing
 * to the extension's own folder needs a directory handle the user granted
 * through a picker, and only a real page can show one.
 */
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let savedTimer = null;

function flashSaved() {
  const el = $('saved');
  el.hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    el.hidden = true;
  }, 1400);
}

async function save() {
  // Must match DEFAULTS.minDays / maxDays in the background worker.
  const days = Math.min(31, Math.max(7, Number($('days').value) || 7));
  $('days').value = days;

  await send({
    type: 'saveSettings',
    values: {
      profitLensOrigin: $('origin').value.trim().replace(/\/+$/, '') || 'https://profitlens.my',
      days,
      push: $('push').checked,
      updateSource: {
        owner: $('owner').value.trim(),
        repo: $('repo').value.trim(),
        branch: $('branch').value.trim() || 'main',
      },
    },
  });
  flashSaved();
}

function renderUpdate(info) {
  const status = $('update-status');
  const install = $('install');

  if (!info) {
    status.textContent = 'Not checked yet.';
    install.hidden = true;
    return;
  }
  if (info.error) {
    status.textContent = `Could not check for updates: ${info.error}`;
    install.hidden = true;
    return;
  }
  if (info.available) {
    status.textContent = `Version ${info.latest} is available. You have ${info.current}.`;
    install.hidden = false;
    return;
  }
  status.textContent = `Up to date (version ${info.current}).`;
  install.hidden = true;
}

/* ------------------------------------------------------------------ *
 * Installing an update.
 *
 * Fetches every file listed in the remote update.json and writes it into the
 * folder the user picks. manifest.json is written LAST, so a half-finished
 * download cannot leave the extension claiming a version it does not have.
 * ------------------------------------------------------------------ */
async function install() {
  const button = $('install');
  const status = $('update-status');

  if (!window.showDirectoryPicker) {
    status.textContent = 'This Chrome cannot write files. Update by re-downloading the folder.';
    return;
  }

  button.disabled = true;
  try {
    const settings = await send({ type: 'getSettings' });
    const cfg = settings.updateSource;
    const base = `https://raw.githubusercontent.com/${cfg.owner}/${cfg.repo}/${cfg.branch}`;

    status.textContent = 'Reading the update…';
    const listRes = await fetch(`${base}/update.json?t=${Date.now()}`);
    if (!listRes.ok) throw new Error(`Could not read update.json (HTTP ${listRes.status})`);
    const remote = await listRes.json();

    status.textContent = 'Choose this extension’s folder…';
    const root = await window.showDirectoryPicker({ mode: 'readwrite' });

    const files = (remote.files || []).filter((f) => f !== 'manifest.json');
    files.push('manifest.json');

    let done = 0;
    for (const file of files) {
      status.textContent = `Updating ${file} (${done + 1} of ${files.length})…`;

      const res = await fetch(`${base}/${file}?t=${Date.now()}`);
      if (!res.ok) throw new Error(`Could not download ${file} (HTTP ${res.status})`);
      const bytes = await res.arrayBuffer();

      const parts = file.split('/');
      const name = parts.pop();
      let dir = root;
      for (const part of parts) {
        dir = await dir.getDirectoryHandle(part, { create: true });
      }

      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      done += 1;
    }

    // Reload ourselves rather than sending the user to chrome://extensions.
    // Chrome keeps running the OLD code until the extension restarts, so
    // stopping at "files written" would leave it looking updated while behaving
    // exactly as before — the worst of both.
    status.textContent = `Updated to ${remote.version}. Reloading…`;
    $('install').hidden = true;
    await chrome.storage.local.remove('updateInfo');
    setTimeout(() => chrome.runtime.reload(), 800);
  } catch (err) {
    status.textContent = `Update failed: ${err?.message || err}`;
  } finally {
    button.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  $('version').textContent = chrome.runtime.getManifest().version;

  const settings = await send({ type: 'getSettings' });
  $('origin').value = settings.profitLensOrigin;
  $('days').value = settings.days;
  $('push').checked = settings.push;
  $('owner').value = settings.updateSource.owner;
  $('repo').value = settings.updateSource.repo;
  $('branch').value = settings.updateSource.branch;

  for (const id of ['origin', 'days', 'push', 'owner', 'repo', 'branch']) {
    $(id).addEventListener('change', save);
  }

  $('check').addEventListener('click', async () => {
    $('update-status').textContent = 'Checking…';
    renderUpdate(await send({ type: 'checkUpdate' }));
  });
  $('install').addEventListener('click', install);

  const { updateInfo } = await chrome.storage.local.get('updateInfo');
  renderUpdate(updateInfo);
});
