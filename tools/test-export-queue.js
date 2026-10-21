/**
 * Boots content/sitegiant.js against a stub page and asks it to read both
 * export lists, the way the background worker does.
 *
 * Written after 2026-10-21, when SiteGiant started putting the shop id into
 * its filenames: `batch_edit_3359_basic_info_all_...zip`. The Stock & Cost
 * reader looked for `batch_edit_basic_info_all_`, never saw the new file, and
 * pressed Refresh until the run timed out — with the export sitting finished
 * on the page the whole time. Orders went `Orders_3359_...` the same day and
 * only survived because its pattern happened to stop before the id.
 *
 *     node tools/test-export-queue.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CDN = 'https://cdn1.sgliteasset.com/qfmoffic';

// Real names, copied off the live pages on 2026-10-21. Newest first.
const LINKS = [
  `${CDN}/items/batch_edit_3359_basic_info_all_21-10-2026-1792540000.zip`,
  `${CDN}/items/batch_edit_basic_info_all_19-10-2026-1792399094.zip`,
  `${CDN}/orders/Orders_3359_21-10-2026-1792539978.zip`,
  `${CDN}/orders/Orders_16-10-2026-1792154956.zip`,
  // Other Batch Edit info types share the list and must never be taken.
  `${CDN}/items/batch_edit_3359_inventory_all_21-10-2026-1792540100.zip`,
  `${CDN}/items/batch_edit_basic_info_category_19-10-2026-1792399000.zip`,
];

function boot() {
  let listener = null;
  const document = {
    querySelectorAll(selector) {
      if (selector === 'a[href]') return LINKS.map((href) => ({ href }));
      return [];
    },
  };
  const window = {};
  const context = {
    window,
    document,
    location: { href: 'https://sitegiant.co/items/batch-edit' },
    URL,
    setTimeout,
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
  context.window.getComputedStyle = () => ({});
  vm.createContext(context);
  const file = path.join(__dirname, '..', 'content', 'sitegiant.js');
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });

  return (msg) =>
    new Promise((resolve) => {
      listener(msg, {}, resolve);
    });
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n      ${detail}`}`);
  if (!ok) failures += 1;
}

(async () => {
  const send = boot();

  const batch = await send({ type: 'batchQueue' });
  const batchNames = (batch.rows || []).map((r) => r.name);
  check(
    'Stock & Cost sees the file with the shop id in its name',
    batchNames.includes('batch_edit_3359_basic_info_all_21-10-2026-1792540000.zip'),
    `got ${JSON.stringify(batchNames)}`
  );
  check(
    'Stock & Cost still sees the older name without one',
    batchNames.includes('batch_edit_basic_info_all_19-10-2026-1792399094.zip'),
    `got ${JSON.stringify(batchNames)}`
  );
  check(
    'Stock & Cost ignores other Batch Edit info types and filters',
    batchNames.every((n) => /basic_info_all_/.test(n)),
    `got ${JSON.stringify(batchNames)}`
  );

  const orders = await send({ type: 'ordersQueue' });
  const orderNames = (orders.rows || []).map((r) => r.name);
  check(
    'Orders sees both the new and the old name',
    orderNames.includes('Orders_3359_21-10-2026-1792539978.zip') &&
      orderNames.includes('Orders_16-10-2026-1792154956.zip'),
    `got ${JSON.stringify(orderNames)}`
  );
  check(
    'Orders takes nothing from the Batch Edit list',
    orderNames.every((n) => n.startsWith('Orders_')),
    `got ${JSON.stringify(orderNames)}`
  );

  if (failures) {
    console.log(`\n${failures} failed`);
    process.exit(1);
  }
  console.log('\nAll passed');
})();
