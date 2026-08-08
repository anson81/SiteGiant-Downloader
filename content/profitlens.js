/**
 * ProfitLens content script — ISOLATED world.
 *
 * Why this file exists at all:
 *
 * ProfitLens issues its refresh token as an httpOnly, sameSite:'lax' cookie and
 * pins CORS to a single origin. An extension calling the API cross-origin
 * therefore fails twice over — no cookie is attached, and the preflight is
 * refused. Running the same calls from a content script ON profitlens.my makes
 * them same-origin, so both problems disappear.
 *
 * The consequence worth keeping: the extension stores no ProfitLens credential
 * of any kind. It borrows the session Anson already has, exactly the way it
 * borrows the SiteGiant one, and holds nothing once the tab closes.
 *
 * The frontend calls '/api/...' relatively (vite proxies it in dev), so these
 * paths are correct both on profitlens.my and on localhost:3000.
 */
(() => {
  'use strict';

  if (window.__sgPlLoaded) return;
  window.__sgPlLoaded = true;

  /** base64 -> Blob, without a data: URL round trip. */
  function toBlob(base64, mime) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'application/zip' });
  }

  /**
   * Trades the httpOnly refresh cookie for a short-lived access token.
   * Same-origin, so the cookie rides along on its own.
   */
  async function getAccessToken() {
    let res;
    try {
      res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      throw new Error(`Could not reach ProfitLens: ${err?.message || err}`);
    }

    if (res.status === 401) {
      throw new Error('NOT_LOGGED_IN');
    }
    if (!res.ok) {
      throw new Error(`ProfitLens refresh failed (HTTP ${res.status})`);
    }

    const json = await res.json().catch(() => null);
    const token = json?.data?.accessToken;
    if (!token) throw new Error('ProfitLens did not return an access token');
    return token;
  }

  /** Pulls the useful message out of ProfitLens's error envelope. */
  async function readError(res) {
    const json = await res.json().catch(() => null);
    return json?.error?.message || json?.message || `HTTP ${res.status}`;
  }

  /**
   * Uploads one zip. `endpoint` is /api/import/orders or /api/import/products;
   * both take a single multipart field named `file` and both answer with
   * created / updated / unchanged counts.
   */
  async function push({ endpoint, filename, base64 }) {
    const token = await getAccessToken();

    const form = new FormData();
    form.append('file', toBlob(base64), filename);

    const res = await fetch(endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { Authorization: `Bearer ${token}` },
      body: form, // no Content-Type: the browser must set the multipart boundary
    });

    if (!res.ok) {
      throw new Error(await readError(res));
    }

    const json = await res.json().catch(() => null);
    const data = json?.data || {};

    return {
      ok: true,
      filename,
      created: data.created ?? 0,
      updated: data.updated ?? 0,
      unchanged: data.unchanged ?? 0,
      // Non-zero means some orders predate any configured fee rate and were
      // costed with zero fees, so their profit reads high. Surfaced rather
      // than swallowed, because it silently overstates money.
      feeRateMissing: data.feeRateMissing ?? 0,
      skipped: data.skipped ?? 0,
      errorCount: data.errorCount ?? 0,
    };
  }

  async function handle(msg) {
    switch (msg.type) {
      case 'ping':
        return { ok: true, url: location.href };
      case 'push':
        return push(msg);
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
})();
