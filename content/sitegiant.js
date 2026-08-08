/**
 * SiteGiant content script — ISOLATED world.
 *
 * Everything that knows about SiteGiant's DOM lives here. This script never
 * touches files, downloads, or disk: it drives pages and reports back URLs.
 * The background worker does the rest.
 *
 * Each command is a discrete step that does NOT survive a navigation, because
 * two of SiteGiant's actions navigate the page out from under us:
 *   - submitting the orders export modal navigates to /orders/export
 *   - Bulk Tools -> Batch Edit navigates to /items/batch-edit
 * So the background worker sequences the steps and waits for loads between
 * them, rather than this script trying to drive a whole run.
 */
(() => {
  'use strict';

  if (window.__sgDlLoaded) return;
  window.__sgDlLoaded = true;

  /* ------------------------------------------------------------------ *
   * Service-worker heartbeat.
   *
   * MV3 workers die after ~30s idle. Every message resets that timer, so a
   * slow export poll would otherwise kill the worker mid-run. Learned the
   * hard way on the Shopee twin — do not remove.
   * ------------------------------------------------------------------ */
  let heartbeat = null;

  function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => {
      try {
        chrome.runtime.sendMessage({ type: 'ping' }).catch(() => {});
      } catch (_) {
        stopHeartbeat();
      }
    }, 10000);
  }

  function stopHeartbeat() {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
  }

  /* ------------------------------------------------------------------ *
   * Small DOM helpers.
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }

  /** Polls fn until it returns something truthy, or gives up. */
  async function waitFor(fn, { timeout = 15000, interval = 200, label = 'element' } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
      let result;
      try {
        result = fn();
      } catch (_) {
        result = null;
      }
      if (result) return result;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
      await sleep(interval);
    }
  }

  function mouseEvent(type, el) {
    const rect = el.getBoundingClientRect();
    return new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    });
  }

  /**
   * A full press sequence. React ignores a bare .click() in several places, so
   * the pointer/mouse events lead — but the activation itself happens EXACTLY
   * ONCE.
   *
   * The first version dispatched a synthetic 'click' and then also called
   * el.click(), which fires the handler twice. On calendar arrows that moved
   * two months per press; on a submit button it would ask SiteGiant for two
   * exports.
   */
  function fullClick(el) {
    if (!el) return false;
    el.dispatchEvent(mouseEvent('pointerover', el));
    el.dispatchEvent(mouseEvent('mouseover', el));
    el.dispatchEvent(mouseEvent('mousedown', el));
    el.dispatchEvent(mouseEvent('mouseup', el));
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(mouseEvent('click', el));
    return true;
  }

  /**
   * Hover. The Bulk Tools menu on /items opens on hover and IGNORES clicks
   * entirely — confirmed on the live page 2026-08-06.
   */
  function hover(el) {
    if (!el) return false;
    el.dispatchEvent(mouseEvent('pointerover', el));
    el.dispatchEvent(mouseEvent('mouseover', el));
    el.dispatchEvent(mouseEvent('mouseenter', el));
    el.dispatchEvent(mouseEvent('mousemove', el));
    return true;
  }

  function squash(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Finds a clickable element whose visible text matches.
   *
   * `p` is in the list because SiteGiant's 3-dot menu items are paragraphs:
   * <p class="un-dots-option"><i/><span>Export </span><b><span>Orders</span></b></p>
   * Leaving it out meant the matcher never looked at the only element that
   * could match, and Orders failed while Stock & Cost sailed through.
   */
  function findByText(re, selector = 'a,button,li,div,span,p') {
    const nodes = Array.from(document.querySelectorAll(selector));
    return nodes.find((el) => {
      if (!isVisible(el)) return false;
      // Only match the element that directly holds the text, not every ancestor.
      const own = squash(el.textContent);
      if (!re.test(own)) return false;
      return !Array.from(el.children).some((child) => re.test(squash(child.textContent)));
    });
  }

  /* ------------------------------------------------------------------ *
   * Login.
   * ------------------------------------------------------------------ */
  function checkLogin() {
    const url = location.href;
    if (/\/(login|signin)\b/i.test(url)) return { ok: false };
    const text = squash(document.body?.innerText).toLowerCase();
    if (/log ?in to (your )?account|sign in to continue/.test(text)) return { ok: false };
    return { ok: true };
  }

  /* ------------------------------------------------------------------ *
   * Export queues.
   *
   * Both queues are read the same way: collect the CDN links. A row that is
   * still Pending has NO link and an EMPTY File Name cell, so the presence of
   * a link is the honest "ready" signal — never "is the word Download on the
   * page", which is true the moment the table renders.
   *
   * Rows are newest-first, confirmed on the live page.
   * ------------------------------------------------------------------ */
  const CDN = 'cdn1.sgliteasset.com';

  function basename(url) {
    try {
      return decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    } catch (_) {
      return '';
    }
  }

  function collectLinks(marker) {
    return Array.from(document.querySelectorAll('a[href]'))
      .map((a) => a.href)
      .filter((href) => href.includes(CDN) && href.includes(marker))
      .map((href) => ({ url: href, name: basename(href) }));
  }

  /**
   * Reads an export list, waiting for it to actually render first.
   *
   * The table is drawn by JavaScript after the page load event, so reading
   * immediately can see an empty table and wrongly conclude that nothing has
   * ever been exported — which then creates a needless export. An empty list is
   * still a legitimate answer, so this gives up quickly rather than hanging.
   */
  async function readQueue(marker) {
    try {
      await waitFor(() => collectLinks(marker).length > 0, {
        timeout: 5000,
        interval: 200,
        label: 'the export list',
      });
    } catch (_) {
      /* genuinely empty */
    }
    return collectLinks(marker);
  }

  const ordersQueue = () => readQueue('/orders/Orders_');
  const batchQueue = () => readQueue('/items/batch_edit_basic_info_all_');

  /**
   * Pending rows carry a badge. Used only to tell "still building" apart from
   * "nothing was ever requested", which changes the error message.
   */
  function pendingCount() {
    return Array.from(document.querySelectorAll('*')).filter(
      (el) =>
        isVisible(el) &&
        squash(el.textContent) === 'Pending' &&
        !Array.from(el.children).some((c) => squash(c.textContent) === 'Pending')
    ).length;
  }

  /* ------------------------------------------------------------------ *
   * Orders export modal.
   * ------------------------------------------------------------------ */

  /** Opens the 3-dot menu. Click first, hover as a fallback. */
  async function openOrdersMenu() {
    const trigger = await waitFor(
      () =>
        document.querySelector('div.ellipsis-btn') ||
        findByText(/^•{3}$|^\.{3}$/, 'div,button,span'),
      { label: 'the orders 3-dot menu' }
    );

    fullClick(trigger);

    // The menu items carry their own class, which is far more stable than
    // text — the visible label is split across <span> and <b><span>, and
    // "Exported" sits in the same menu, so the text match must be exact.
    const find = () =>
      Array.from(document.querySelectorAll('p.un-dots-option')).find(
        (el) => isVisible(el) && /^Export Orders$/i.test(squash(el.textContent))
      ) || findByText(/^Export Orders$/i);

    let item = null;
    try {
      item = await waitFor(find, {
        timeout: 2500,
        label: 'the Export Orders menu item',
      });
    } catch (_) {
      // Some SiteGiant menus open on hover only (Bulk Tools on /items does).
      hover(trigger);
      item = await waitFor(find, {
        timeout: 5000,
        label: 'the Export Orders menu item',
      });
    }
    return item;
  }

  /** Local YYYY-MM-DD, which is exactly what the calendar cells carry. */
  function isoDate(date) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${mm}-${dd}`;
  }

  function openPicker() {
    return document.querySelector('.ant-picker-dropdown:not(.ant-picker-dropdown-hidden)');
  }

  /** Whole months between two YYYY-MM-DD strings, b minus a. */
  function monthsBetween(isoA, isoB) {
    const [ay, am] = isoA.split('-').map(Number);
    const [by, bm] = isoB.split('-').map(Number);
    return (by - ay) * 12 + (bm - am);
  }

  /**
   * The YYYY-MM actually on display in the left panel.
   *
   * `ant-picker-cell-in-view` marks the cells belonging to the shown month,
   * which is the only honest source: the grid's first cell is a trailing day of
   * the month before.
   */
  function displayedMonth(panel) {
    const cell = panel.querySelector('td.ant-picker-cell-in-view');
    return cell && cell.title ? cell.title.slice(0, 7) : null;
  }

  /**
   * The cell for a date, once the calendar has been walked to it. Null when the
   * date is outside what the picker will currently allow.
   */
  async function reachCell(iso, input) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const panel = await ensurePickerOpen(input);
      const cell = panel.querySelector(`td.ant-picker-cell[title="${iso}"]`);
      if (cell) return cell;

      const shownMonth = displayedMonth(panel);
      if (!shownMonth) return null;
      if (`${shownMonth}-01` === `${iso.slice(0, 7)}-01`) return null;

      const diff = monthsBetween(`${shownMonth}-01`, iso);
      const back = diff < 0;
      const magnitude = Math.abs(diff);
      const button = panel.querySelector(
        magnitude >= 12
          ? back
            ? '.ant-picker-header-super-prev-btn'
            : '.ant-picker-header-super-next-btn'
          : back
            ? '.ant-picker-header-prev-btn'
            : '.ant-picker-header-next-btn'
      );
      if (!button) return null;
      fullClick(button);
      await sleep(220);
    }
    return null;
  }

  /** The earliest date the picker is currently willing to accept. */
  function earliestOffered(panel) {
    const open = Array.from(panel.querySelectorAll('td.ant-picker-cell-in-view'))
      .filter((c) => !c.classList.contains('ant-picker-cell-disabled'))
      .map((c) => c.title)
      .filter(Boolean)
      .sort();
    return open[0] ?? null;
  }

  async function ensurePickerOpen(input) {
    const open = openPicker();
    if (open) return open;
    fullClick(input);
    return waitFor(openPicker, { timeout: 5000, label: 'the date picker' });
  }

  /**
   * Picks a day out of the calendar.
   *
   * Typing is not an option: both date inputs are `readOnly`, so no amount of
   * value-setting or key events will move them. The calendar is the only way
   * in — and its cells carry `title="YYYY-MM-DD"`, which is a far better
   * target than positions or day numbers.
   *
   * Two things learned trying to reach a date a year back:
   *
   *  - **Jump by year when the target is far away.** The header has four
   *    arrows: « ‹ … › ». Walking a year one month at a time is twelve presses
   *    and twelve chances for the picker to close. Note that a comma selector
   *    would NOT do this: `querySelector('.prev, .super-prev')` returns
   *    whichever comes first in the DOM, which is the year arrow — so asking
   *    for months would silently jump years.
   *  - **Reopen rather than give up.** The picker sometimes closes mid-walk.
   *    That is recoverable: clicking the field opens it again on the month it
   *    was showing.
   */
  async function pickDateCell(iso, input) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const panel = await ensurePickerOpen(input);

      const cell = panel.querySelector(`td.ant-picker-cell[title="${iso}"]`);
      if (cell) {
        if (cell.classList.contains('ant-picker-cell-disabled')) {
          // Reaching an out-of-window date is pickRange's job, so being refused
          // here means the ratchet did not get far enough — not that the date is
          // unavailable. Say that, rather than blaming a retention limit that
          // does not exist.
          throw new Error(`SiteGiant would not accept ${iso} as a date`);
        }
        fullClick(cell.querySelector('.ant-picker-cell-inner') || cell);
        return true;
      }

      // Measure from the month actually on display, not from the first cell in
      // the grid. The grid starts with trailing days of the PREVIOUS month — on
      // an August panel the first cell is 27 July — so measuring from it puts
      // every distance one month short. That is what turned a 12-month gap into
      // 11, missed the year jump, and left it crawling a month at a time.
      const shown = displayedMonth(panel);
      if (!shown) throw new Error('The date picker rendered no days');

      const diff = monthsBetween(`${shown}-01`, iso);
      const back = diff < 0;
      const magnitude = Math.abs(diff);

      const button = panel.querySelector(
        magnitude >= 12
          ? back
            ? '.ant-picker-header-super-prev-btn'
            : '.ant-picker-header-super-next-btn'
          : back
            ? '.ant-picker-header-prev-btn'
            : '.ant-picker-header-next-btn'
      );
      if (!button) throw new Error(`Could not scroll the calendar to ${iso}`);

      fullClick(button);
      await sleep(220);
    }
    throw new Error(`Could not reach ${iso} in the calendar`);
  }

  /**
   * Sets both dates, walking the picker back when the target is out of reach.
   *
   * SiteGiant allows a date only within ~31 days of whatever is already chosen,
   * and with NOTHING chosen it anchors that window near today. Naively picking
   * the target start first therefore fails on anything older than about three
   * months — which is what made a request for May die on 2026-05-01.
   *
   * But the window RATCHETS: every pick re-anchors it to the other field, so
   * taking the earliest date on offer drags the whole window back ~31 days, and
   * repeating that reaches any date. Measured on the live dialog 2026-08-08:
   *
   *   end := 09 May (earliest first pick)  ->  start could then reach 07 Apr
   *   start := 07 Apr                      ->  end could then reach   08 Apr
   *   end := 08 Apr                        ->  start could then reach 01 Apr
   *
   * Anson worked this out by hand before the code did. The loop below is that
   * same manoeuvre: reach for the target, and if it is refused, take the
   * earliest date offered and try again from there.
   */
  async function pickRange(startISO, endISO, startInput, endInput) {
    fullClick(endInput);
    await waitFor(openPicker, { label: 'the date picker' });

    let placed = false;

    for (let step = 0; step < 20; step += 1) {
      // ALWAYS re-focus the end field before reaching for the end date. An
      // earlier version let the picker decide which field was active after each
      // pick, and it moved on to the start — so the END date got typed into the
      // START box. Asking for April produced 30-04 → 09-05 and then failed.
      fullClick(endInput);
      await sleep(350);

      const cell = await reachCell(endISO, endInput);
      if (cell && !cell.classList.contains('ant-picker-cell-disabled')) {
        fullClick(cell.querySelector('.ant-picker-cell-inner') || cell);
        await sleep(500);
        placed = true;
        break;
      }

      // Out of reach. Drag the window back one notch: take the earliest date
      // the END will accept, then the earliest the START will accept. The
      // second of those re-anchors the end's window further back still, which
      // is what makes the next attempt reach further.
      const endPanel = await ensurePickerOpen(endInput);
      const earliestEnd = earliestOffered(endPanel);
      if (!earliestEnd || earliestEnd <= endISO) {
        throw new Error(`SiteGiant will not offer any date near ${endISO}`);
      }
      await pickDateCell(earliestEnd, endInput);
      await sleep(450);

      fullClick(startInput);
      await sleep(350);
      const startPanel = await ensurePickerOpen(startInput);
      const earliestStart = earliestOffered(startPanel);
      if (earliestStart) {
        await pickDateCell(earliestStart, startInput);
        await sleep(450);
      }
    }

    if (!placed) throw new Error(`Could not set the end date to ${endISO}`);

    // The start is within a month of the end now, so it goes straight in.
    fullClick(startInput);
    await sleep(350);
    await pickDateCell(startISO, startInput);
    await sleep(500);
  }

  async function ordersSubmit({ startISO, endISO }) {
    const item = await openOrdersMenu();
    fullClick(item);

    const modal = await waitFor(
      () => {
        const root = document.querySelector('.ant-modal-root, .ant-modal-wrap');
        return root && isVisible(root) ? root : null;
      },
      { label: 'the export dialog' }
    );

    // "Order Info with Products". Without this the export carries no line
    // items, so no SKUs, so ProfitLens would import revenue with no cost.
    const withProduct = await waitFor(
      () => modal.querySelector('input[type=radio][value="withProduct"]'),
      { label: 'the "with products" option' }
    );
    if (!withProduct.checked) {
      fullClick(withProduct.closest('label') || withProduct);
      await sleep(200);
    }
    if (!withProduct.checked) {
      throw new Error('Could not select "Order Info with Products"');
    }

    // Export by date range rather than current selection or filter results.
    const byRange = modal.querySelector('input[type=radio][value="dateRange"]');
    if (byRange && !byRange.checked) {
      fullClick(byRange.closest('label') || byRange);
      await sleep(200);
    }

    const startInput = modal.querySelector('input[placeholder="Start Date" i]');
    const endInput = modal.querySelector('input[placeholder="End Date" i]');
    if (!startInput || !endInput) throw new Error('Could not find the date fields');

    await pickRange(isoDate(new Date(startISO)), isoDate(new Date(endISO)), startInput, endInput);

    if (!squash(startInput.value) || !squash(endInput.value)) {
      throw new Error('The dates did not stick — SiteGiant may have changed its date picker');
    }

    const submit = await waitFor(
      () => {
        const scoped = Array.from(modal.querySelectorAll('button')).filter(isVisible);
        return scoped.find((b) => /^Export$/i.test(squash(b.textContent)));
      },
      { label: 'the Export button' }
    );

    fullClick(submit);

    // Submitting is a form POST that NAVIGATES to /orders/export. The
    // background worker waits for that load; this context is about to die.
    return { ok: true };
  }

  /* ------------------------------------------------------------------ *
   * Batch Edit — the stock & cost export.
   *
   * Reached by navigating straight to /items/batch-edit. The Bulk Tools menu
   * on /items opens on hover only, but going direct skips it entirely.
   * ------------------------------------------------------------------ */
  async function batchGenerate() {
    const infoType = await waitFor(
      () => document.querySelector('input[type=radio][value="basic_info"]'),
      { label: 'the Basic Info option' }
    );
    if (!infoType.checked) {
      fullClick(infoType.closest('label') || infoType);
      await sleep(200);
    }

    const filterAll = document.querySelector('input[type=radio][value="all"]');
    if (filterAll && !filterAll.checked) {
      fullClick(filterAll.closest('label') || filterAll);
      await sleep(200);
    }

    const generate = await waitFor(
      () =>
        Array.from(document.querySelectorAll('button'))
          .filter(isVisible)
          .find((b) => /^Generate$/i.test(squash(b.textContent))),
      { label: 'the Generate button' }
    );

    fullClick(generate);
    return { ok: true };
  }

  /** The Exported List has its own Refresh button — cheaper than a reload. */
  async function batchRefresh() {
    const btn = Array.from(document.querySelectorAll('button'))
      .filter(isVisible)
      .find((b) => /^Refresh$/i.test(squash(b.textContent)));
    if (btn) {
      fullClick(btn);
      await sleep(600);
    }
    return { ok: true, refreshed: Boolean(btn) };
  }

  /* ------------------------------------------------------------------ *
   * Message plumbing.
   * ------------------------------------------------------------------ */
  async function handle(msg) {
    switch (msg.type) {
      case 'ping':
        return { ok: true, url: location.href };
      case 'checkLogin':
        return checkLogin();
      case 'ordersQueue':
        return { rows: await ordersQueue(), pending: pendingCount() };
      case 'batchQueue':
        return { rows: await batchQueue(), pending: pendingCount() };
      case 'ordersSubmit':
        return ordersSubmit(msg);
      case 'batchGenerate':
        return batchGenerate();
      case 'batchRefresh':
        return batchRefresh();
      case 'startHeartbeat':
        startHeartbeat();
        return { ok: true };
      case 'stopHeartbeat':
        stopHeartbeat();
        return { ok: true };
      default:
        return { error: `Unknown command: ${msg.type}` };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handle(msg)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err?.message || String(err) }));
    return true; // keep the channel open for the async reply
  });

  startHeartbeat();
})();
