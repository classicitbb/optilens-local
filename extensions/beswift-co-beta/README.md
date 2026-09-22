# OptiLens BeSwift CO (Beta)

Beta channel of the BeSwift Certificate of Origin automation. Claims OptiLens
BeSwift CO jobs and fills the BeSwift certificate form for operator review.
Loads side-by-side with the stable `beswift-co` extension.

These notes used to live as `_comment*` keys inside `manifest.json`. Edge
reports every unrecognized top-level manifest key as an extension error on
`edge://extensions`, so the rationale lives here instead and the manifest holds
only keys the browser understands.

## Extension ID is pinned — do not regenerate the key

`manifest.json` carries a `key` field that pins the extension ID to
`jdnkiokjepfphfjhedkdilniagobhkoe`, so an unpacked dev load and the
policy-installed `.crx` are recognised as the same extension.

The private half lives at `data/ext/beswift-co-beta.pem`, which is gitignored.
**Back it up.** Losing it means a new extension ID, which means re-pushing the
Edge policy to every machine.

## Shipping an update

`update_url` points at a self-hosted Omaha update manifest
(`http://ino-3frc3q3/extensions/beswift-co-beta-updates.xml`). Edge polls it for
force-installed copies. Releasing is:

1. Bump `version` in `manifest.json`.
2. Run `scripts/pack-beswift-extension.ps1` on the host.

That re-signs the `.crx` and rewrites the update manifest. Force-installed
copies pick it up on their next update check; `site-bridge.js` also requests an
immediate check on every OptiLens page load. Without the version bump, nothing
ships.

Note that a workstation may instead have the extension loaded **unpacked off
the SMB share** (`\INO-3FRC3Q3\GitHub\optilens-local\extensions\beswift-co-beta`).
Those copies read the host checkout directly and ignore the `.crx` entirely —
they pick up a change on the next extension reload, which `reloadIfStale` does
automatically while idle, but only when auto-drive is on.

## Pointing the extension at the app (`baseUrl`)

The popup's OptiLens URL is stored as `baseUrl` and the background worker reads
it from storage, not from the form. Use a LAN-reachable origin:

| Use | Why |
| --- | --- |
| `http://ino-3frc3q3` | IIS proxy on port 80. Works from the LAN. |
| `https://optilens.cv.net` | Documented LAN HTTPS URL. Works from the LAN. |
| ~~`http://…:8080`~~ | **Do not use.** The Node app on 8080 is host-only; from any other machine the TCP connect fails and every poll dies as `Failed to fetch`. |

That failure is silent: `pollForQueuedJob` swallows it with `.catch(() => {})`,
so a queued job simply sits unclaimed forever with nothing in any log. If a job
will not claim, check `baseUrl` first.

Every origin the extension talks to must also appear in `host_permissions`, and
every origin the app is *browsed* at must appear in `site-bridge.js`'s
`matches` — otherwise the Delivery & Export plugin-checker row cannot see the
extension on that origin.

## Content scripts

- `content.js` — runs on the BeSwift portals only. The automation itself.
- `site-bridge.js` — runs on the OptiLens app origins only. Announces this
  extension's presence and version so the Delivery & Export tab row can show
  install/update status. Read-only: it never touches BeSwift, only ever answers
  pings, and exposes nothing but a version string.

Content-script → server calls always relay through the background service
worker (`reportStatus`, `pollJobStatus`, `recordResolution`, `resumeJob`). The
BeSwift portal is HTTPS, so a direct `fetch()` from the content script to an
`http://` OptiLens origin would be blocked as mixed content; the worker is not
subject to that restriction. Keep new server calls on the relay path.

## Run stages

1. **Sign in** — three page loads, orchestrated by `background.js`.
2. **Header fill** — Applicant / Exporter / Importer / Producer / Consignee /
   Transport / Invoice, then a blank-field sweep and a mandatory review pause.
3. **Item fill** — one dialog per customs line, resuming past lines already
   saved on the form.
4. **Review gate** — the run stops and asks. *Finish here* ends at
   `filled_review`, exactly as it always did. *Verify & submit* continues.
5. **Verify & submit** — Form Action → Verify Document, the verification
   message is shown back verbatim, and only a second explicit go-ahead clicks
   Submit → Proceed. The Registration Reference is read off the page and
   reported with the terminal `submitted` status.
6. **Payment** — not automated. See `docs/beswift-payment-automation.md`. After
   a submit the run offers to *record* the operator's own payment run (which
   controls were used, never any entered value) so the automation can be
   written against real selectors.

A resume that carries no choice with it — the popup button, the right-click
menu — always takes the conservative branch (`finish`, `stop`). Submission is
irreversible and chargeable; it only happens when somebody asks for it on the
panel.

## Fill speed

Every artificial delay in the fill is divided by `fillSpeed`, read from
`chrome.storage.local` at the start of each run and set from the popup. The
default is **2x**. The per-field pacing was tuned one field at a time against
the live portal, so it is scaled as a whole rather than re-tuned — the
proportions that work stay, the run just gets shorter.

Plain text fields are also filled with one CDP `insertText` for the whole
string instead of one call per character, verified against the field afterwards
and falling back to character-by-character typing if the value did not land.
The autocompletes still type character by character, because that filtering is
the point.

Baseline, job `7C4FB596` (2026-09-22, two items, 1x and per-character typing):
107s of header, ~57s per item, ~230s of machine time in all.

If a run starts missing fields, put the speed back to 1x in the popup before
anything else — the pacing exists for BeSwift's own async lookups.

## Attention signal

Any pause raises attention: the on-page panel is forced open and opaque, pulled
back on screen if it was parked off it, and pulsed amber; while the tab is in
the background the tab title flashes. Everything is restored to the operator's
own layout when the pause clears. Before this, a pause on a collapsed panel or a
backgrounded tab was silent and the run just sat there.

The pause panel leads with the buttons. The error/resolution capture form is
folded behind "Record what went wrong (optional)" and is never in the way of
resuming; anything typed into it is saved when the run resumes.
