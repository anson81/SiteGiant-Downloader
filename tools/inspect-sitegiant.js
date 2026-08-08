/**
 * Paste into DevTools on a SiteGiant page to dump every selector this
 * extension depends on. Run it when something breaks — the answer is almost
 * always that one of these went missing or changed its value.
 *
 * Useful pages:
 *   https://sitegiant.co/orders            (the export menu)
 *   https://sitegiant.co/orders/export     (the orders queue)
 *   https://sitegiant.co/items/batch-edit  (stock & cost)
 */
(() => {
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const CDN = 'cdn1.sgliteasset.com';

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return (r.width > 0 || r.height > 0) && getComputedStyle(el).display !== 'none';
  };

  console.group(`SiteGiant inspector — ${location.pathname}`);

  /* --- radios: the most stable things on the whole site ------------------ */
  const radios = Array.from(document.querySelectorAll('input[type=radio]'));
  console.group(`Radios (${radios.length})`);
  console.table(
    radios.map((r) => ({
      value: r.value,
      checked: r.checked,
      visible: visible(r),
      label: squash(r.closest('label')?.textContent).slice(0, 40),
    }))
  );
  console.groupEnd();

  /* --- the export dialog ------------------------------------------------- */
  const modal = document.querySelector('.ant-modal-root, .ant-modal-wrap');
  console.group('Export dialog');
  if (!modal) {
    console.log('Not open. On /orders: click the 3-dot button, then "Export Orders".');
  } else {
    console.log('withProduct radio:', modal.querySelector('input[value="withProduct"]'));
    console.log('dateRange radio:', modal.querySelector('input[value="dateRange"]'));
    console.log('Start Date:', modal.querySelector('input[placeholder="Start Date" i]'));
    console.log('End Date:', modal.querySelector('input[placeholder="End Date" i]'));
    console.log(
      'buttons:',
      Array.from(modal.querySelectorAll('button')).map((b) => squash(b.textContent))
    );
  }
  console.groupEnd();

  /* --- buttons ----------------------------------------------------------- */
  console.group('Visible buttons');
  console.log(
    Array.from(document.querySelectorAll('button'))
      .filter(visible)
      .map((b) => squash(b.textContent))
      .filter(Boolean)
  );
  console.groupEnd();

  /* --- download links ---------------------------------------------------- */
  const links = Array.from(document.querySelectorAll('a[href]'))
    .map((a) => a.href)
    .filter((h) => h.includes(CDN));

  console.group(`CDN download links (${links.length})`);
  if (links.length === 0) {
    console.log('None. Either nothing has been exported, or every row is still Pending.');
  }
  console.table(
    links.map((url) => ({ file: decodeURIComponent(url.split('/').pop()), url }))
  );
  console.groupEnd();

  /* --- pending rows ------------------------------------------------------ */
  const pending = Array.from(document.querySelectorAll('*')).filter(
    (el) =>
      visible(el) &&
      squash(el.textContent) === 'Pending' &&
      !Array.from(el.children).some((c) => squash(c.textContent) === 'Pending')
  );
  console.log(`Pending rows: ${pending.length}`);

  /* --- the 3-dot menu ---------------------------------------------------- */
  console.log('3-dot trigger (div.ellipsis-btn):', document.querySelector('div.ellipsis-btn'));

  console.info(
    'Reminder: the Bulk Tools menu on /items opens on HOVER and ignores clicks. ' +
      'The extension sidesteps it by navigating straight to /items/batch-edit.'
  );
  console.groupEnd();
})();
