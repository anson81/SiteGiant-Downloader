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

  /** Scrolls the open calendar to a given YYYY-MM. */
  async function scrollToMonth(month) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const panel = openPicker();
      if (!panel) return null;

      const shownMonth = displayedMonth(panel);
      if (!shownMonth || shownMonth === month) return panel;

      const diff = monthsBetween(`${shownMonth}-01`, `${month}-01`);
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
      if (!button) return panel;
      fullClick(button);
      await sleep(210);
    }
    return openPicker();
  }

  /**
   * Focuses a field and scrolls the calendar to a month.
   *
   * Both halves matter. The field must be clicked because the picker decides
   * for itself which one a pick lands in otherwise — that is how the END date
   * once ended up in the START box. And the month must be re-scrolled every
   * time because the calendar jumps back to TODAY after every pick, so anything
   * read without scrolling first describes the wrong months.
   */
  async function openFieldAt(input, month) {
    fullClick(input);
    await waitFor(openPicker, { timeout: 5000, label: 'the date picker' });
    await sleep(300);
    return scrollToMonth(month);
  }

  /** Takes a date if the picker allows it. Returns false if it is refused. */
  async function takeCell(panel, iso) {
    if (!panel) return false;
    const cell = panel.querySelector(`td.ant-picker-cell[title="${iso}"]`);
    if (!cell || cell.classList.contains('ant-picker-cell-disabled')) return false;
    fullClick(cell.querySelector('.ant-picker-cell-inner') || cell);
    await sleep(600);
    return true;
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
    const targetMonth = endISO.slice(0, 7);
    let placed = false;

    for (let step = 0; step < 15; step += 1) {
      // START MOVES FIRST. The end can never precede the start, so from a
      // settled range both fields refuse an earlier date until the start gives
      // way: with 01-04 → 30-04 on screen, asking for 31-03 as the end was
      // refused, and so was 01-03 as the start.
      const startPanel = await openFieldAt(startInput, targetMonth);
      const stone = earliestOffered(startPanel);
      if (stone) {
        await takeCell(startPanel, stone);
      }

      // With the start dragged back, the end can follow.
      const endPanel = await openFieldAt(endInput, targetMonth);
      if (await takeCell(endPanel, endISO)) {
        placed = true;
        break;
      }

      // Still out of reach — take whatever the end will accept and go round
      // again. Refuse to move forwards, or a reset calendar sends us to today:
      // reading the panel before navigating once put 01-08 in the start box.
      const endStone = earliestOffered(endPanel);
      if (!endStone || (stone && endStone > stone && endStone > endISO && step > 0)) {
        throw new Error(`SiteGiant would not offer a date near ${endISO}`);
      }
      if (!(await takeCell(endPanel, endStone))) {
        throw new Error(`SiteGiant would not offer a date near ${endISO}`);
      }
    }

    if (!placed) throw new Error(`Could not set the end date to ${endISO}`);

    // The start is within a month of the end now, so it goes straight in.
    const finalPanel = await openFieldAt(startInput, targetMonth);
    if (!(await takeCell(finalPanel, startISO))) {
      throw new Error(`SiteGiant would not accept ${startISO} as the start date`);
    }
    await sleep(400);
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
