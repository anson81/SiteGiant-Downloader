/**
 * The Customer Return and Refund export - the third report.
 *
 * Mapped live on SiteGiant on 2 Nov 2026 (see README, "What was mapped"). It
 * differs from the other two in ways that each break something quietly:
 *
 *   - the file is an .xlsx, not a .zip, and every age check reads the epoch off
 *     a name ending `.zip` - so a returns file would look infinitely old, and
 *     "built after I pressed the button" could never be proven;
 *   - its queue lives at /marketplaces/marketplace-order-return/export and its
 *     CDN folder is `marketplace_order_return`, so the Orders and Stock & Cost
 *     readers must not pick it up, nor it theirs;
 *   - the export dialog must be set to "Order return info with products"
 *     (value `productInfo`), or the file has no iSKU and ProfitLens cannot cost it;
 *   - a page that lacks the control must fail with a sentence, not hang.
 *
 *     node tools/test-returns-export.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const CDN = 'https://cdn1.sgliteasset.com/qfmoffic';

// Names copied from the live queue, 2 Nov 2026. Newest first.
const LINKS = [
  `${CDN}/marketplace_order_return/Customer_Return_Refund_3359_31-10-2026-1793430367.xlsx`,
  `${CDN}/marketplace_order_return/Customer_Return_Refund_30-10-2026-1793300000.xlsx`,
  `${CDN}/orders/Orders_3359_21-10-2026-1792539978.zip`,
  `${CDN}/items/batch_edit_3359_basic_info_all_21-10-2026-1792540000.zip`,
];

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      ${detail}`}`);
  if (!ok) failures += 1;
}

/* ---------------- content script, against a stub page ---------------- */

