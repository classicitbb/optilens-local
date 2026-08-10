# `.rx` (LabLink RXI) field map — RxOrderForm → Innovations

Reference samples (uploaded by Russell 2026-08-09, saved for regression fixtures):
`templates/rx-samples/*.rx` — 4 real LabLink exports for lab 1177:
1. `classicmain24161230093366548...rx` — SV distance, uncut, no shape trace.
2. `classicmain25132443076283360...rx` — progressive, **enclosed + full shape trace**.
3/4. `classicmain09190740036979709...rx` (uploaded twice, identical) — progressive, wrap frame, **enclosed + full shape trace**.

This is the file `optilens-local` writes into `\\INNOVA-SVR\Innovations\Incoming` (or POSTs via
`process_rxi`) once a staff member releases a web Rx order. Every line below maps to either a
CVWeb `rx-order` payload field, a `data/rx/config.json` default, or a self-generated identifier.

## Order header

| `.rx` field | Real sample value | Source | Notes |
|---|---|---|---|
| `file_version` | `1.0` | `config.defaults.fileVersion` | static |
| `hashrouting_key` | long opaque token | **not sent** (blank) | Never produced by us on any sample we generate — Innova-issued, inbound-only. Same open question as `.stockhashref` ([[innova-stockhashref-format]]). |
| `agent_name` / `agent_version` | `LL` / `3` | `config.defaults` | LabLink agent identity — matches regardless of who actually submits |
| `lab_num` | `1177` | `config.defaults.labNum` | Classic Visions' lab number at Innovations |
| `cust_num` | e.g. `5000162` | `payload.account.account_number` / `innovations_customer_id` | **Required** — submitter throws if missing; assign the quote to an ERP account before release |
| `cust_seq_num` | `1` | `config.defaults.custSeqNum` | always `1` observed |
| `date_ordered` | `YYYY-MM-DD HH:MM:SS` | generated at submit time | `rxGenerator.formatDate()` |
| `x_remote_operator` | e.g. `eyeq`, `lisa.j` | `config.defaults.remoteOperator` | identifies who's placing it at the dispensing end — currently one fixed value for all CV web orders (`1177-004`); consider per-staff-user in future |
| `instructions` | free text | `payload.quote.notes_customer` + CV order number + any unmatched add-on names | truncated to 500 chars; see `buildOrder()`'s `instructionParts` |
| `x_standard_shape_trace` | `true`/`false` | **always `false`** from us | see "Shape trace" below — the web form has no tracer hardware |
| `order_id` | 8-digit | self-generated | `rxGenerator.nextIdentifiers()`, shared sequence counter in `data/rx/sequence.json` |
| `x_gk_order` / `x_gk_guid` | numeric / 40-char hex | self-generated | same sequence call — **not actually GK-sourced**, just satisfies the format |
| `patient_name` | `LASTNAME, FIRSTNAME` | `payload.quote.contact_name` / `customer_name`, upper-cased | must be `LAST, FIRST` shape or Innova will likely reject it |
| `ship_name` | e.g. `Classic Visions Retail` | `payload.account.name` / `payload.quote.customer_name` | falls back to `"Classic Visions"` |
| `rx_eye` | `3` | `config.defaults.rxEye` | `3` = both eyes, used on every `.rx` sample seen (stock `.stockhashref` orders use `5` instead — different order type, do not confuse) |

## Frame block

| `.rx` field | Uncut sample | Enclosed+traced sample | Source |
|---|---|---|---|
| `frame_source` | `NO TRACE - UNCUT` | `TRACE - UNCUT` | **fixed to `NO TRACE - UNCUT` always** (see below) |
| `frame_status` | `UNCUT` | `ENCLOSED` | `ENCLOSED` when `!frame.is_uncut && frame.job_scope === 'full_glaze'`, else `UNCUT` |
| `frame_tracing` | `NO TRACE` | `TRACED` | **fixed to `NO TRACE`** (see below) |
| `frame_model` | `DITA MACH ONE` | `BOSS 1197` | `payload.frame.brand` / `model_colour` |
| `frame_color` | *(absent on uncut sample)* | `Black/Silver` | `payload.frame.model_colour` |
| `frame_a` / `_b` / `_dbl` | `59.0`/`48.0`/`20.0` | `56.0`/`37.0`/`19.0` | `payload.frame.a_mm` / `b_mm` / `dbl_mm`, default 55/38/15 |
| `frame_rad_angle` | `45.0` | `45.0` | fixed `45.0` on every sample — never varied, left as a constant |
| `frame_mounting` | `1` | `2` | **fixed to `1`** currently — real samples show `1` (rimless-ish?) and `2` (different mount type); mounting type isn't captured anywhere in the RxOrderForm today. Flag: if frame mount type matters to Innova's edging, this needs a form field. |
| `frame_dress` | `DRESS` | `DRESS` | fixed |
| `frame_edge` | `UNCUT` | `EDGED` | `EDGED` when enclosed+full-glaze, else `UNCUT` |

