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

## Content scripts

- `content.js` — runs on the BeSwift portals only. The automation itself.
- `site-bridge.js` — runs on the OptiLens app origins only. Announces this
  extension's presence and version so the Delivery & Export tab row can show
  install/update status. Read-only: it never touches BeSwift, only ever answers
  pings, and exposes nothing but a version string.
