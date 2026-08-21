# SiteGiant Downloader — working notes

Chrome MV3 extension. Downloads SiteGiant orders and stock/cost reports and
pushes them into ProfitLens. Plain JavaScript, no build step, no dependencies.

## The rule that has broken twice

`chrome.downloads.onDeterminingFilename` is **browser-wide**. Chrome asks every
extension holding the `downloads` permission about every download in the
browser — it does not scope the question by site. "We only deal with SiteGiant"
is not something Chrome knows; it is something this listener has to enforce for
itself, on the first line.

**`suggest()` with no arguments is not silence.** Chrome's docs: a listener may
call it "in order to allow the download to use `downloadItem.filename`" — which
is Chrome's own guess from the URL. Our zip comes from a `data:` URL carrying no
name, so that guess is `download.zip`, then `download (1).zip`. Answering blank
therefore throws away the path passed to `downloads.download()` and asks for the
bad name by hand.

Only a plain `return`, without touching `suggest()`, is a true abstention.

So:

- **First line of the listener:** `if (item.byExtensionId !== chrome.runtime.id) return;`
  `byExtensionId` arrives with the event, so this is correct even on a service
  worker woken by that very download, with nothing in memory yet.
- **Never answer blank about our own file.** No path in memory means abstain —
  the path was already passed to `downloads.download()` and stands unless
  something overrides it. This listener is only ever a backstop.
- **Never `return true` and answer later.** Returning true obliges you to call
  `suggest()` or the download stalls for ever, which forces the failure path to
  answer blank — and blank is the bug. An answer that arrives after Chrome has
  settled is the same as no answer, so it is also a race: it passes on a fast
  machine and fails on a slow one.

Sibling extensions on the same machine — Shopee CPM Report Downloader, Shopee
Review Media Extractor — obey the same rule from their side. Through August 2026
these two silenced each other, each release making one of them the most recently
installed and therefore the winner, which is why the same code failed on one PC
and not another. Never explain that away as the machine.

`tools/test-filename-listener.js` boots `background.js` against a stub `chrome`
and fires the listener; a delayed `storage.session.get` reproduces a cold
worker. Run it before and after touching this code.

The **reports folder** option (Options → choose a folder) sidesteps all of it:
the file is written through a `FileSystemDirectoryHandle` and Chrome's naming
never runs. That is also the only defence against a genuine third-party download
manager. It is opt-in, per machine.

## Releasing

There is no Chrome Web Store here. Every machine installs this extension by
hand from the GitHub branch and updates itself from that same branch:
`checkUpdate()` fetches `update.json`, compares its `version` against the
running manifest, and if it is higher the Options page downloads every path in
`update.json`'s `files` list and writes them into the extension folder.

Three things follow, and all three have been got wrong:

1. **Bump `manifest.json` AND `update.json` together.** `checkUpdate()` reads
   only `update.json`. Leave it behind and no machine is ever offered the fix —
   silently. Nothing errors; the old code just keeps running.
2. **Add every new shipped file to `update.json`'s `files`.** The installer
   downloads exactly that list. A file left out is never delivered, so machines
   end up running new code beside old.
3. **Push.** The updater reads `raw.githubusercontent.com` on the branch. A
   commit sitting on one PC does not exist as far as every other PC is
   concerned. A finished fix once sat unpushed for three days while machines
   ran the bug it fixed.

Write a plain-English line into `update.json`'s `notes` — it is what the user
sees in the update prompt. Describe what they will notice, not what changed in
the code.

## Tests

    node tools/test-<name>.js

Every one of them runs in CI on every push (`.github/workflows/tests.yml`), and
each was written after a bug that had already shipped. Run them before pushing
anyway — CI tells you after the fact, and the machines poll this branch.

If you are about to change how downloads are named or where files land, run the
filename tests first, and again after. That is the code with the worst history
in this repo.
