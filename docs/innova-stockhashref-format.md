# Innova `.stockhashref` format (website stock/SKU orders)

Reference example: `templates/stock-order-example.stockhashref` (dropped by Russell 2026-08-09, real order from GK/Innova, GK order id 34087572, lab 1177 / cust 5007245).

## What it's for

A **separate order type** from the existing `.rx` / RXI pipeline (`lib/rx-generator.js`, `lib/rx-order-submitter.js`, `lib/innova-api-client.js` → `process_rxi`). Where `.rx` carries a full uncut Rx job (prescription, frame trace, lens material/style codes), `.stockhashref` is for **finished stock lenses already identified by SKU** — no prescription block, no frame/lens material fields. Filename pattern seen: `{epoch_ms}_{something}.stockhashref` (e.g. `1786315733471_classicmain071405256062.stockhashref`).

## Header fields

| Field | Example | Notes |
|---|---|---|
| `file_version` | `1.0` | same as `.rx` |
| `hashrouting_key` | long opaque token | present here, **blank** in our `.rx` template — purpose/generation unknown, treat as required and pass through verbatim if we ever receive/forward one; unclear if Innova will generate it for us on submission or expects us to supply it |
| `start_order` | literal | |
| `agent_name` / `agent_version` | `LL` / `3` | matches `config.json` defaults |
| `lab_num` | `1177` | matches our lab |
| `cust_num` | `5007245` | **differs** from `config.json` default (`5000150`) — this example is a different customer account than our test default |
| `cust_seq_num` | `1` | |
| `date_ordered` | `2025-07-07 18:03:53` | same `YYYY-MM-DD HH:MM:SS` format as `formatDate()` in rx-generator.js |
| `instructions` | (blank) | |
| `x_standard_shape_trace` | `false` | |
| `order_id` | `50810919` | |
| `x_gk_order` | `34087572` | GK (GuidedKart?) order id |
| `x_gk_guid` | 40-char hex | |
| `customer_po_num` | `05` | **new field, not in `.rx` template** — PO number passthrough |
| `patient_name` | `Harvey Stock Order` | stock orders use a placeholder patient name rather than a real patient |
| `ship_name` | `Spice Eyele` | |
| `rx_eye` | `5` | **differs** from our `.rx` default (`3`) — meaning of the code unconfirmed |
| `frame_tracing` | `NO TRACE` | present but no other frame_* fields (no source/status/model/color/a/b/dbl/mounting/dress/edge) |
| `frame_rad_angle` | `45.0` | present alone, same default value we use in `.rx` |
| *(no lens_od_*/lens_os_* material/style/color fields)* | | fully absent — stock items carry their own description in the item block instead |
| `x_rx_balance` | `true` | |
| `x_rx_seg_height_qual` | `1` | |
| `end_order` | literal | |

## Item block (repeats per line item)

```
item_start
sku:0011751138
item_source:FLENS
item_description:1.50 Trans / Photochromic Single Vision Trans 8 Gray HC 70.0 -1.0/-0.5/Either
item_quantity:2
item_comment:
item_part_rx:Y
item_end
```