function bootContent({ links = LINKS, fastClock = false } = {}) {
  let listener = null;
  const document = {
    body: { innerText: '' },
    querySelector: () => null,
    querySelectorAll(selector) {
      if (selector === 'a[href]') return links.map((href) => ({ href }));
      return [];
    },
  };
  const window = { getComputedStyle: () => ({}), __sgDlWantsTestHook: true };
  const context = {
    window,
    document,
    location: { href: 'https://sitegiant.co/marketplaces/marketplace-order-return' },
    URL,
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    chrome: {
      runtime: {
        sendMessage: () => Promise.resolve(),
        onMessage: { addListener: (fn) => (listener = fn) },
      },
    },
  };
  if (fastClock) {
    // Each look at the clock costs 250 ms of pretend time, so a 15 s wait ends
    // in moments instead of holding the test for 15 s.
    // Sleeps advance it by their full length, so elapsed pretend time is real.
    let t = Date.now();
    context.Date = class extends Date {
      static now() {
        t += 250;
        return t;
      }
    };
    context.setTimeout = (fn, ms) => {
      t += ms || 0;
      return setTimeout(fn, 0);
    };
    context.__clock = () => t;
  }
  vm.createContext(context);
  const file = path.join(ROOT, 'content', 'sitegiant.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const send = (msg) => new Promise((resolve) => listener(msg, {}, resolve));
  send.context = context;
  return send;
}

/** A dialog stand-in whose visibility the test controls. */
function fakeModal() {
  const m = { open: true };
  m.getBoundingClientRect = () =>
    m.open ? { width: 100, height: 100, left: 0, top: 0 } : { width: 0, height: 0, left: 0, top: 0 };
  return m;
}

/* ---------------- background worker, against a permissive stub ---------------- */

function bootWorker() {
  const stub = (own = {}) =>
    new Proxy(function () {}, {
      get: (_t, k) => (k === 'then' ? undefined : k in own ? own[k] : stub()),
      apply: () => Promise.resolve({}),
    });
  const sandbox = {
    chrome: stub({ runtime: stub({ id: 'test-id' }) }),
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
    importScripts(...paths) {
      for (const rel of paths) {
        const file = path.resolve(ROOT, 'background', rel);
        vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
      }
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const file = path.join(ROOT, 'background', 'background.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return (expression) => vm.runInContext(expression, sandbox);
}

(async () => {
  // --- the report is registered, alongside the other two -------------------
  const evaluate = bootWorker();
  const reports = JSON.parse(evaluate('JSON.stringify(REPORTS)'));
  const returns = reports.find((r) => r.id === 'returns');
  check('REPORTS has a returns entry', Boolean(returns), JSON.stringify(reports));
  check(
    'returns pushes to /api/import/sitegiant-returns and marks Customer_Return_Refund_',
    returns &&
      returns.endpoint === '/api/import/sitegiant-returns' &&
      returns.marker === 'Customer_Return_Refund_' &&
      returns.label === 'Returns',
    JSON.stringify(returns)
  );
  check(
    'Orders and Stock & Cost are still there',
    ['orders', 'stockcost'].every((id) => reports.some((r) => r.id === id)),
    JSON.stringify(reports.map((r) => r.id))
  );

  // --- an .xlsx name carries its age too ----------------------------------
  const built = evaluate('exportTimeMs("Customer_Return_Refund_3359_31-10-2026-1793430367.xlsx")');
  check('exportTimeMs reads the epoch off an .xlsx name', built === 1793430367000, `got ${built}`);
  check(
    'exportTimeMs still reads .zip names',
    evaluate('exportTimeMs("Orders_3359_21-10-2026-1792539978.zip")') === 1792539978000,
    'zip name no longer parsed'
  );
  check(
    'exportTimeMs gives 0 for a name with no stamp',
    evaluate('exportTimeMs("report.xlsx")') === 0,
    'expected 0'
  );

  // --- the queue reader ---------------------------------------------------
  const send = bootContent();
  const queue = await send({ type: 'returnsQueue' });
  const names = (queue.rows || []).map((r) => r.name);
  check(
    'returnsQueue sees both the new name (with shop id) and the old one',
    names.includes('Customer_Return_Refund_3359_31-10-2026-1793430367.xlsx') &&
      names.includes('Customer_Return_Refund_30-10-2026-1793300000.xlsx'),
    `got ${JSON.stringify(names)}`
  );
  check(
    'returnsQueue takes nothing from the Orders or Batch Edit lists',
    names.length === 2 && names.every((n) => n.startsWith('Customer_Return_Refund_')),
    `got ${JSON.stringify(names)}`
  );
  const orders = await send({ type: 'ordersQueue' });
  const batch = await send({ type: 'batchQueue' });
  check(
    'ordersQueue and batchQueue take nothing from the returns list',
    (orders.rows || []).length === 1 &&
      orders.rows.every((r) => r.name.startsWith('Orders_')) &&
      (batch.rows || []).length === 1 &&
      batch.rows.every((r) => /basic_info_all_/.test(r.name)),
    `orders ${JSON.stringify(orders.rows)} batch ${JSON.stringify(batch.rows)}`
  );

  // --- a page without the control fails with a sentence --------------------
  const lost = bootContent({ links: [], fastClock: true });
  const outcome = await Promise.race([
    lost({
      type: 'returnsSubmit',
      startISO: '2026-10-26T00:00:00+08:00',
      endISO: '2026-11-01T00:00:00+08:00',
    }),
    new Promise((r) => setTimeout(() => r({ hung: true }), 5000)),
  ]);
  check('returnsSubmit on a page without the control does not hang', !outcome.hung, 'timed out');
  check(
    'returnsSubmit says what is missing and where to look',
    typeof outcome.error === 'string' &&
      /Order Return/i.test(outcome.error) &&
      /menu/i.test(outcome.error),
    `got ${JSON.stringify(outcome)}`
  );

  // --- after Export, wait for the dialog to close before leaving the page ---
  {
    const page = bootContent({ links: [], fastClock: true });
    const ctx = page.context;
    const { settleAfterExport } = ctx.window.__sgDlTest;
    const URL0 = 'https://sitegiant.co/marketplaces/marketplace-order-return';

    // Never closes, never navigates: gives up after ~10 s and says so.
    let modal = fakeModal();
    let t0 = ctx.__clock();
    let how = await settleAfterExport(modal, URL0);
    let spent = ctx.__clock() - t0;
    check(
      'settle: neither closing nor navigating -> null after about 10 s, no hang',
      how === null && spent >= 10000 && spent < 13000,
      `how ${how}, ${spent} ms`
    );

    // Closes after ~2 s: reports closed, and waits at least 1.5 s more.
    modal = fakeModal();
    const closeAt = ctx.__clock() + 2000;
    const origNow = ctx.Date.now;
    let closedAt = null;
    ctx.Date.now = () => {
      const n = origNow();
      if (modal.open && n >= closeAt) {
        modal.open = false;
        closedAt = n;
      }
      return n;
    };
    how = await settleAfterExport(modal, URL0);
    ctx.Date.now = origNow;
    check(
      'settle: dialog closing -> "closed", then at least 1.5 s more',
      how === 'closed' && closedAt !== null && ctx.__clock() - closedAt >= 1500,
      `how ${how}, after close ${closedAt === null ? 'never closed' : ctx.__clock() - closedAt} ms`
    );

    // The address changes: reported as navigated.
    modal = fakeModal();
    ctx.location.href = `${URL0}/export`;
    how = await settleAfterExport(modal, URL0);
    check('settle: URL change -> "navigated"', how === 'navigated', `how ${how}`);
  }

  // --- the content script asks for productInfo, in source ------------------
  const src = fs.readFileSync(path.join(ROOT, 'content', 'sitegiant.js'), 'utf8');
  check(
    'the returns dialog is set to "Order return info with products" (productInfo)',
    /chooseRadio\(modal, 'productInfo'/.test(src),
    "chooseRadio(modal, 'productInfo') not found in content/sitegiant.js"
  );

  if (failures) {
    console.log(`\n${failures} failed`);
    process.exit(1);
  }
  console.log('\nAll passed');
})();
