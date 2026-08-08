# 📦 SiteGiant Downloader

A Chrome extension that fetches your **two SiteGiant reports** and sends them
straight into ProfitLens, instead of exporting, downloading and uploading them
by hand.

| Report | What it carries |
|---|---|
| **Orders** | Your orders for the last 7 days, including the products in each one |
| **Stock & Cost** | Cost price and stock on hand for every SKU |

Files are also saved to your computer, in dated folders:

```
Downloads/
  SiteGiant/
    06082026-Thursday/
      Orders_06-08-2026-1786008510.zip
      batch_edit_basic_info_all_06-08-2026-1786008633.zip
```

---

## Install

**1. Download**

[⬇ Download the extension](https://github.com/anson81/SiteGiant-Downloader/archive/refs/heads/main.zip)

**2. Unzip it, and keep the folder somewhere safe**

Documents is a good spot. **Not** Downloads — Chrome reads from this folder every
time you use the extension, so it must not be deleted or moved later.

**3. Add it to Chrome**

1. Type `chrome://extensions` in the address bar
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** (top left)
4. Choose the folder you unzipped

The green icon appears in your toolbar. Pin it if you like.

> Chrome may show a popup saying *"Disable developer mode extensions"* when it
> starts. That is normal for extensions installed this way — just close it.

---

## Using it

1. Log in to **SiteGiant** as you normally would
2. Log in to **ProfitLens** in the same Chrome
3. Click the green icon
4. Click **Sync both reports**

That's it. Leave the window open while it runs — about a minute.

When it finishes you'll see three numbers for each report:

> **12 new · 3 updated · 431 unchanged**

*New* means orders it had never seen. *Updated* means something changed, like a
status. *Unchanged* means it was already correct — which is normal and good, not
a problem.

You can also click **Orders** or **Stock & Cost** on their own.

### Getting an older month

Under **Get a past month**, pick a month and press **Get month**. It fetches that
whole month's orders and sends them to ProfitLens, filed under a folder named for
that month. Use it to build up history a month at a time.

### What you've already fetched

Open the list below Progress to see past runs, newest first. Each one shows when it
ran, what it fetched, and the counts that came back — with a tag like `2026-06` on
anything pulled for a specific month.

That tag is the point: fetching a past month leaves a permanent export on
SiteGiant's side, so this answers *"have I already done June?"* without going and
looking at their Exported list. Failed runs are kept too — those are the ones worth
seeing again.

### Why both logins matter

The extension doesn't have its own password for anything. It uses the SiteGiant
tab and the ProfitLens tab you're already logged into. If you're logged out of
either, it will say so.

If ProfitLens is logged out, **your files are still saved to your computer** —
nothing is lost. Log in and press the button again.

---

## Things worth knowing

**Pressing the button gets you fresh data.** Every press builds a new export,
because stock and cost move during the day and a recycled file would look
freshly synced while being out of date.

The one exception: an export made in the **last 3 minutes** is reused, so a
double-click or an immediate retry doesn't build the same file twice.

**Exports pile up on SiteGiant.** Every one you create stays in the Exported
list permanently. That's the price of fresh data, and it's the right trade —
but it is why this is a button you press, not something that runs hourly.

**Many products have no cost price.** About 1,088 of your SKUs show RM0.00 cost
in SiteGiant. Those will show up in ProfitLens as costing nothing, which makes
them look 100% profitable. That's a SiteGiant data problem, not an extension
problem — but it's the most likely reason a profit number looks too good.

**It only works while Chrome is open.** This is not a server. If the computer is
asleep, nothing happens.

**If you skip a few days**, the extension notices and asks SiteGiant for the
missed days too, up to 60. You don't have to do anything.

---

## Settings

Click the ⚙ button in the popup.

| Setting | What it does |
|---|---|
| ProfitLens address | Where files get sent. Defaults to `http://localhost:3000`, which is ProfitLens running on this computer. `profitlens.my` is a parked domain, not a deployment (checked 2026-08-06) — change this the day that stops being true |
| Send automatically | Turn off to only save files to your computer |
| Days of orders | How far back the normal sync fetches. Minimum 7, maximum 31. Use **Get a past month** to reach older months |

### Loading your back history — use **Get a past month**

Pick a month, press **Get month**, and it fetches that whole month of orders.

**Any month is reachable**, however far back — the picker just has to be walked
there, which the extension does for you.

SiteGiant refuses a date more than about **31 days from whatever is already
chosen**, and with nothing chosen it anchors that window near today. That makes an
older month *look* unavailable. It is not: every pick re-anchors the window, so
taking the earliest date on offer drags it back ~31 days, and repeating that
reaches anything. Measured on the live dialog, 2026-08-08:

```
end := 09 May (earliest first pick)  →  start could then reach  07 Apr
start := 07 Apr                      →  end could then reach    08 Apr
end := 08 Apr                        →  start could then reach  01 Apr
```

An older month therefore takes a few seconds longer, because the picker is being
stepped backwards before the real dates go in.

Files are filed under the month they cover:

```
Downloads/SiteGiant/2026-06-monthly/Orders_...zip
```

**Orders only.** Stock and cost have no past version — SiteGiant's Batch Edit
exports them as they are today, so asking for "June's stock" would quietly file
today's figures under June.

Each month you fetch leaves one permanent entry in SiteGiant's Exported list, so a
year of history costs about twelve of them. That is the only real price.

Two caveats when you do it:

- Cost prices come from the Stock & Cost export, which is always **today's** costs.
  Older orders are costed at what those products cost *now*. If your buy prices have
  moved, historical profit is approximate.
- Re-importing orders you already have is harmless — they update rather than
  duplicate, because ProfitLens matches on the marketplace's own order number.

### Not built yet

**Automatic multi-month backfill.** **Get a past month** does one month per press,
which is deliberate — each one creates a permanent export on SiteGiant's side, and
twelve of those should be a decision rather than a side effect. Looping it would be
easy; whether it *should* loop is the open question.

---

## Updates

**Check** and **Update** are at the top of the popup. The bar shows the current
state — up to date, a version available, or a failed check — and **Check** asks
again on demand.

Pressing **Update** opens the settings page to finish the job. That is a browser
constraint, not a choice: writing to the extension's own folder needs a directory
handle from a file picker, and opening a picker closes a popup. It writes the new
files and then **restarts the extension itself**, so there is nothing to do on
`chrome://extensions`.

The first time, Chrome asks you to pick the extension folder. **Only the first
time** — the folder is remembered afterwards.

Chrome may still ask you to *confirm* that permission after a browser restart.
That is one click, not a folder hunt, and no extension can waive it.

If the extension folder is ever moved, the remembered one stops matching and you
will be asked to pick it again. It checks the folder really is this extension —
by reading the `manifest.json` inside it — rather than writing into whatever was
selected.

Updates are read from
[`anson81/SiteGiant-Downloader`](https://github.com/anson81/SiteGiant-Downloader).
The repo is public because `raw.githubusercontent.com` is fetched without
credentials — a private repo would return 404 to the updater.

### The ↻ button

There is a **↻** in the popup footer. It restarts the extension in place — the same
thing as the refresh arrow on `chrome://extensions`, without going there.

Use it whenever the files on disk have changed: Chrome runs the code it loaded when
the extension started, so an edited file does nothing until the extension restarts.
The popup closing is the confirmation.

It is disabled during a run, because restarting between the download and the push
would leave a file on disk that ProfitLens never receives.

---

## If something goes wrong

| Problem | What to do |
|---|---|
| "Please log in to SiteGiant first" | Log in to SiteGiant in the same Chrome, then run again |
| "Not logged in to ProfitLens" | Your files are saved. Log in to ProfitLens and run again |
| "SiteGiant is still building the export" | Wait a minute and run again. Usually it takes seconds |
| "The dates did not stick" | SiteGiant changed its date picker. This needs a fix — see below |
| "Timed out waiting for the Export Orders menu item" | SiteGiant changed its 3-dot menu. This needs a fix — see below |
| Nothing downloads | Make sure the Chrome window stayed open during the run |
| The extension disappeared | The folder was moved or deleted. Unzip it again and re-add it |

---

<details>
<summary><b>How it works</b> — for anyone maintaining the code</summary>

### Layout

```
manifest.json
update.json                version + file list the updater reads
background/background.js   orchestration, CDN fetch, disk writes, push handoff
content/sitegiant.js       ISOLATED: all SiteGiant DOM
content/profitlens.js      ISOLATED: same-origin refresh + multipart upload
popup/                     toolbar UI
options/                   settings + update install
tools/                     make-release.ps1, inspect-sitegiant.js
icons/
```

The background worker knows nothing about either site's DOM; the content scripts
know nothing about files.

**There is no `interceptor.js`.** The Shopee twin needs a MAIN-world hook
because its reports are in-browser blobs with placeholder names. SiteGiant hands
over an ordinary URL, so there is nothing to intercept.

### Why the push runs from a content script

ProfitLens issues its refresh token as an `httpOnly`, `sameSite: 'lax'` cookie
and pins CORS to one origin. An extension calling the API cross-origin gets no
cookie *and* fails preflight. Running the calls from a content script on
`profitlens.my` makes them same-origin, so both problems vanish — and the
extension stores no credential at all.

### What was mapped on the live site (2026-08-06)

**Orders** — `/orders` → `div.ellipsis-btn` → **Export Orders** → antd modal.
`input[value="withProduct"]` is mandatory: `withoutProduct` has no line items,
so no SKUs, so revenue with no cost. Dates are antd pickers, so `.value` does
not register. Submitting is a **form POST that navigates** to `/orders/export`.

**Stock & Cost** — `/items/batch-edit`, reached directly. Two radio groups
(`basic_info`, `all`), a Generate button, and an Exported List. `basic_info`
carries both `cost` and `stock_on_hand`, and it is the only shape
`siteGiantImport.js` parses — the separate `inventory` export is not needed.

The Bulk Tools menu on `/items` **opens on hover and ignores clicks**. Navigating
straight to `/items/batch-edit` sidesteps it.

### Things that will bite you

- **Downloads are on a CDN**, not SiteGiant: `cdn1.sgliteasset.com`. They carry
  no token and need no cookie — which also means anyone holding a link can
  fetch the file.
- **A Pending row has no link and an empty File Name.** That is the only honest
  "ready" signal. "Is there a Download button" is true the moment the table
  renders.
- **The orders queue has no Refresh button** — it needs a page reload. The Batch
  Edit list has one, so it is used instead.
- **The date inputs are `readOnly`.** Typing into them cannot work at any
  format — verified on the live page. The calendar is the only way in, and its
  cells carry `title="YYYY-MM-DD"`, which is what `pickDateCell()` targets.
  Only ~2 months render at a time, so a wide range walks the header arrows first.
- **The allowed window RATCHETS, and `pickRange()` walks it.** A date is only
  accepted within ~31 days of whatever is already chosen. Each pick re-anchors
  the window, so repeatedly taking the earliest date offered reaches any month.
  Three separate mistakes were made getting here, each worth not repeating:
  - *The start must move first.* The end can never precede the start, so from a
    settled range BOTH fields refuse an earlier date until the start gives way.
    With `01-04 → 30-04` on screen, `31-03` was refused as an end and `01-03` as
    a start.
  - *Click the field you mean to set.* After a pick the picker chooses the next
    field itself, which put the END date into the START box — asking for April
    produced `30-04 → 09-05` and then failed.
  - *Re-scroll to the target month every time.* The calendar jumps back to TODAY
    after every pick, so reading "the earliest date offered" without scrolling
    first describes the wrong months — that is how `01-08` reached the start box
    while reaching for April.
  - *A distant month offers NOTHING to stand on.* Scrolling to March showed March
    and April both entirely greyed. `earliestReachable()` therefore walks FORWARD
    from the target until it finds a month with a selectable date, and takes that
    as the stepping stone.
  - *Stop when nothing moves.* Once the earliest date on offer is the one already
    in the box, every further pass repeats itself. Without a check on whether the
    fields actually changed, the walk spins forever — seen live reaching for
    December from a settled March.

  Verified on the live dialog: April and March both land from a cold start.
  How far back SiteGiant will really go is its own business; the walk now says so
  plainly instead of hanging.
- **Menu items are `<p class="un-dots-option">`, not links or buttons**, and
  the label is split: `<span>Export </span><b><span>Orders</span></b>`. The
  first version searched `a,button,li,div,span` and so never even looked at the
  element it needed. `p` is now in that list, and the class is the primary
  target.
- **Three buttons in the export dialog say "Export"-something.** Only one is
  visible (`ant-btn plain-btn`); the other two render at zero size. Match on
  visibility *and* an exact `^Export$`, or you will click a ghost.
- **Reuse is a 3-minute double-click guard, nothing more.** Every export
  filename ends in the Unix time it was requested
  (`..._04-08-2026-1785830507.zip` is 2026-08-04 16:01:47, matching that row's
  Time Requested exactly), so `exportAgeMs()` reads age off the name. This began
  as same-day reuse, which served a 2pm file to a 9pm press; 15 minutes was
  still long enough that pressing the button and watching it skip Generate read
  as a bug. A press means "go and get it".
- **Chrome match patterns cannot contain a port.** `http://localhost:3000/*` is
  silently invalid, which left the extension with no permission for a local
  ProfitLens at all. Manifest patterns are portless (`http://localhost/*`), and
  `ensureProfitLensTab()` compares origins in JS so the port still matters when
  choosing a tab.
- **Orders reuse is narrower still.** It must also be an export *this extension*
  made for the *same window*: the queue shows a request time but not the range a
  file covers, so a manual one-day export must never stand in for seven.
- **Read the export list only after it renders.** It is drawn by JavaScript
  after page load, so reading immediately sees an empty table and concludes
  nothing was ever exported — then builds one that was not needed.
- **`downloads.download({filename})` is a suggestion.** Another extension on
  `onDeterminingFilename` can override it, so our path is re-asserted there.
- **MV3 service workers die after ~30s idle.** The content script pings every
  10s. Do not remove the heartbeat.
- **Timings were measured here, not copied from Shopee.** Orders complete in
  about a second, Stock & Cost in under ten.

### Releasing

```powershell
.\tools\make-release.ps1 -Version 1.1.0 -Notes "What changed"
git add -A; git commit -m "v1.1.0"; git push
```

It rewrites the version in `manifest.json` as text (never a JSON round-trip,
which collapses single-element arrays), refuses an unchanged version number, and
regenerates `update.json` from the files actually on disk.

### Testing

`tools/inspect-sitegiant.js` pasted into DevTools dumps every selector the
extension depends on — radio values, the modal fields, the CDN links and the
Pending count.

</details>
