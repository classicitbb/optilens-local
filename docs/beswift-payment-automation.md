# BeSwift payment automation — target flow and what is still missing

Captured 2026-09-22. Sources: `extensions/BeSWIFT EPayment User Guide.docx`,
`extensions/BeSWIFT eCOO- Trader's Guide.docx`, and the beta extension's own
live-run history.

The end state is one unattended run per shipment:

1. Fill the certificate — **done** (`fillHeader` / `fillItems`).
2. Submit the certificate — **done** (`submitCertificate`, operator-triggered).
3. Raise the payment order — **not built**.
4. Fill the payment order — **not built**.
5. Pay — **manual card entry, permanently**.

Stages 1 and 2 are the automation. Stages 3 and 4 are writable once one live
payment run has been recorded (see "What is still missing"). Stage 5 is not a
gap to be closed; see "The card boundary".

## The card boundary

The extension does not type card numbers, CVVs, expiry dates or cardholder
names, and it will not be made to. The reasons are practical, not ceremonial:

- Storing a card number anywhere in OptiLens — payload, `chrome.storage`, job
  log, resolution row — puts card data inside a system that has none of the
  handling obligations that come with it.
- The card is entered on **EZpay**, a different site. It is not in the
  extension's `host_permissions` or `content_scripts` matches, so no code of
  ours runs there at all. That is the intended arrangement.
- Everything up to the card page is repetitive data entry worth automating.
  Typing a card number once per shipment is not.

So the automation's job ends at "the EZpay card form is open, with the right
amount against the right certificate". A human types the card and clicks
Submit → *Yes, Continue*.

The payment-run recorder respects the same line: it records which controls the
operator used, never a value they typed, and a field that reads as a payment
instrument (`/card|cvv|cvc|security code|expir|cardholder|pan/`) is not even
described — only that a redacted field was touched.

## Stage 3–4: the documented BeSwift flow

From the ePayment User Guide, with the automation notes that matter.

### Raise the payment order

| # | Step | Automation note |
| --- | --- | --- |
| 1 | Left menu → expand **Online Payment** → **Online Payment Order** | A menu route, not the certificate form. Likely a hash route, so the content script survives it. |
| 2 | Select the **Trader TIN** from the dropdown | Same Vuetify autocomplete pattern as Applicant TIN on the certificate — `pickByLabel` should apply. Trader name defaults in. |
| 3 | Expand **LPCO Application** → **Add LPCO Application** | Opens a dialog, same shape as the item dialog — `openItemDialog`'s approach applies. |
| 4 | Enter **serial year** | The registration year, e.g. `2026`. |
| 5 | Select **serial code** (`CER`, `PER`) | `CER` for an eCOO certificate. |
| 6 | Enter **serial number** and Tab | This is the Registration Reference number from submit. `submitCertificate` already reads and reports it as `registrationReference`, so the payment order can be raised from job state with no re-keying. |
| 7 | Description / units / amount auto-populate | Read back and check against the fee the certificate showed — this is the natural place to catch a wrong serial. |
| 8 | Save with the check at the top of the dialog | Same "save the dialog" pattern as an item line. |

### Add the payment method and verify

| # | Step | Automation note |
| --- | --- | --- |
| 9 | **Payment Methods** → **Add Payment Method** | Dialog. |
| 10 | Type = **EZpay**, save with the check top-right | Single fixed value. |
| 11 | Payment type and amount payable return to the form | Read back; this is the amount about to be charged. Worth a checkpoint. |
| 12 | Form Action → **Verify Document** → **Proceed** | Same Form Action machinery `clickFormAction` already drives on the certificate. |
| 13 | Form Action → **Pay Now** | The point of no return for the automation — this leaves BeSwift. Should be an explicit operator go-ahead, same as Submit. |

### EZpay (manual)

14. **Checkout as Guest**
15. Payment option tab → **Next**
16. Card holder name, card number, expiry month/year, CVV — **typed by a human**
17. Billing address, city, country, zip code
18. **Submit** → **Yes, Continue** → success → **OK**

Steps 14–15 and 17 are not card data and could in principle be automated, but
they live on EZpay, which this extension deliberately does not run on. Adding
EZpay to `host_permissions` to save four clicks either side of a card entry is
not a trade worth making.

## What is still missing

Every step above is a *documented* step, not an observed control. The guide
describes menus and buttons in prose and pictures; it does not give selectors,
and BeSwift's markup has already burned this project once (label-only fields
that no attribute-based finder could see — see `labelTextsForInput`). Writing
stages 3–4 from the prose would be guessing, at a live payment portal.

So the missing input is **one recorded payment run**:

1. Run a certificate through to submit with the beta extension.
2. At the "Certificate submitted" pause, choose **Record my payment run**.
3. Pay it by hand as normal.

The recorder files batches as `delivery.co_fill_resolutions` rows with
`source = 'payment-capture'`, each `note` holding a JSON array of steps:
`{ n, at, kind, route, control }`, where `kind` is `click` or `field`, `route`
is the SPA path/hash, and `control` is the tag, id, classes, role, visible text
and label text of what was used. Read them back with:

```sql
SELECT created_at, field, section, note
FROM delivery.co_fill_resolutions
WHERE source = N'payment-capture'
ORDER BY created_at;
```

Recording stops on its own when the operator leaves BeSwift for EZpay, when
they press **Stop recording**, or after twenty minutes.

With one recording in hand, stages 3–4 become the same kind of code as
`fillHeader` — `setByLabel` / `pickByLabel` against known labels, dialogs opened
and saved the way item lines already are, an operator go-ahead before **Pay
Now**, and a pause with the attention signal when a control cannot be found.

## Job status vocabulary

`submitted` is terminal, alongside `filled_review`, `error` and `cancelled`.
A run that submits reports `submitted` with
`details.registrationReference`; the commercial invoice is archived at either
terminal state. There is no payment status yet — when stages 3–4 land, the
obvious additions are `payment_raised` (order verified, before Pay Now) and
`paid` (confirmed on return from EZpay), both non-terminal until the EZpay
result is actually observed rather than assumed.