- `sku` — 10-digit Innova SKU for the exact finished lens (material/photochromic/design/index/coating/color/power combo baked in — see the sphere/cyl values embedded in `item_description`, e.g. `-1.0/-0.5/Either`).
- `item_source` — `FLENS` = **finished lens**, `SLENS` = **semi-finished lens** (confirmed by Russell 2026-08-10). Still caller-supplied per item, not inferred — there's no stock-item catalog to look it up from yet.
- `item_description` — free text, includes index, tint/photochromic, design name, tint code, HC coating, base curve or diameter (`70.0`/`77.0`), and power/side (`sphere/cyl/side` or `sphere/cyl/Either`).
- `item_quantity` — same as `.rx`'s `item_quantity`.
- `item_comment` — new field vs `.rx` (which has no per-item comment).
- `item_part_rx` — same as `.rx`.
- **No `item_side` field** (unlike `.rx`'s item blocks) — side is instead embedded in `item_description`'s trailing `/Right`, `/Left`, or `/Either`.

This order has two SKUs for a single-vision pair (qty 2 each, likely OD+OS of the same SKU counted together or two different powers) and two SKUs for a Shoreview ES pair (Right/Left, qty 1 each) — so `item_source` and the paired left/right SKUs are how side is expressed for non-Either items, rather than a shared line with `item_side`.

## Delivery method (2026-08-09)

Confirmed via the InnovaAPI spec (`docs/innova api - prototype.htm`): no stock/SKU endpoint exists, only `/process_rxi` (RXI-only). So `.stockhashref` has exactly one transport — file-drop into Innova's watched share, which Russell confirmed is `\\INNOVA-SVR\Innovations\Incoming`.

Built `lib/stock-order-generator.js` + `templates/stock-order-template.txt`, mirroring the existing `.rx` pipeline's staging → release split:
- `preview(payload)` / `generate(payload, actor)` — render and write to `output/stock/staging` only. No external side effect.
- `release(payload, actor)` — the **only** function that touches the real Incoming share; copies a staged file into `folders.incoming` (now set in `data/rx/config.json`) and into `output/stock/archive`. Must be called explicitly per file, same as `rx-generator.release()`.
- Verified the renderer reproduces Russell's real example byte-for-byte (aside from our self-generated order_id/gk_order/gk_guid and current timestamp).

`data/rx/config.json` changes:
- `folders.incoming` was blank — now set to `\\\\INNOVA-SVR\\Innovations\\Incoming`. **This also activates the existing `.rx` file-drop fallback in `rx-order-submitter.js`** (previously inert since that path was empty) — worth knowing since it's currently harmless only because the `rx_order_submissions` migrations haven't been run yet ([[rx-order-pipeline]] go-live checklist).
- New `folders.stockStaging` / `stockArchive` (local, `output/stock/...`).
- New `stockOrder` block: `rxEye: "5"` (matches Russell's real stock-order example, vs `"3"` for `.rx`), `frameTracing`/`frameRadAngle` defaults, `extension: ".stockhashref"`.

Decisions made rather than left open:
- `hashrouting_key` — left blank, matching the `.rx` template's existing (accepted) convention for self-generated orders.
- `x_gk_order` / `x_gk_guid` — **not actually GK-sourced**; the `.rx` pipeline already self-generates these via `rxGenerator.nextIdentifiers()` (shared sequence counter) and this module reuses the same mechanism.
- `item_source` (`FLENS`/`SLENS`) — **not inferred**. The generator requires each caller to supply it explicitly and rejects anything else; nobody has confirmed what distinguishes them, so guessing was avoided.

## Still open / unverified

- Nobody has confirmed the Node process (on INO-3FRC3Q3) can actually reach `\\INNOVA-SVR\Innovations\Incoming` — no shell access to that host was available this session to test connectivity/permissions. **Do not trust `release()` to work until someone runs it once and checks the file actually lands (and gets processed) at Innova.**
- **2026-08-09 sandbox test was a false positive, not a real test.** Ran `release()` from the Claude session's Linux sandbox — it reported success, but Node's `path.resolve()` is POSIX-mode on Linux, so the UNC string `\\INNOVA-SVR\Innovations\Incoming` was NOT parsed as a network path; it silently got treated as a literal relative folder name and the "released" file landed in a bogus local directory (`optilens-local\\INNOVA-SVR\Innovations\Incoming\...`) inside the repo, never leaving the sandbox. Cleaned up what could be deleted — the sandbox's bash mount also has an EPERM issue unlinking files, so some stray test files may remain under `output/stock/staging`/`output/stock/archive` and need manual deletion. **This only works correctly on an actual Windows host** (Node's win32 path module handles UNC paths, and the LAN route to `\\INNOVA-SVR` exists there, not in the sandbox). Use `scripts/test-stock-release.js` for a real connectivity test, run directly on a machine that actually has that share reachable (e.g. INO-3FRC3Q3).
- What determines `FLENS` vs `SLENS` — still unknown; caller must know per-item.
- No source of stock/SKU orders is wired up yet (no CVWeb cart/outbox for stock items — only the Rx outbox from [[rx-order-pipeline]] exists). This module is the send mechanism only; nothing calls `generate()`/`release()` automatically yet.

See [[rx-order-pipeline]] memory for the existing `.rx`/RXI build this mirrors.
