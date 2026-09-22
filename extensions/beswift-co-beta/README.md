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
