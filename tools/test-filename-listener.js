/**
 * Does this extension keep its hands off other extensions' downloads — and
 * keep its own name on its own files?
 *
 * Chrome's onDeterminingFilename is browser-wide: every extension holding the
 * downloads permission is asked about every download, with no notion of which
 * site it came from. Answering — even with a blank suggest() — counts as an
 * opinion, and Chrome hands the final say to the most recently installed
 * extension that answered. A blank answer therefore does not mean "leave it
 * alone": it throws away the filename that downloads.download() asked for and
 * lets Chrome invent one. Our files come from an in-memory data: URL, which
 * carries no name, so Chrome's invention is "download.zip", "download (1).zip"
 * and so on.
 *
 * Run:  node tools/test-filename-listener.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, '..', 'background', 'background.js');
const OWN_ID = 'sitegiant-extension-id';
const TWIN_ID = 'shopee-extension-id';

/**
 * Boots background.js in a sandbox with a stub `chrome`, and hands back the
 * filename listener it registered.
 *
 * `sessionDelayMs` is the whole point of the harness: storage.session.get is
 * an async round trip, so a worker woken by a download event handles that
 * event before hydration settles. Delaying the stub reproduces a cold worker
 * exactly, which no amount of reading the code can prove on its own.
 */
function bootWorker({ session = {}, sessionDelayMs = 0 } = {}) {
  const listeners = {};
  const event = (name) => ({
    addListener: (fn) => {
      (listeners[name] = listeners[name] || []).push(fn);
    },
    removeListener() {},
    hasListener: () => false,
  });

  const sessionStore = JSON.parse(JSON.stringify(session));

  const chrome = {
    runtime: {
      id: OWN_ID,
      lastError: undefined,
      getManifest: () => ({ version: 'test' }),
      getPlatformInfo: () => Promise.resolve({ os: 'win' }),
      getContexts: () => Promise.resolve([]),
      sendMessage: () => Promise.resolve({}),
      openOptionsPage() {},
      reload() {},
      onInstalled: event('installed'),
      onMessage: event('message'),
      onStartup: event('startup'),
    },
    action: {
      setBadgeText: () => Promise.resolve(),
      setBadgeBackgroundColor: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
    },
    downloads: {
      download: () => Promise.resolve(1),
      search: () => Promise.resolve([]),
      show() {},
      showDefaultFolder() {},
      removeFile: () => Promise.resolve(),
      onDeterminingFilename: event('determiningFilename'),
      onCreated: event('downloadCreated'),
      onChanged: event('downloadChanged'),
    },
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
      session: {
        get: (key) =>
          new Promise((resolve) =>
            setTimeout(() => {
              if (typeof key === 'string') resolve({ [key]: sessionStore[key] });
              else resolve({ ...sessionStore });
            }, sessionDelayMs)
          ),
        set: (obj) => {
          Object.assign(sessionStore, obj);
          return Promise.resolve();
        },
        remove: () => Promise.resolve(),
      },
      onChanged: event('storageChanged'),
    },
    scripting: { executeScript: () => Promise.resolve([]) },
    tabs: {
      create: () => Promise.resolve({ id: 1 }),
      get: () => Promise.resolve({ id: 1 }),
      query: () => Promise.resolve([]),
      reload: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      sendMessage: () => Promise.resolve({}),
      update: () => Promise.resolve({}),
      onUpdated: event('tabUpdated'),
      onRemoved: event('tabRemoved'),
    },
    alarms: { create() {}, clear: () => Promise.resolve(), onAlarm: event('alarm') },
    offscreen: { createDocument: () => Promise.resolve(), closeDocument: () => Promise.resolve() },
    permissions: { contains: () => Promise.resolve(true) },
  };

  const sandbox = {
    chrome,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    fetch: () => Promise.reject(new Error('no network in tests')),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    TextEncoder,
    TextDecoder,
    URL,
    Blob: class {},
    structuredClone: (v) => JSON.parse(JSON.stringify(v)),
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SOURCE, 'utf8'), sandbox, { filename: SOURCE });

  const listener = (listeners.determiningFilename || [])[0];
  if (!listener) throw new Error('background.js registered no onDeterminingFilename listener');
  return { listener };
}

/** Fires the listener and reports everything Chrome would observe. */
function ask(listener, item) {
  const calls = [];
  const returned = listener(item, (arg) => calls.push(arg));
  return { returned, calls };
}

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
}

