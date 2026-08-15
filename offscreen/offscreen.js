/**
 * Writes a report straight into the folder the seller chose.
 *
 * WHY THIS FILE EXISTS AT ALL.
 *
 * `chrome.downloads.download({filename})` only REQUESTS a name. Any other
 * installed extension holding the "downloads" permission can override it from
 * onDeterminingFilename, and Chrome settles the tie by install recency:
 *
 *   "the last extension installed whose listener passes a suggestion object to
 *    suggest wins"
 *
 * So the winner changes every time some unrelated download manager auto-updates
 * itself in the background — which is exactly why files kept coming back as
 * "download (2).zip" weeks after each fix, on machines with a video downloader
 * installed. Passing `filename` to download() up front does not settle it
 * either; SiteGiant always did, and still lost on 15 Aug 2026.
 *
 * There is no way to win that contest reliably, so this stops entering it. A
 * file written through a FileSystemDirectoryHandle never touches Chrome's
 * download naming, and no other extension is consulted.
 *
 * The File System Access API needs a document, and an MV3 service worker is not
 * one — hence an offscreen document rather than doing this in background.js.
 */

const DB_NAME = 'sitegiant-downloader';
const STORE = 'handles';
/** Where reports go. Deliberately NOT the key the self-updater uses. */
const OUTPUT_KEY = 'outputFolder';

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Walks (and creates) a folder path under the chosen root.
 *
 * Empty segments are dropped rather than passed through: getDirectoryHandle('')
 * throws, and a stray double slash in a built path is an easy mistake to make.
 */
async function folderFor(root, segments) {
  let dir = root;
  for (const part of segments.filter(Boolean)) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir;
}

function bytesFromBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Reports why it could not write, rather than just failing.
 *
 * The caller falls back to chrome.downloads on ANY failure, so the run still
 * produces a file — but 'no-folder' and 'permission' are worth telling the
 * seller apart, because both are fixed in Options and neither is a bug.
 */
async function write({ segments, filename, base64 }) {
  const root = await idbGet(OUTPUT_KEY);
  if (!root) return { ok: false, reason: 'no-folder' };

  // requestPermission() needs a user gesture and there is none here, so this
  // can only ever check. Options re-grants it; see refreshOutputFolder().
  const granted = await root.queryPermission({ mode: 'readwrite' });
  if (granted !== 'granted') return { ok: false, reason: 'permission' };

  const dir = await folderFor(root, segments);
  const handle = await dir.getFileHandle(filename, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytesFromBase64(base64));
  } finally {
    // Closing is what commits the file. Skipping it on a failed write would
    // leave a zero-byte file that looks like a successful save.
    await writable.close();
  }

  return { ok: true, path: `${segments.filter(Boolean).join('/')}/${filename}` };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen-writer') return undefined;

  write(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, reason: 'error', error: err?.message || String(err) }));
  return true;
});