**Fix landed 2026-08-09:** the generator previously wrote `frame_source`/`frame_tracing` as
`"FRAME TRACE"` for edged jobs — a value that appears in **none** of the 4 real samples (only
`"NO TRACE - UNCUT"` and `"TRACE - UNCUT"`/`"TRACED"` do, and the latter only ever appears
alongside a real `trace_start…trace_end` geometry block). Since the web form can't produce that
geometry, claiming `"TRACED"` would misrepresent the job. Now always sends `"NO TRACE - UNCUT"` /
`"NO TRACE"` regardless of edged/uncut — Innovations traces enclosed frames in-house when no
digitized shape is supplied. **This exact combination (`ENCLOSED` + `NO TRACE`) has no confirmed
real sample** — it's the closest honest mapping of the two known enum pairs. If Innovations
rejects or mishandles an edged web order, this is the first thing to check.

## Shape trace block (`trace_start` … `trace_end`)

Present only when `x_standard_shape_trace:true`. Contains a physical frame tracer's raw digitized
boundary: `REQ`, `JOB`, `DBL`, `CIRC`, `HBOX`/`VBOX` (frame box dimensions), `.ED`/`.AX`,
`TRCFMT` + up to hundreds of `R=` lines (polar radius samples around the boundary, right eye then
left eye), `ZFMT` + `Z=` lines (bevel depth samples). This is tracer-hardware output — a website
order form has no way to originate it. **Not implemented and not planned** unless CV integrates
an in-store frame tracer that exports to this format later. Current behavior (always
`x_standard_shape_trace:false`, no block emitted) is correct for a form-only order.

## Lens block

| `.rx` field | Source |
|---|---|
| `lens_od_color_code` / `_desc`, `lens_od_material_code` / `_desc`, `lens_od_style_code` / `_desc` (and `_os_` mirrors — CV only ever sends the same lens both eyes) | `payload.lenses[0].codes` — resolved via the Alias Mapping table (`admin/pricing/alias-mapping`). **Required**: `buildOrder()` throws "No Innovations alias resolved…" if `codes.material_code` is missing — a lens must be mapped before it can be released. |

## Item lines (repeats per line item)

| `.rx` field | Source |
|---|---|
| `sku` / `item_source` / `item_description` | matched from `rxGenerator.getCoatings()` / `getAddons()` catalog by `payload.addons[].sku`, falling back to name match |
| `item_value` | *(seen on tint items only, e.g. `GRAY,80%`, `BROWN,70%`)* — **not currently emitted by CV's generator**; if a tint add-on is selected, its color/density needs its own field on the RxOrderForm and a corresponding `item_value` line, or it silently loses that detail today |
| `item_quantity` | `payload.addons[].qty`, default 1 |
| `item_side` | catalog default, usually `NONE` |
| `item_part_rx` | catalog default, usually `Y` |
| *(misc `sku:1` / `sku:2` lines)* | Innova-internal — appear on every real sample without a description; not something CV needs to generate deliberately, likely an Innova-side default line |
| `EDGED` add-on (`sku:7401`) | auto-appended when `edged` is true and not already present in the matched items |

## Prescription block

| `.rx` field | Source |
|---|---|
| `lens_sv_mf` (`s`/`m`) | `rxGenerator.LENS_BEHAVIOUR[codes.mf_type].lensSvMf` |
| `x_rx_type` (`S`/`P`/`B`) | same behaviour lookup |
| `x_rx_dispense` | mirrors `x_rx_type` |
| `x_rx_balance` | **hardcoded `true`** in the template regardless of payload — real samples show both `true` and `false`; not currently distinguished. Low priority (cosmetic on the lab side) but worth fixing if it ever matters. |
| `rx_od_sphere` / `_cylinder` / `_axis` / `_add` | `payload.lenses[0].rx.od_sph` / `od_cyl` / `od_axis` / `od_add` (and `os_` mirrors) |
| `rx_od_near` / `_far` | `rx.od_npd` / `od_fpd`, or half the binocular `rx.pd`, or `config.prescription.defaultMonocularPd` |
| `rx_od_seg_height` | `rx.seg_height` / `fitting_height` when the lens behaviour requires it (progressive/bifocal), else `0.0` |
| `x_rx_seg_height_qual` | fixed `1` |
| `x_rx_reading`, `x_rx_prism*`, `x_spcfit_*`, `x_wrap_*`, `x_engraver_str` | **seen in real samples, not emitted by CV's generator at all** — prism, wrap-fit measurements, and engraving currently have no home in the RxOrderForm/payload. Not a blocker (Innova will just treat them as absent/default) but worth a form audit if CV ever needs prism-corrected or wrap-frame orders through the web pipeline. |

## Open items (flag to Russell, don't guess further)

- `hashrouting_key` — always blank on send; unconfirmed whether Innova requires/accepts one from us.
- `frame_mounting` — not captured anywhere in the RxOrderForm; always sent as `1`.
- `item_value` (tint color/density) — no RxOrderForm field yet; tint add-ons lose this detail.
- Enclosed-but-not-traced enum combination — best-guess, unverified against a real sample.
- Prism / wrap-fit / engraving fields — no RxOrderForm inputs; fine to omit unless a real order needs them.
