# BeSwift payment automation

Captured 2026-09-22. Sources: three recorded operator payment runs
(`delivery.co_fill_resolutions`, `source = 'payment-capture'`), the submit
stage's first live run (job `7C4FB596`), `extensions/BeSWIFT EPayment User
Guide.docx` and `extensions/BeSWIFT eCOO- Trader's Guide.docx`.

One run per shipment:

1. Fill the certificate — **done** (`fillHeader` / `fillItems`).
2. Submit the certificate — **done** (`submitCertificate`, operator-triggered).
3. Raise the payment order — **done** (`payCertificate`, operator-triggered).
4. Pay Now → the card window opens — **done as a hand-off**; the worker follows
   the window, brings it to the front and records its origin.
5. Card entry — **manual, permanently.** See "The card boundary".

Nothing in stages 2–4 runs without an explicit operator go-ahead on the pause
panel, and there are two of them between arriving at the payment order and
money moving.

## The card boundary

The extension does not type card numbers, CVVs, expiry dates or cardholder
names, and it will not be made to. The reasons are practical, not ceremonial:

- Storing a card number anywhere in OptiLens — payload, `chrome.storage`, job
  log, resolution row — puts card data inside a system that has none of the
  handling obligations that come with it.
- The card is entered on **EZpay**, in a window BeSwift opens separately. That
  origin is not in the extension's `host_permissions` or `content_scripts`
  matches, so no code of ours runs there at all. That is the arrangement, not
  an oversight.
- Everything up to the card page is repetitive data entry worth automating.
  Typing a card number once per shipment is not.

The payment-run recorder respects the same line: it records which controls the
operator used, never a value they typed, and a field that reads as a payment
instrument (`/card|cvv|cvc|security code|expir|cardholder|pan/`) is not even
described — only that a redacted field was touched.

## What the recorded runs actually showed

Three runs on 2026-09-22. The generated ids in them (`input-2350`,
`input-2536`, `input-2324`) change on every load, so nothing in the automation
matches on them — labels and button text only.

| What | Evidence |
| --- | --- |
| The payment order is at `#/accounting/wpos/new` | Route changed with no page load between steps 3 and 4 of run 1 |
| It is reached from the left menu: hamburger → "Online Payment" → "Online Payment Order" | Runs 1–3, `div.v-list-item__title.text-caption` |
| Trader TIN is a labelled autocomplete | `input "Trader TIN"`, option `div.v-list-item__title "1000006494000 - Classic Visions Limited"` |
| The Trader TIN is **not** the certificate's applicant TIN | `1000006494000` here vs `1111000000013` on the certificate |
| The certificate is attached through "Add LPCO Applications" | `span.text-capitalize "Add LPCO Applications"` |
| That dialog ticks a checkbox rather than keying a serial | `div.v-input--selection-controls__ripple`, and no `field` events for serial year / code / number |
| Payment method: "Add Payment Method" → Type → "EZpay" | `input "Type"`, option `div.v-list-item__title "EZpay"` |
| Every dialog save is an icon click followed by a confirmation | `i.v-icon.notranslate.mdi` then `span "Yes"` |

The automation follows that, not the guide's prose, with one deliberate
departure: it sets `location.hash` to the route directly instead of driving the
hamburger menu, because that is three fewer controls to miss. The menu path is
still there as the fallback.

The dialog shape is the one real disagreement with the guide, which describes
typing a serial year, a serial code (`CER`/`PER`) and a serial number.
`addLpcoApplication` handles both: if the dialog exposes a "Serial Number"
field it keys the reference in, otherwise it ticks the row whose text carries
the registration reference. If neither works it pauses for one manual tick.

## Form Actions ask first

Learned from the submit stage's first live run (job `7C4FB596`): every Form
Action operation raises its own confirmation — *"You are about to perform
'Verify Document'. Are you sure you want to proceed? No / Yes"* — and the
operation does not run until it is answered. The first build read the question
back as if it were the verification result. `runFormAction` recognises the
question, clicks Yes, and reads the outcome from what follows. The same applies
to the payment order's Verify Document and to Pay Now.

## The card window

Pay Now opens a new browser window. Because nothing of ours runs inside it, the
service worker follows it through the `tabs` permission instead
(`watchPaymentWindow` in `background.js`):

- The window is brought to the front, since a pop-up that opens behind the
  browser is the same stalled-run problem the on-page attention signal solves
  for pauses.
- Its **origin** is recorded as a `payment-capture` row. Only the origin — a
  payment hand-off URL carries an order token in its query string, and that
  does not belong in a job log.
- Its closing is recorded too.

Meanwhile the fill pauses on the BeSwift side with the attention signal up,
asking the operator to say whether the payment went through, and reports the
terminal status from their answer.

### What would come next, and why it has not been done

Assisting inside the card window — Checkout as Guest, Next, and the billing
address block, none of which is card data — needs that origin added to
`host_permissions` and `content_scripts`. That is a deliberate widening of
where this extension runs, to a page adjacent to card entry, so it is a
separate decision made with the origin in hand rather than guessed at. The
first run on this build will record the origin; that is the input.

Even then the card fields stay manual, and any content script on that page
should carry the same payment-instrument denylist the recorder does.

## Reading a recorded run

```sql
SELECT created_at, field, section, note
FROM delivery.co_fill_resolutions
WHERE source = N'payment-capture'
ORDER BY created_at;
```

Each `note` is a JSON array of `{ n, at, kind, route, control }`, where `kind`
is `click` or `field`, `route` is the SPA path/hash, and `control` is the tag,
id, classes, role, visible text and label text of what was used. Payment window
events are filed in the same table with `field` = "Payment window opened" /
"Payment window closed".

Recording is offered after a submit and stops on its own when the operator
leaves BeSwift, presses **Stop recording**, or after twenty minutes.

## Job status vocabulary

| Status | Meaning | Terminal |
| --- | --- | --- |
| `filled_review` | Filled, reviewed, not submitted | yes |
| `submitted` | Filed with the certifying authority, unpaid | yes |
| `paid` | Operator confirmed the card window was paid | yes |

Exactly one terminal status is reported per run, so the commercial-invoice
archive in `server.js` fires once either way. `paid` carries
`details.registrationReference` and `details.amountPayable`.

BeSwift's own document status still moves to *Paid* on its side when the
payment settles; `paid` here records what the operator saw, not what BeSwift
posted. Reconciling the two would need a read of the application's status back
from the portal, which nothing does yet.