const twinDownload = {
  id: 41,
  url: 'data:application/vnd.ms-excel;base64,AAAA',
  finalUrl: 'data:application/vnd.ms-excel;base64,AAAA',
  filename: 'download.xlsx',
  byExtensionId: TWIN_ID,
  byExtensionName: 'Shopee CPM Report Downloader',
};

const ourPath = 'SiteGiant/2026-08-18/Orders_18-08-2026-1787020565.zip';
const ourDownload = {
  id: 42,
  url: 'data:application/zip;base64,UEsDBAoAAAAAAA==',
  finalUrl: 'data:application/zip;base64,UEsDBAoAAAAAAA==',
  filename: 'download.zip',
  byExtensionId: OWN_ID,
  byExtensionName: 'SiteGiant Downloader',
};

async function main() {
  console.log('onDeterminingFilename — hands off others, hands on our own\n');

  // 1. Cold worker, twin's download.
  {
    const { listener } = bootWorker({ sessionDelayMs: 250 });
    const { returned, calls } = ask(listener, twinDownload);
    await settle(600);
    check(
      'cold worker says nothing about the twin\'s download',
      calls.length === 0 && returned !== true,
      calls.length ? `answered ${JSON.stringify(calls[0])}` : ''
    );
  }

  // 2. A download started by an ordinary web page, nothing to do with us.
  {
    const { listener } = bootWorker({ sessionDelayMs: 0 });
    await settle(20);
    const { returned, calls } = ask(listener, {
      id: 43,
      url: 'https://example.com/invoice.pdf',
      finalUrl: 'https://example.com/invoice.pdf',
      filename: 'invoice.pdf',
      byExtensionId: undefined,
    });
    await settle(100);
    check(
      'says nothing about a download the seller started themselves',
      calls.length === 0 && returned !== true,
      calls.length ? `answered ${JSON.stringify(calls[0])}` : ''
    );
  }

  // 3. THE SELF-INFLICTED ONE. Our own download, but the path is missing —
  //    a worker restarted mid-run with nothing left in session storage. A bare
  //    suggest() here throws away the filename we already gave
  //    downloads.download(), and the file lands as "download.zip" with nobody
  //    else involved at all.
  {
    const { listener } = bootWorker({ sessionDelayMs: 0 });
    await settle(20);
    const { calls } = ask(listener, ourDownload);
    await settle(100);
    const wiped = calls.length > 0 && !calls[0];
    check(
      'never wipes our own name when the path is missing',
      !wiped,
      wiped ? 'answered blank, which discards the name passed to downloads.download()' : ''
    );
  }

  // 4. Same, on a cold worker with nothing to restore.
  {
    const { listener } = bootWorker({ sessionDelayMs: 250 });
    const { calls } = ask(listener, ourDownload);
    await settle(600);
    const wiped = calls.length > 0 && !calls[0];
    check(
      'cold worker never wipes our own name either',
      !wiped,
      wiped ? 'answered blank after hydration found nothing to restore' : ''
    );
  }

  // 5. The everyday case: our own download with the path in session storage.
  {
    const { listener } = bootWorker({
      sessionDelayMs: 0,
      session: { runtimeState: { running: true, folder: '2026-08-18', pendingPath: ourPath } },
    });
    await settle(20);
    const { calls } = ask(listener, ourDownload);
    await settle(100);
    const named = calls[0] && calls[0].filename;
    check(
      'our own report gets its folder and name',
      named === ourPath,
      named ? `got ${named}` : 'no suggestion made — the file would land loose in Downloads'
    );
  }

  // 6. Cold worker, even with the path sitting in storage: abstain, do not
  //    return true.
  //
  //    Waiting for hydration and answering late looks like the thorough
  //    option, and it is the one that produced this bug. Returning true
  //    obliges us to call suggest() or stall the download for ever, so its
  //    failure path is forced to answer blank — and blank means "use Chrome's
  //    guess from the URL", which for a data: URL is download.zip. Abstaining
  //    costs nothing: the path went to downloads.download() already and stands
  //    unless something overrides it.
  {
    const { listener } = bootWorker({
      sessionDelayMs: 250,
      session: { runtimeState: { running: true, folder: '2026-08-18', pendingPath: ourPath } },
    });
    const { returned, calls } = ask(listener, ourDownload);
    await settle(600);
    check(
      'cold worker abstains rather than gamble on a late answer',
      calls.length === 0 && returned !== true,
      returned === true
        ? 'returned true, which forces an answer and stalls the download if none comes'
        : `answered ${JSON.stringify(calls[0])}`
    );
  }

  const failed = results.filter((r) => !r.passed).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
