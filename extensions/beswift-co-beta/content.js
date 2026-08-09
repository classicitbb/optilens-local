(function () {
  const HUMAN_DELAY = {
    clickMin: 220,
    clickMax: 620,
    typeMin: 55,
    typeMax: 145,
    fieldMin: 380,
    fieldMax: 900
  };

  // BeSwift's Sign In flow spans three separate page loads (confirmed live):
  //   1. Home page (training.beswift.gov.bb) — click Sign In.
  //   2. Real cross-origin OAuth redirect to a Keycloak login page
  //      (sso.training.beswift.gov.bb) — this is a genuine navigation, so it
  //      fully unloads this script; there is no way to "wait" across it in
  //      the same execution.
  //   3. Redirect back to the home page, now authenticated.
  // Each step below is therefore a fresh, stateless content.js injection,
  // orchestrated by background.js watching tab navigation between steps
  // rather than one continuous script that assumes it survives the redirect.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "clickSignIn") {
      handleClickSignIn().then((result) => sendResponse({ ok: true, ...result })).catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });
      return true;
    }
    if (message?.type === "fillLogin") {
      handleFillLogin(message).then(() => sendResponse({ ok: true })).catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });
      return true;
    }
    if (message?.type === "fillBeswiftCo") {
      // Fire-and-forget: respond immediately instead of holding the message
      // channel open for the entire multi-minute fill. Holding it open meant
      // any tab navigation/close during a review pause tore the channel down
      // and background.js reported the job as "error" even though the fill had
      // paused exactly as designed (seen live 2026-08-06: header filled, job
      // paused for review, operator closed the tab, job flagged errored with
      // "message channel closed"). Success is already reported server-side by
      // runFill itself (filled_review); errors are now reported here too.
      sendResponse({ ok: true, started: true });
      runFill(message).catch(async (error) => {
        try {
          await report(message.baseUrl, message.job.automationJobId, "error", error.message || "BeSwift fill failed.");
        } catch { /* reporting must not mask the original failure */ }
        showBanner(`OptiLens BeSwift fill stopped: ${error.message || "unknown error"}`);
      });
      return false;
    }
    return false;
  });

  async function runFill(ctx) {
    const payload = ctx.payload.payload;
    // Wire up the data-driven positional hints (#2) and expose ctx to the
    // reconciliation/learning helpers so they can append to the job log_json.
    fillCtx = ctx;
    indexSuggested.clear();
    optionIndexHints = { ...OPTION_INDEX_HINTS_FALLBACK, ...(payload.optionIndexHints || {}) };
    await ensureOnCertificateForm();
    await report(ctx.baseUrl, ctx.job.automationJobId, "filling", "Signed in. Filling available fields.");
    await fillHeader(ctx, payload);
    // Blank-field sweep (refinement 2026-08-08): re-read the header's typed
    // text fields against the payload before the mandatory review pause, so a
    // silently-skipped field (see setByLabel's loud-miss path) is named in the
    // pause banner and prefilled into the resolution form instead of relying
    // on the operator to spot it (they logged "stuck on this field" for a
    // blank Freight Cost on 2026-08-06).
    const headerBlanks = sweepHeaderBlanks(payload);
    let headerPauseReason =
      "Header filled (Applicant/Exporter/Importer/Producer/Consignee/Transport/Invoice). " +
      "Verify these sections before Items are added — Importer scoping and the Applicant TIN pick are the parts most " +
      "likely to need a manual fix. Resume when ready to continue.";
    let headerPauseMeta = {};
    if (headerBlanks.length) {
      const list = headerBlanks.map((b) => `${b.label} (expected "${b.expected}")`).join(", ");
      headerPauseReason = `STILL BLANK after header fill: ${list}. Fill these manually before resuming. ` + headerPauseReason;
      headerPauseMeta = { field: headerBlanks[0].label, expected: headerBlanks[0].expected };
      await checkpoint(ctx, `Header blank-field sweep: ${headerBlanks.length} field(s) still blank — ${list}.`, { blanks: headerBlanks });
    } else {
      await checkpoint(ctx, "Header blank-field sweep: all expected text fields carry a value.");
    }
    await pauseForInteraction(ctx, headerPauseReason, headerBlanks.length ? findByAny([headerBlanks[0].label]) : undefined, headerPauseMeta);
    await fillItems(ctx, payload);
    await report(ctx.baseUrl, ctx.job.automationJobId, "filled_review", "Form fill complete. Review and submit manually.");
    // Detach chrome.debugger now that pickByLabel is done using it — leaves
    // the tab in a normal, non-debugged state (removing Chrome's "this
    // extension started debugging this browser" banner) before handing the
    // certificate back to a human for review/submit.
    chrome.runtime.sendMessage({ type: "cdpDetach" }, () => void chrome.runtime.lastError);
    showBanner("OptiLens BeSwift fill complete. Review the certificate before submitting.");
  }

  async function ensureOnCertificateForm() {
    // After sign-in we land back on the home page, not the new-certificate
    // form — it lives at a separate hash route. Confirmed live that this is
    // a client-side (Vue Router hash-mode) navigation only, no full page
    // reload, so this content script instance survives it; just have to
    // wait for the form to actually render afterward (also confirmed live —
    // it can take a few seconds after the hash changes).
    const targetPath = "/lpco/certificates/new";
    if (!location.hash.includes(targetPath)) {
      location.hash = `#${targetPath}`;
    }
    const found = await waitFor(() => findByAny(["applicant reference"]), 10000, 300);
    if (!found) {
      throw new Error(`The new certificate form never appeared at ${targetPath}.`);
    }
  }

  function findSignInButton() {
    // BeSwift's home page currently exposes two possible Sign In triggers:
    //   <a class="btn btn-trial router-link-active"><span> Sign In </span></a>
    //   <span class="btn btn-border-filled"> Sign In </span>
    // Prefer an exact (trimmed) text match on one of these "btn"-styled
    // elements first, falling back to a looser substring match anywhere on
    // the page if the markup changes again.
    const clickable = [...document.querySelectorAll("a.btn, span.btn, button.btn")];
    const exact = clickable.find((el) => (el.textContent || "").trim().toLowerCase() === "sign in");
    if (exact) return exact;

    return [...document.querySelectorAll("button, a, span")]
      .find((el) => /sign in|log in/i.test(el.textContent || ""));
  }

  async function handleClickSignIn() {
    // Poll for either a Sign In button (need to log in), the actual CO
    // application form, or a signed-in BeSwift app shell. The last case is
    // important for concurrent automation: each claim opens its own fresh
    // certificate-route tab, and if the browser session is already valid the
    // app may render the authenticated shell before this exact form route has
    // finished mounting. Treat that as authenticated and let runFill()
    // navigate/wait for the certificate form.
    const result = await waitFor(() => {
      if (isSsoLoginPage()) return { type: "sso" };
      const btn = findSignInButton();
      if (btn) return { type: "button", el: btn };
      if (findByAny(["applicant reference", "customer order no"])) return { type: "already" };
      if (isSignedInBeswiftShell()) return { type: "already" };
      return null;
    }, 10000, 300);

    if (!result) {
      throw new Error("Could not find a Sign In button or the BeSwift form on this page.");
    }
    if (result.type === "already") {
      return { alreadySignedIn: true };
    }
    if (result.type === "sso") {
      return { alreadySignedIn: false };
    }
    await cdpClickElement(result.el);
    return { alreadySignedIn: false };
  }

  function isSsoLoginPage() {
    return /^https:\/\/sso\./i.test(location.href)
      && Boolean(document.querySelector("input#username, input[name='username'], input[type='password']"));
  }

  function isSignedInBeswiftShell() {
    if (!/^https:\/\/(?:training\.)?beswift\.gov\.bb/i.test(location.href)) return false;
    if (findSignInButton()) return false;

    const text = document.body?.innerText || "";
    const hasAuthenticatedNav = /LPCO Applications|My Account|Dashboards|Online Payment|Query|Reports/i.test(text);
    const hasUserMenu = Boolean(document.querySelector(".v-avatar, .v-menu, [aria-label*='account' i], [aria-label*='profile' i]"));
    return hasAuthenticatedNav && hasUserMenu;
  }

  async function handleFillLogin({ username, password }) {
    const found = await waitFor(() => {
      const u = document.querySelector("input#username, input[name='username']") || findByAny(["username", "user name", "login", "email"]);
      const p = document.querySelector("input[type='password']");
      return u && p ? { u, p } : null;
    }, 10000, 300);

    if (!found) {
      throw new Error("The BeSwift sign-in form never appeared.");
    }
    await humanTypeElement(found.u, username);
    await humanTypeElement(found.p, password);
    const submit = document.querySelector("#kc-login, button[type='submit'], input[type='submit']")
      || [...document.querySelectorAll("button,input[type='submit']")].find((el) => /login|sign in|submit/i.test(el.textContent || el.value || ""));
    if (!submit) {
      throw new Error("Could not find the BeSwift sign-in submit button.");
    }
    // Clicking Keycloak's submit button starts a full page navigation. If the
    // click happens before this message handler can answer background.js,
    // Chrome tears down the content-script channel and the job is marked as
    // "A listener indicated an asynchronous response..." even though the
    // login click itself was correct. Schedule the navigation so the message
    // response can be sent first.
    setTimeout(() => {
      cdpClickElement(submit).catch(() => submit.click());
    }, randomDelayMs(650, 1200));
  }

  function waitFor(fn, timeoutMs, intervalMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const result = fn();
        if (result) return resolve(result);
        if (Date.now() - start >= timeoutMs) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  async function fillHeader(ctx, payload) {
    const t = payload.transport || {};
    const inv = payload.invoiceDetails || {};
    const imp = payload.importer || {};

    // General Information — Regime/Service Type are fixed values, and the
    // rest of the form (Applicant/Exporter/Importer/Producer/Consignee/
    // Transport/Invoice sections) doesn't even render until both are picked
    // (confirmed live — the form is empty except these two fields at first).
    // Regime and Service Type are the two known "silent failure" fields —
    // history here (see the pickByLabel comment below) is that a bad pick can
    // still leave the right-looking text sitting in the input while the
    // component's real v-model/selection never committed, and nothing
    // downstream ever renders as a result — with no exception thrown anywhere.
    // Rather than trusting the pick and finding out five sections later that
    // the form is empty, verify the concrete, known side effect of a real
    // commit (the next field/section actually becoming available) and pause
    // for a manual fix immediately if it doesn't show up.
    await dismissBlockingOverlay();
    if (!(await waitFor(() => isFieldEditable("Regime"), 10000, 200))) {
      await dismissBlockingOverlay();
    }
    if (!(await waitFor(() => isFieldEditable("Regime"), 3000, 200))) {
      await pauseForFieldFix(ctx, findByAny(["regime"]), "Regime", payload.regime || "Export",
        "Regime is still disabled/covered after the certificate form appeared.");
    }
    await pickByLabel("Regime", payload.regime || "Export");
    if (!(await waitFor(() => isFieldEditable("Service Type"), 3000, 200))) {
      await pauseForFieldFix(ctx, findByAny(["regime"]), "Regime", payload.regime || "Export",
        "Service Type is still disabled/absent after picking Regime — the dropdown selection likely didn't commit.");
    }
    await pickByLabel("Service Type", payload.serviceType || "Certificate of Origin - CARICOM");
    if (!(await waitFor(() => findSectionContainer("Importer Details"), 5000, 200))) {
      await pauseForFieldFix(ctx, findByAny(["service type"]), "Service Type", payload.serviceType || "Certificate of Origin - CARICOM",
        "The Exporter/Importer/Producer/Consignee sections never appeared after picking Service Type — the dropdown selection likely didn't commit.");
    }
    await setByLabel("Applicant Reference", payload.applicantReference);
    await setByLabel("Contact Name", payload.applicant?.contacts?.[0]?.name);
    await setByLabel("Contact Mobile No", payload.applicant?.contacts?.[0]?.mobile);
    await setByLabel("Contact Email", payload.applicant?.contacts?.[0]?.email);
    await checkpoint(ctx, "General Information filled (Regime/Service Type/Applicant Reference/Contact).");

    // Applicant Details — Applicant Type defaults to "Personal" (confirmed live:
    // prefills the logged-in BeSwift user's own individual TIN/name), but Classic
    // Visions must file as "Other" (a company). Switching to "Other" clears those
    // fields and turns TIN into a dropdown with exactly one option (CONFIG.company.tin);
    // selecting it auto-fills Name/Address/Country/Parish, so nothing else needs
    // to be set here. Scope both the radio click and the TIN pick to the Applicant
    // Details section — "Other" and "TIN" both also appear in Exporter/Producer/
    // Consignee sections further down the form.
    const applicantSection = requireSectionContainer("Applicant Details");
    if ((payload.applicantType || "Other").toLowerCase() === "other") {
      await clickByText("Other", applicantSection);
      await humanDelay(450, 900);
      await pickExistingOptionByLabel("TIN", payload.applicant?.tin, applicantSection);
    }
    await checkpoint(ctx, "Applicant Details set (Applicant Type=Other, TIN picked).");

    // Exporter/Supplier Details defaults to "Same as Applicant" checked
    // (confirmed live) — this click is a no-op safety net in case it isn't.
    const exporterSection = requireSectionContainer("Exporter/Supplier Details");
    await clickByText("Same as Applicant", exporterSection);
    await checkpoint(ctx, "Exporter/Supplier Details: Same as Applicant confirmed.");

    // Importer Details is a separate section (Name/Address/Country only) that
    // sits side-by-side with Exporter/Supplier — must scope to it specifically,
    // since Applicant/Exporter/Producer/Consignee all expose fields with the
    // exact same labels (confirmed live: Name/Address/Country repeat 4+ times).
    const importerSection = requireSectionContainer("Importer Details");
    await setByLabel("Name", imp.name, importerSection);
    await setByLabel("Address", imp.address, importerSection);
    await pickByLabel("Country", imp.country, importerSection);
    await checkpoint(ctx, "Importer Details filled.", { importer: imp });

    // Producer/Manufacturer Details — assume a single producer (Classic
    // Visions itself) and reuse the Exporter/Supplier details for it.
    const producerSection = requireSectionContainer("Producer/Manufacturer Details");
    await clickByText("Single", producerSection);
    await clickByText("Same as Exporter", producerSection);
    await checkpoint(ctx, "Producer/Manufacturer Details: Single + Same as Exporter confirmed.");

    // Consignee Details — same company as Importer.
    const consigneeSection = requireSectionContainer("Consignee Details");
    await clickByText("Same As Importer", consigneeSection);
    await checkpoint(ctx, "Consignee Details: Same As Importer confirmed.");

    // Transport Information
    await setByLabel("Shipping Marks", (t.shippingMarks || "").slice(0, 35));
    await setByLabel("Shipping Date", t.shippingDate);
    await setByLabel("Other Transport Information", t.trackingNumber ? `AWB: ${t.trackingNumber}` : "");
    await pickByLabel("Port Of Loading", t.portOfLoading || "GRANTLEY");
    await pickByLabel("Country Of Destination", t.countryOfDestination);
    if (!(await waitFor(() => isFieldEditable("Port Of Discharge"), 5000, 200))) {
      await pauseForFieldFix(ctx, findByAny(["country of destination"]), "Country Of Destination", t.countryOfDestination,
        "Port Of Discharge is still disabled after picking Country Of Destination — the country selection likely didn't commit yet.");
    }
    await pickByLabel("Port Of Discharge", t.portOfDischarge);
    await pickByLabel("Mode Of Transport", t.modeOfTransport);
    if (!(await waitFor(() => isFieldEditable("Carrier"), 5000, 200))) {
      await pauseForFieldFix(ctx, findByAny(["mode of transport"]), "Mode Of Transport", t.modeOfTransport,
        "Carrier is still disabled after picking Mode Of Transport — the transport-mode selection likely didn't commit yet.");
    }
    await pickByLabel("Carrier", t.carrier);
    await pickByLabel("Delivery Terms", t.deliveryTerms || "Free on Board");
    await checkpoint(ctx, "Transport Information filled.", { transport: t });

    // Invoice Details
    await pickByLabel("Currency", inv.currency === "BB$" ? "BARBADOS DOLLAR" : inv.currency);
    await setByLabel("Customer Order No.", inv.customerOrderNo);
    // Presenting Bank is a dropdown whose first option is always our own bank,
    // so select the top option rather than typing a value in.
    await pickFirstOptionByLabel("Presenting Bank");
    await setByLabel("Cube Quantity", inv.cubeQuantity);
    await setByLabel("Freight Cost", inv.freightCost);
    await checkpoint(ctx, "Invoice Details filled.", { invoiceDetails: inv });
  }

  // Which header TEXT fields (typed via setByLabel) should carry a payload
  // value once fillHeader is done. Dropdown picks are excluded on purpose:
  // pickByLabel has its own commit checks. Consumed by runFill's post-header
  // blank-field sweep; `resolved:false` on an entry means even the sweep's
  // findByAny could not locate the input -- i.e. a label-resolution gap, not
  // a value that failed to commit.
  function sweepHeaderBlanks(payload) {
    const t = payload.transport || {};
    const inv = payload.invoiceDetails || {};
    const expectations = [
      ["Shipping Marks", (t.shippingMarks || "").slice(0, 35)],
      ["Shipping Date", t.shippingDate],
      ["Customer Order No.", inv.customerOrderNo],
      ["Cube Quantity", inv.cubeQuantity],
      ["Freight Cost", inv.freightCost]
    ];
    const blanks = [];
    for (const [label, expected] of expectations) {
      if (expected === undefined || expected === null || expected === "") continue;
      const el = findByAny([label]);
      const current = el ? String(el.value || "").trim() : "";
      if (!current) blanks.push({ label, expected: String(expected), resolved: Boolean(el) });
    }
    return blanks;
  }

  async function fillItems(ctx, payload) {
    const items = payload.items || [];
    // Double-entry guard for items (#1): if the certificate already lists saved
    // item rows (e.g. a re-run after a reload, or resuming a partially-filled
    // form), resume past them instead of adding duplicate customs lines.
    const existingRows = countExistingItemRows();
    let startIndex = 0;
    if (items.length && existingRows >= items.length) {
      await checkpoint(ctx, `All ${items.length} item(s) already present on the certificate (${existingRows} row(s) found) — skipping item entry (double-entry guard).`, { existingItemRows: existingRows });
      pushFeed(`Items already present (${existingRows}) — nothing to add.`, "info");
      return;
    }
    if (existingRows > 0) {
      startIndex = existingRows;
      await checkpoint(ctx, `Detected ${existingRows} item row(s) already on the certificate — resuming at item ${existingRows + 1}/${items.length} (double-entry guard).`, { existingItemRows: existingRows });
      pushFeed(`Resuming items at ${existingRows + 1}/${items.length}; ${existingRows} already present.`, "info");
    }
    await checkpoint(ctx, `Starting Items (${items.length} item(s) to add, ${startIndex} already present).`);
    for (let i = startIndex; i < items.length; i += 1) {
      const item = items[i];
      // Open the item dialog and WAIT until it is genuinely mounted (retrying
      // the click) instead of a fixed 900ms + silent fallback to document.
      // Root-caused live on production (2026-08-06, shipment 11274): the
      // production portal mounts the dialog slower than training, the old
      // fallback made every dialog-field lookup miss silently, and the first
      // hard check ("Unit of Measure did not commit") killed the run ~2s
      // after "Starting Items".
      let root = await openItemDialog(ctx, i + 1, items.length);
      if (!root) {
        await pauseForInteraction(
          ctx,
          `Item ${i + 1}/${items.length}: the Add Item dialog did not open after repeated clicks. ` +
          "Open it manually (click + Add Item), then Resume — the fill will continue inside the dialog."
        );
        root = document.querySelector(".v-dialog--active") || null;
        if (!root) {
          showBanner(`Item dialog still not open after resume; add item ${i + 1} manually from the OptiLens payload.`);
          await checkpoint(ctx, `Item ${i + 1}/${items.length}: dialog still absent after resume — stopped for manual add.`);
          return;
        }
      }
      // Confirmed live: unlike every other field on this form, "Commodity" is a
      // plain text input, not a Vuetify autocomplete — no dropdown opens on
      // click or on typing. The only way seen live to get BeSwift's own
      // enriched "CODE | - Description" value into the field is clicking its
      // search-icon button, searching the code in a separate modal, and
      // picking the row from a results table. That modal flow wasn't
      // reproduced here (out of scope for a first pass) — this just types the
      // bare HS code via setByLabel instead of pickByLabel, which avoids
      // wasting ~8s on pickByLabel's dropdown-wait/retry logic against a field
      // that never opens one. Whether BeSwift's save validation accepts a bare
      // code without going through that modal was NOT confirmed live — this is
      // exactly the kind of thing to check during the pause below before Save
      // is clicked.
      await setCommodityCode(ctx, root, item.hsCode, i + 1, items.length);
      await setByLabel("Commercial Description", item.commercialDescription, root);
      await clickByText(payload.origin?.commodityType || "Manufactured", root);
      await setByLabel("Manufacturer Name", payload.producer?.name, root, { acceptExistingDisabled: true });
      await pickByLabel("Country of Origin", payload.origin?.countryOfOrigin, root);
      await pickByLabel("Rule Of Origin", payload.origin?.ruleOfOrigin || "Percentage Value", root);
      await pickByLabel("Origin Criterion", payload.origin?.originCriterion || "L", root);
      await setByLabel("Gross Weight", item.weightKg, root);
      await setByLabel("Invoice #", payload.invoiceDetails?.invoiceNumbers, root);
      await setByLabel("Invoice Date", payload.invoiceDetails?.invoiceDate, root);
      await setByLabel("Number of Package", payload.packaging?.numberOfPackages, root);
      await pickByLabel("Package Type", payload.packaging?.packageType || "Bag, plastic", root);
      await setByLabel("Item Quantity", item.quantity, root);
      await refreshFieldOptionsByLabel("Unit of Measure", root);
      if (!fieldHasValue("Unit of Measure", root)) {
        await pickByLabel("Unit of Measure", "Number of Units", root);
      }
      if (!fieldHasValue("Unit of Measure", root)) {
        // Pause instead of hard-stop: the operator can pick the unit in the
        // open dialog and Resume, keeping the rest of the run alive.
        await pauseForFieldFix(ctx, findByAny(["unit of measure"], root), "Unit of Measure", "Number of Units",
          "Unit of Measure did not commit after retries — pick it manually in the item dialog, then Resume.");
      }
      await setByLabel("Unit Cost", item.unitCost, root);
      // Verify the required item dropdowns actually committed; retry any that
      // stayed blank (a different entry method each time via pickByLabel) before
      // Save, and surface anything still blank to the operator/resolution feed.
      await auditAndRetryItemFields(ctx, root, i, items.length, [
        { label: "Country of Origin", value: payload.origin?.countryOfOrigin },
        { label: "Rule Of Origin", value: payload.origin?.ruleOfOrigin || "Percentage Value" },
        { label: "Origin Criterion", value: payload.origin?.originCriterion || "L" },
        { label: "Package Type", value: payload.packaging?.packageType || "Bag, plastic" },
        { label: "Unit of Measure", value: "Number of Units" }
      ]);
      await checkpoint(ctx, `Item ${i + 1}/${items.length}: fields filled, about to Save.`, { hsCode: item.hsCode, description: item.commercialDescription });
      // A rejected Save used to abort the whole run (seen live 2026-08-06:
      // item 2 of 8 failed BeSwift validation and items 3–8 never ran). Pause
      // and retry instead — the dialog is still open with everything else
      // filled, so the operator only has to fix the one flagged field.
      try {
        await clickDialogSave(root);
      } catch (error) {
        await pauseForInteraction(
          ctx,
          `Item ${i + 1}/${items.length}: BeSwift rejected Save — ${error.message} ` +
          "Fix the flagged field(s) in the open dialog, then Resume (I'll click Save again).",
          root,
          { item: i + 1, saveError: error.message }
        );
        try {
          await clickDialogSave(root);
        } catch (retryError) {
          await pauseForInteraction(
            ctx,
            `Item ${i + 1}/${items.length}: Save still rejected — ${retryError.message} ` +
            "Save this item manually in the dialog, then Resume to continue with the next item.",
            root,
            { item: i + 1, saveError: retryError.message, secondAttempt: true }
          );
        }
      }
      await wait(900);
      await checkpoint(ctx, `Item ${i + 1}/${items.length}: Save clicked.`);
    }
    await checkpoint(ctx, `All ${items.length} item(s) processed.`);
  }

  // Commodity is BeSwift's HS-code lookup field. Root-caused live on production
  // (2026-08-06, shipment 11274): our catalog stores HS codes in two shapes —
  // bare 8-digit ("90015000") and dotted ("9001.50.00.000"). Only the bare form
  // resolves; the dotted form leaves the field showing "[object Object]" with a
  // "No data found" hint, AND — because BeSwift derives the Unit of Measure
  // option list from the resolved commodity — Unit of Measure then renders "No
  // data available", so Save fails with "The Unit of Measure field is required".
  // One unresolved code, two symptoms. So: try progressively normalized
  // variants until the field stops reporting "No data found".
  function hsCodeVariants(raw) {
    const digits = String(raw || "").replace(/\D/g, "");
    const variants = [String(raw || "").trim()];
    if (digits) {
      variants.push(digits);
      for (const len of [10, 8, 6]) {
        if (digits.length > len) variants.push(digits.slice(0, len));
      }
    }
    return [...new Set(variants.filter(Boolean))];
  }

  // BeSwift renders "No data found" under the Commodity field when the typed
  // code matched nothing. Scoped to the field's own v-input wrapper so an
  // unrelated empty list elsewhere in the dialog can't trigger a false positive.
  function commodityUnresolved(el) {
    const wrapper = el?.closest(".v-input, .v-text-field") || el?.parentElement;
    if (!wrapper) return false;
    return /no data (found|available)/i.test(wrapper.textContent || "");
  }

  async function setCommodityCode(ctx, root, hsCode, itemNo, total) {
    const el = findByAny(["commodity"], root);
    if (!el) return false;
    const variants = hsCodeVariants(hsCode);
    for (const [index, candidate] of variants.entries()) {
      if (index > 0) {
        // Clear whatever the previous, unresolved attempt left behind.
        el.focus();
        el.select?.();
        await cdpTypeText("");
        setReadonlyFieldValue(el, "");
        await wait(250);
      }
      await setByLabel("Commodity", candidate, root);
      await wait(900);
      if (!commodityUnresolved(el)) {
        if (index > 0) {
          await checkpoint(ctx, `Item ${itemNo}/${total}: HS code "${hsCode}" did not resolve; used normalized "${candidate}" instead.`,
            { field: "Commodity", original: hsCode, used: candidate, normalized: true });
          pushFeed(`HS code normalized: "${hsCode}" -> "${candidate}".`, "info");
        }
        return true;
      }
    }
    await pauseForFieldFix(ctx, el, "Commodity", hsCode,
      `BeSwift reported "No data found" for every form of this HS code (tried: ${variants.join(", ")}). ` +
      "Pick the commodity manually via the search icon, then Resume. Note: Unit of Measure stays empty until the commodity resolves.");
    return false;
  }

  // Click Add Item and wait for the item dialog to actually mount — a visible
  // .v-dialog--active that contains the Commodity field. Retries the click up
  // to 3 times with an 8s mount-wait each, checkpointing every miss so the
  // live feed shows exactly where an open attempt stalled.
  async function openItemDialog(ctx, itemNo, total) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const dialogAlready = document.querySelector(".v-dialog--active");
      if (dialogAlready && isVisibleElement(dialogAlready) && findByAny(["commodity"], dialogAlready)) return dialogAlready;
      const clicked = await clickAddItem();
      if (!clicked) {
        await checkpoint(ctx, `Item ${itemNo}/${total}: Add Item button not found on the page (attempt ${attempt}).`);
        return null;
      }
      const dialog = await waitFor(() => {
        const d = document.querySelector(".v-dialog--active");
        return d && isVisibleElement(d) && findByAny(["commodity"], d) ? d : null;
      }, 8000, 250);
      if (dialog) {
        if (attempt > 1) await checkpoint(ctx, `Item ${itemNo}/${total}: item dialog opened on attempt ${attempt}.`);
        return dialog;
      }
      await checkpoint(ctx, `Item ${itemNo}/${total}: Add Item clicked (attempt ${attempt}) but the dialog did not mount within 8s — retrying.`);
    }
    return null;
  }

  async function clickAddItem() {
    const button = [...document.querySelectorAll("button")]
      .find((el) => /^(add item|add commodity)$/i.test((el.textContent || "").trim()) && !el.disabled);
    if (!button) return false;
    await cdpClickElement(button);
    await humanDelay(500, 950);
    return true;
  }

  async function clickDialogSave(root) {
    const buttons = [...root.querySelectorAll("button")];
    const save = buttons.find((el) => /save|ok|add|check|✓/i.test(el.textContent || el.getAttribute("aria-label") || "") && !el.disabled);
    if (save) {
      const dialog = root.closest?.(".v-dialog") || root;
      await cdpClickElement(save);
      await humanDelay(600, 1100);
      const yes = await waitFor(() => findVisibleButtonByText("Yes"), 5000, 200);
      if (yes) {
        await cdpClickElement(yes);
        await waitFor(() => !findVisibleButtonByText("Yes"), 10000, 250);
        await humanDelay(900, 1600);
      }
      const closed = await waitFor(() => !isVisibleElement(dialog), 15000, 300);
      if (!closed) {
        const validation = [...dialog.querySelectorAll(".v-messages__message")]
          .map((el) => (el.textContent || "").trim())
          .filter(Boolean)
          .join("; ");
        throw new Error(validation ? `Item dialog stayed open after Save: ${validation}` : "Item dialog stayed open after Save.");
      }
    }
  }

  async function setByLabel(label, value, root = document, options = {}) {
    if (value === undefined || value === null || value === "") {
      // Loud-skip (refinement 2026-08-08): an empty payload value is a valid
      // reason to leave a field alone, but say so in the feed instead of
      // vanishing -- a blank left by a missing value looked identical to a
      // resolver miss from the operator's side.
      pushFeed(`${label}: no value in payload -- leaving blank.`, "info");
      return false;
    }
    const el = findByAny([label], root);
    if (!el) {
      // Loud-miss (refinement 2026-08-08, from co_fill_resolutions id 2):
      // findByAny failing used to `return false` silently, leaving the field
      // blank with no trace (root cause of the 2026-08-06 "Freight Cost stuck
      // on this field" manual fix). Surface the miss and snapshot the labels
      // actually on the page so the next failed run self-diagnoses which
      // label text BeSwift really renders.
      const msg = `${label}: could not resolve an input for this label -- field left blank (expected "${value}").`;
      pushFeed(msg, "warn");
      if (fillCtx) {
        try { await checkpoint(fillCtx, msg, { field: label, expected: String(value), miss: "findByAny", labelsOnPage: visibleFieldLabels(root) }); } catch { /* logging never breaks the fill */ }
      }
      return false;
    }
    if (!isEditable(el)) {
      // isEditable's elementFromPoint check false-negatives when the field is
      // scrolled out of view, under a sticky header, or beneath an open
      // menu/date-picker scrim — close any overlay, scroll it into view, and
      // re-check before concluding anything (root cause of the recurring
      // "Shipping Date is not editable" errors, 2026-08-06).
      await dismissOpenOverlays();
      el.scrollIntoView({ block: "center", behavior: "instant" });
      await wait(250);
      // BeSwift enables some fields only after a sibling's async lookup
      // settles, so give it a real window rather than one instant re-check.
      await waitFor(() => isEditable(el), 5000, 250);
    }
    if (!isEditable(el)) {
      const existing = String(el.value || "").trim();
      if (options.acceptExistingDisabled && existing) return true;
      // Readonly-but-enabled is Vuetify's date-picker pattern: the text input
      // is readonly and the value normally arrives via the picker overlay.
      // Vue still listens for the input event, so committing the model
      // programmatically works without driving the calendar UI.
      if (el.readOnly && !el.disabled) {
        const committed = setReadonlyFieldValue(el, String(value));
        const msg = `${label} is readonly (date-picker style); ${committed ? "set programmatically via input event" : "programmatic set did NOT commit"}.`;
        pushFeed(msg, committed ? "info" : "warn");
        if (fillCtx) {
          try { await checkpoint(fillCtx, msg, { field: label, value: String(value), method: "readonly_program_set", committed }); } catch { /* logging never breaks the fill */ }
        }
        if (committed) return true;
      }
      throw new Error(`${label} is not editable. ${describeUneditable(el)}`);
    }
    // Double-entry guard (#1): don't re-type into a field that's already filled.
    // Matches payload -> skip silently; differs -> leave it and flag the mismatch.
    const existingText = String(el.value || "").trim();
    if (existingText) {
      if (valuesMatch(existingText, value)) return true;
      await flagAlreadyFilled(label, existingText, value);
      return true;
    }
    await humanTypeElement(el, String(value));
    return true;
  }

  // Set a readonly (but enabled) input's value through the native setter and
  // fire input/change so Vue's v-model picks it up — the standard workaround
  // for Vuetify date-picker text fields, whose readonly attribute only blocks
  // typed keystrokes, not programmatic events. Returns whether the value stuck.
  function setReadonlyFieldValue(el, value) {
    try {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      el.focus();
      if (setter) setter.call(el, value); else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.blur();
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return String(el.value || "").trim() !== "";
    } catch {
      return false;
    }
  }

  // BeSwift option-list positions for fields where CDP-typed text does NOT filter
  // the Vuetify autocomplete (the full list stays visible), so a positional click
  // is the reliable path. 1-based, mirrors BeSwift's current list order. These are
  // now DATA-DRIVEN (migration 020): the server carries the operator-editable
  // positions in payload.optionIndexHints, and runFill merges them over this
  // built-in fallback. This constant only takes effect when the DB/payload has no
  // hint (offline / pre-020), so both sides degrade to the same known-good order.
  const OPTION_INDEX_HINTS_FALLBACK = {
    "country of origin": 3, // Barbados
    "package type": 18      // Bag, plastic
  };
  // Live, merged map (fallback <- payload). Reassigned at the start of runFill.
  let optionIndexHints = { ...OPTION_INDEX_HINTS_FALLBACK };
  // The active fill's ctx, so reconciliation/learning helpers can append to the
  // job log_json (not just the on-page feed). Set at the start of runFill.
  let fillCtx = null;
  // Per-fill dedupe so a repeated field only logs one index suggestion.
  const indexSuggested = new Set();

  // Loose value equality for double-entry checks: our payload values and
  // BeSwift's committed/display text often differ in case or extra descriptor
  // (e.g. our "L" vs BeSwift "L — wholly produced"), so match on containment
  // either way rather than strict equality.
  function valuesMatch(current, wanted) {
    const c = String(current || "").trim().toLowerCase();
    const w = String(wanted || "").trim().toLowerCase();
    if (!c || !w) return false;
    if (c === w) return true;
    // Short codes (e.g. Origin Criterion "L") must not match by substring —
    // "blister" contains "l" but isn't "L". Require a whole-token match so the
    // guard still recognises "L — wholly produced" while rejecting unrelated
    // values that merely contain the letter.
    if (w.length <= 2 || c.length <= 2) {
      const tokens = c.split(/[^a-z0-9]+/).filter(Boolean);
      const wTokens = w.split(/[^a-z0-9]+/).filter(Boolean);
      return tokens.includes(w) || wTokens.includes(c);
    }
    return c.includes(w) || w.includes(c);
  }

  // The text a field currently holds — the input value, or a Vuetify selection
  // chip/text when the autocomplete shows its choice without an input value.
  function currentFieldText(el) {
    if (!el) return "";
    const v = String(el.value || "").trim();
    if (v) return v;
    const wrapper = el.closest(".v-input, .v-select, .v-autocomplete, .v-text-field");
    const sel = wrapper && wrapper.querySelector(".v-select__selection, .v-select__selection-text, .v-chip");
    return sel ? String(sel.textContent || "").trim() : "";
  }

  // Double-entry guard flag: a field is already filled but with a value that does
  // NOT match the payload. Per Russell's call (2026-07-07): leave the existing
  // value (DOM is source of truth on a re-run) and surface the mismatch on the
  // feed + job log so the operator can decide — never silently overwrite.
  async function flagAlreadyFilled(label, current, wanted) {
    const msg = `${label} already holds "${current}" (expected "${wanted}") — left as-is (double-entry guard).`;
    pushFeed(msg, "warn");
    if (fillCtx) {
      try {
        await checkpoint(fillCtx, msg, { field: label, current, expected: wanted, reconcile: "left_existing" });
      } catch (error) { /* logging must never break the fill */ }
    }
  }

  // Suggest-only position learning (#3): when a positional hint points at the
  // wrong row and we locate where the option actually is in the open list, log a
  // suggestion to update delivery.standards_catalog.beswift_option_index. Never
  // rewrites the hint automatically (Russell's call, 2026-07-07: suggest only).
  async function maybeSuggestOptionIndex(label, observedIndex, hintIndex) {
    const key = String(label || "").toLowerCase().trim();
    if (!key || !observedIndex) return;
    const currentHint = hintIndex || optionIndexHints[key] || null;
    if (currentHint && Number(currentHint) === Number(observedIndex)) return; // hint already correct
    if (indexSuggested.has(key)) return;
    indexSuggested.add(key);
    const msg = `Suggested position: "${label}" found at index ${observedIndex}`
      + (currentHint ? ` (catalog hint is ${currentHint})` : "")
      + ` — set delivery.standards_catalog.beswift_option_index = ${observedIndex} to apply. (suggestion only)`;
    pushFeed(msg, "warn");
    if (fillCtx) {
      try {
        await checkpoint(fillCtx, msg, { field: label, observedIndex, hintIndex: currentHint, suggestion: "beswift_option_index" });
      } catch (error) { /* logging must never break the fill */ }
    }
  }

  // Locate the wanted option by text within the currently-open (unfiltered) list,
  // returning its true 1-based position — the raw signal for maybeSuggestOptionIndex.
  function findOptionByTextInOpenMenu(wanted) {
    const menu = findVisibleDropdownMenu();
    if (!menu) return null;
    const items = [...menu.querySelectorAll(".v-list-item")];
    const w = String(wanted || "").trim().toLowerCase();
    if (!w) return null;
    for (let i = 0; i < items.length; i += 1) {
      const txt = String(items[i].textContent || "").trim().toLowerCase();
      if (txt.includes(w)) return { index: i + 1, el: items[i] };
    }
    return null;
  }

  async function pickByLabel(label, value, root = document, options = {}) {
    if (!value) return false;
    const el = findByAny([label], root);
    if (!el) return false;
    if (!isEditable(el)) {
      // Same transient-overlay false negative as setByLabel — a previously
      // opened menu's scrim must not make the next dropdown look disabled.
      await dismissOpenOverlays();
      el.scrollIntoView({ block: "center", behavior: "instant" });
      await wait(250);
    }
    if (!isEditable(el)) throw new Error(`${label} is not editable. ${describeUneditable(el)}`);
    // Double-entry guard (#1): if the dropdown already committed a selection,
    // don't re-pick. Skip silently when it matches the payload; flag when it
    // doesn't and leave the existing value.
    if (dropdownFieldCommitted(el)) {
      const current = currentFieldText(el);
      if (valuesMatch(current, value)) return true;
      await flagAlreadyFilled(label, current, value);
      return true;
    }
    const indexHint = options.optionIndex
      || optionIndexHints[String(label).toLowerCase().trim()]
      || null;

    // Root-caused live (2026-07-04): this Vuetify autocomplete's dropdown
    // never actually opens from anything a content script can dispatch —
    // el.click(), a full mousedown/mouseup/click MouseEvent sequence,
    // pointerdown/pointerup, even keyboard ArrowDown/Enter. All of those
    // toggle the field wrapper's "is-menu-active" CSS class, but the real
    // .v-menu__content overlay stays at 0x0 with no "active" class — so
    // there's never an option to click. Only a genuinely trusted click (like
    // a real OS-level mouse click) opens it. Earlier direct DOM value writes
    // still put the correct-looking text straight into the input, which is
    // exactly why this failure mode looks
    // like a "stuck" or "not committed" dropdown rather than an obvious
    // error: the field visibly shows the right text, but the component's
    // real selection state — and everything that cascades from it, e.g.
    // Service Type unlocking the rest of the form — never actually happened.
    // Fix: ask background.js to open the field via chrome.debugger (Chrome
    // DevTools Protocol), which injects mouse events the page treats as
    // trusted, same mechanism Puppeteer/Playwright rely on.
    // Try several entry methods and VERIFY the selection committed after each,
    // so a field that stays blank is retried a different way rather than left
    // silently empty (previously it always "return true" even when nothing
    // committed). Method order: type-to-filter → positional click at a known
    // index → retype-and-match → keyboard.
    if (await tryTextPick(el, value)) return true;
    if (indexHint && await tryIndexPick(el, indexHint, value, label)) return true;
    if (await tryTextPick(el, value, { retype: true })) return true;
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    await wait(200);
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    await humanDelay(450, 850);
    return dropdownFieldCommitted(el);
  }

  // Type the value to filter the list, then click the matching option. Returns
  // true only if the field actually committed a selection afterwards.
  async function tryTextPick(el, value, { retype = false } = {}) {
    await openDropdownForElement(el);
    await humanDelay(200, 450);
    selectElementText(el);
    await cdpTypeText(String(value));
    let option = await waitFor(() => findVisibleDropdownOption(value), retype ? 5000 : 3000, 150);
    if (!option && retype) {
      selectElementText(el);
      await cdpTypeText(String(value));
      option = await waitFor(() => findVisibleDropdownOption(value), 4000, 150);
    }
    if (!option) return false;
    await cdpClickElement(option);
    await humanDelay(350, 750);
    return dropdownFieldCommitted(el);
  }

  // Click the Nth option (1-based) in the open list. cdpClickElement scrolls the
  // target into view first, so a below-the-fold option (e.g. #18) still clicks.
  // Falls through (returns false) if the option text clearly doesn't match the
  // expected value, so a reordered list can't silently pick the wrong entry.
  async function tryIndexPick(el, index, value, label = null) {
    await openDropdownForElement(el);
    await humanDelay(200, 450);
    let option = await waitFor(() => findDropdownOptionByIndex(index), 3000, 150);
    if (!option) {
      await openDropdownForElement(el);
      option = await waitFor(() => findDropdownOptionByIndex(index), 2500, 150);
    }
    if (!option) return false;
    const optText = String(option.textContent || "").trim().toLowerCase();
    const wanted = String(value || "").trim().toLowerCase();
    if (wanted && optText && !optText.includes(wanted)) {
      // The hinted position no longer holds the wanted option (BeSwift reordered
      // its list). Locate where it actually is in the still-open list and suggest
      // that position (#3, suggest-only) before falling through to text/keyboard.
      if (label) {
        const found = findOptionByTextInOpenMenu(value);
        if (found) await maybeSuggestOptionIndex(label, found.index, index);
      }
      return false;
    }
    await cdpClickElement(option);
    await humanDelay(350, 750);
    return dropdownFieldCommitted(el);
  }

  function findDropdownOptionByIndex(n) {
    const menu = findVisibleDropdownMenu();
    if (!menu) return null;
    const items = [...menu.querySelectorAll(".v-list-item")];
    return items[n - 1] || null;
  }

  // Has the Vuetify autocomplete actually committed a selection? True if the
  // input holds text or the field shows a selection chip / selection text.
  function dropdownFieldCommitted(el) {
    if (!el) return false;
    if (String(el.value || "").trim()) return true;
    const wrapper = el.closest(".v-input, .v-select, .v-autocomplete, .v-text-field");
    return Boolean(wrapper && wrapper.querySelector(".v-select__selection, .v-select__selection-text, .v-chip"));
  }

  // Post-fill verification for the item dialog: re-check each required dropdown
  // committed a value; retry any blank one (pickByLabel itself cycles entry
  // methods), then report anything still blank to the rolling feed + job log so
  // the operator can fix it during the review pause instead of a bad Save.
  async function auditAndRetryItemFields(ctx, root, itemIndex, itemCount, fields) {
    const stillBlank = [];
    for (const f of fields) {
      if (!f.value) continue;
      let el = findByAny([f.label], root);
      if (el && dropdownFieldCommitted(el)) continue;
      pushFeed(`Item ${itemIndex + 1}/${itemCount}: ${f.label} not committed — retrying.`, "warn");
      try {
        await pickByLabel(f.label, f.value, root);
      } catch (error) {
        pushFeed(`Item ${itemIndex + 1}/${itemCount}: ${f.label} retry error — ${error.message}`, "warn");
      }
      el = findByAny([f.label], root);
      if (!(el && dropdownFieldCommitted(el))) stillBlank.push(f.label);
    }
    if (stillBlank.length) {
      await checkpoint(ctx, `Item ${itemIndex + 1}/${itemCount}: still blank after retry — ${stillBlank.join(", ")}.`, { stillBlank });
    }
    return stillBlank;
  }

  async function pickExistingOptionByLabel(label, value, root = document) {
    if (!value) return false;
    const el = findByAny([label], root);
    if (!el) return false;
    if (!isEditable(el)) throw new Error(`${label} is not editable.`);

    await openDropdownForElement(el);
    await humanDelay(300, 700);

    let option = await waitFor(() => findVisibleDropdownOption(value) || findSingleVisibleDropdownOption(), 5000, 150);
    if (!option) {
      await openDropdownForElement(el);
      option = await waitFor(() => findVisibleDropdownOption(value) || findSingleVisibleDropdownOption(), 3000, 150);
    }
    if (!option) throw new Error(`${label} option "${value}" was not found.`);

    await cdpClickElement(option);
    await humanDelay(650, 1200);
    return true;
  }

  async function openDropdownForElement(el) {
    await cdpClickElement(el);
    if (await waitFor(() => findVisibleDropdownMenu(), 900, 100)) return true;

    const wrapper = el.closest(".v-input, .v-text-field, .v-autocomplete, .v-select") || el.parentElement;
    const append = wrapper?.querySelector(".v-input__append-inner, .v-input__icon, .v-icon");
    if (append) {
      await cdpClickElement(append);
      if (await waitFor(() => findVisibleDropdownMenu(), 1200, 100)) return true;
    }

    if (wrapper) {
      await cdpClickElementAt(wrapper, 0.94, 0.5);
      if (await waitFor(() => findVisibleDropdownMenu(), 1200, 100)) return true;
    }
    return false;
  }

  // Asks background.js to click the center of `el` via chrome.debugger
  // (Input.dispatchMouseEvent) instead of el.click() — see pickByLabel's
  // comment for why a content-script click doesn't work for this component.
  async function cdpClickElement(el) {
    return cdpClickElementAt(el, 0.5, 0.5);
  }

  async function cdpClickElementAt(el, xRatio, yRatio) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    await humanDelay(HUMAN_DELAY.clickMin, HUMAN_DELAY.clickMax);
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width * xRatio;
    const y = rect.top + rect.height * yRatio;
    // CDP clicks are dispatched at raw viewport coordinates, so ANY element
    // sitting on top of the target swallows them — including our own progress
    // toast. Root-caused live on production (2026-08-06, shipment 11274): the
    // toast is docked over the form's right-hand column, so Country of Origin,
    // Gross Weight and Package Type were being "clicked" through the feed panel
    // and never committed, burning the whole audit/retry budget on every item.
    // Hide the toast for the duration of any click it would intercept.
    const restoreToast = hideToastIfCovering(x, y);
    try {
      await cdpClickPoint(x, y);
    } finally {
      restoreToast();
    }
    await humanDelay(HUMAN_DELAY.clickMin, HUMAN_DELAY.clickMax);
  }

  // Returns a restore function; a no-op when the toast isn't in the way.
  function hideToastIfCovering(x, y) {
    const toast = document.getElementById(TOAST_ID);
    if (!toast) return () => {};
    const box = toast.getBoundingClientRect();
    const covers = x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    if (!covers) return () => {};
    const previous = toast.style.visibility;
    toast.style.visibility = "hidden";
    return () => { toast.style.visibility = previous; };
  }

  function cdpClickPoint(x, y) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "cdpClickPoint", x, y }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.ok === false) {
          reject(new Error(response.error || "CDP click failed."));
          return;
        }
        resolve();
      });
    });
  }

  async function cdpTypeText(text) {
    for (const char of String(text || "")) {
      await cdpInsertText(char);
      await humanDelay(HUMAN_DELAY.typeMin, HUMAN_DELAY.typeMax);
    }
  }

  function cdpInsertText(text) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "cdpTypeText", text }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.ok === false) {
          reject(new Error(response.error || "CDP type failed."));
          return;
        }
        resolve();
      });
    });
  }

  async function humanTypeElement(el, value) {
    if (String(el.type || "").toLowerCase() === "date") {
      setNativeValue(el, value);
      await humanDelay(HUMAN_DELAY.fieldMin, HUMAN_DELAY.fieldMax);
      return;
    }
    await cdpClickElement(el);
    selectElementText(el);
    await humanDelay(180, 420);
    await cdpTypeText(value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    await humanDelay(HUMAN_DELAY.fieldMin, HUMAN_DELAY.fieldMax);
  }

  function selectElementText(el) {
    el.focus();
    if (typeof el.setSelectionRange === "function") {
      try {
        el.setSelectionRange(0, String(el.value || "").length);
      } catch {
        // Some Vuetify inputs do not allow selection APIs in every state.
      }
    }
  }

  async function dismissBlockingOverlay() {
    if (document.querySelector(".v-dialog--active")) return false;
    const overlay = [...document.querySelectorAll(".v-overlay--active")]
      .find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && getComputedStyle(el).pointerEvents !== "none";
      });
    if (!overlay) return false;
    await cdpClickElement(overlay);
    await wait(400);
    return true;
  }

  function findVisibleDropdownOption(value) {
    const menu = findVisibleDropdownMenu();
    if (!menu) return null;
    const needle = String(value).trim().toLowerCase();
    const items = [...menu.querySelectorAll(".v-list-item")];
    return items.find((li) => (li.textContent || "").trim().toLowerCase() === needle)
      || items.find((li) => (li.textContent || "").trim().toLowerCase().includes(needle));
  }

  function findSingleVisibleDropdownOption() {
    const menu = findVisibleDropdownMenu();
    if (!menu) return null;
    const items = [...menu.querySelectorAll(".v-list-item")];
    return items.length === 1 ? items[0] : null;
  }

  // First real, visible option in the open dropdown, skipping any disabled
  // "No data available" placeholder row. Used by pickFirstOptionByLabel.
  function firstVisibleDropdownOption() {
    const menu = findVisibleDropdownMenu();
    if (!menu) return null;
    const items = [...menu.querySelectorAll(".v-list-item")].filter((li) => {
      const r = li.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      if (li.getAttribute("aria-disabled") === "true" || li.classList.contains("v-list-item--disabled")) return false;
      return !/no data available/i.test((li.textContent || "").trim());
    });
    return items[0] || null;
  }

  // Some fields always take the top option (e.g. Presenting Bank — our own bank
  // is the first entry). It's a Vuetify autocomplete, not a text field, so
  // typing a name in is both unnecessary and unreliable. Just open the dropdown
  // via the trusted CDP click and select the first real option.
  async function pickFirstOptionByLabel(label, root = document) {
    const el = findByAny([label], root);
    if (!el) return false;
    if (!isEditable(el)) throw new Error(`${label} is not editable.`);
    await openDropdownForElement(el);
    await humanDelay(300, 700);
    let option = await waitFor(() => firstVisibleDropdownOption(), 5000, 150);
    if (!option) {
      await openDropdownForElement(el);
      option = await waitFor(() => firstVisibleDropdownOption(), 3000, 150);
    }
    if (!option) throw new Error(`${label}: no options appeared in the dropdown to select.`);
    await cdpClickElement(option);
    await humanDelay(450, 900);
    return true;
  }

  function findVisibleDropdownMenu() {
    return [...document.querySelectorAll(".v-menu__content.menuable__content__active, .v-autocomplete__content, .v-select-list")]
      .find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }) || null;
  }

  function fieldHasValue(label, root = document) {
    const el = findByAny([label], root);
    return Boolean(String(el?.value || "").trim());
  }

  // Count item rows already saved on the certificate, so a re-run resumes past
  // them rather than duplicating customs lines (#1). Deliberately conservative:
  // only counts a data table whose HEADER looks like the items grid (Commodity /
  // Description / HS / Gross Weight), and returns 0 when no such table is found —
  // i.e. it falls back to the pre-020 "fill everything" behaviour rather than
  // risk skipping real items. A wrong (under-)count therefore surfaces as a
  // visible duplicate on the feed, never a silent drop. NOTE: the items-table
  // selector was matched to BeSwift's saved-items layout as understood on
  // 2026-07; confirm it live and tighten if BeSwift restyles the grid.
  function countExistingItemRows() {
    const tables = [...document.querySelectorAll(".v-data-table, table")];
    for (const t of tables) {
      const headText = String(t.querySelector("thead")?.textContent || "").toLowerCase();
      if (!/commodity|description|hs code|gross weight/.test(headText)) continue;
      const rows = [...t.querySelectorAll("tbody tr")];
      const real = rows.filter((r) => !/no data|no items|no matching/i.test(r.textContent || ""));
      if (real.length) return real.length;
    }
    return 0;
  }

  async function refreshFieldOptionsByLabel(label, root = document) {
    const el = findByAny([label], root);
    if (!el) return false;
    const wrapper = el.closest(".v-input, .v-text-field, .v-autocomplete, .v-select");
    const reload = wrapper?.querySelector(".v-input__prepend-inner button, .v-input__prepend-inner .v-icon");
    if (!reload) return false;
    await cdpClickElement(reload);
    await humanDelay(1400, 2600);
    return true;
  }

  function findVisibleButtonByText(text) {
    const needle = String(text || "").trim().toLowerCase();
    return [...document.querySelectorAll("button")]
      .find((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0
          && rect.height > 0
          && !button.disabled
          && (button.textContent || button.getAttribute("aria-label") || "").trim().toLowerCase() === needle;
      }) || null;
  }

  function isVisibleElement(el) {
    if (!el || !document.contains(el)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  const SECTION_HEADINGS = [
    "Applicant Details",
    "Exporter/Supplier Details",
    "Importer Details",
    "Producer/Manufacturer Details",
    "Consignee Details"
  ];

  function requireSectionContainer(headingText) {
    const section = findSectionContainer(headingText);
    if (!section) throw new Error(`${headingText} section was not found.`);
    return section;
  }

  function findSectionContainer(headingText) {
    // BeSwift's form repeats field labels (Name/Address/Country/TIN) across
    // multiple side-by-side sections (Applicant, Exporter/Supplier, Importer,
    // Producer/Manufacturer, Consignee) confirmed live — a plain document-wide
    // findByAny() always hits the first (Applicant) occurrence. Scope lookups
    // to a specific section by climbing up from its heading only as long as
    // the ancestor still contains exactly that one section heading, stopping
    // right before it would also swallow a sibling section's heading.
    const needle = headingText.trim().toLowerCase();
    const allHeadings = findSectionHeadings();
    const heading = allHeadings.find((el) => sectionHeadingText(el) === needle);
    if (!heading) return null;

    let container = heading.parentElement;
    let best = null;
    while (container && container !== document.body) {
      const headingsInside = allHeadings.filter((h) => container.contains(h));
      if (headingsInside.length === 1 && headingsInside[0] === heading) {
        if (container.querySelector("input,textarea,select")) best = container;
        container = container.parentElement;
      } else {
        break;
      }
    }
    return best || heading.parentElement;
  }

  function findSectionHeadings() {
    // IMPORTANT: keep this candidate selector narrow. It used to also include
    // plain "div,span" to be more lenient about markup changes, but this page
    // has a hidden "jump to section" outline panel (rendered off-screen /
    // as disabled .v-list-item__title entries) that duplicates every section
    // name as plain text in a div/span — broadening the selector to div/span
    // picks that decoy up as a heading candidate too, and which one
    // findSectionContainer picks then depends on DOM nesting order rather
    // than which is the real form section. Confirmed live 2026-07-06: this
    // caused "Name is not editable" on Importer Details because
    // requireSectionContainer("Applicant Details") resolved to the outline
    // panel's entry instead of the real section on some runs. Only match
    // actual heading-ish elements.
    const sectionNames = new Set(SECTION_HEADINGS.map((text) => text.toLowerCase()));
    const candidates = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,.v-card__title,.v-toolbar__title,.v-subheader,legend")]
      .filter((el) => {
        const text = sectionHeadingText(el);
        if (!sectionNames.has(text)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

    return candidates.filter((el) => !candidates.some((other) => {
      return other !== el && el.contains(other) && sectionHeadingText(other) === sectionHeadingText(el);
    }));
  }

  function sectionHeadingText(el) {
    const directText = [...el.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent || "")
      .join(" ")
      .trim();
    return (directText || el.textContent || "").trim().replace(/\s+/g, " ").toLowerCase();
  }

  // BeSwift's field markup puts the visible label in a <label>/.v-label element
  // rather than on the input's own aria-label/name/id/placeholder for some
  // fields — so a finder that only reads those attributes can't locate the
  // input and the field is silently left blank (confirmed live 2026-07:
  // Presenting Bank on Invoice Details, and Country of Origin + Package Type on
  // the item dialog). Collect every label-ish text associated with an input so
  // matching can also work off the visible label. `el.labels` covers both
  // <label for=id> and a wrapping <label>; aria-labelledby covers ARIA wiring;
  // the scoped `.v-label` covers Vuetify's own label span (its most common
  // pattern, which is NOT a real <label for>). A trailing "*" required marker
  // and collapsed whitespace are normalized away so "Presenting Bank *" still
  // matches "presenting bank".
  function labelTextsForInput(el) {
    const norm = (s) => String(s || "").replace(/\*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    const texts = [];
    try {
      if (el.labels) for (const l of el.labels) texts.push(norm(l.textContent));
    } catch {
      // el.labels can throw on non-labelable elements in some engines — ignore.
    }
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      for (const id of labelledby.split(/\s+/)) {
        const ref = id && document.getElementById(id);
        if (ref) texts.push(norm(ref.textContent));
      }
    }
    const wrapper = el.closest(".v-input, .v-text-field, .v-select, .v-autocomplete");
    if (wrapper) {
      for (const l of wrapper.querySelectorAll(".v-label")) texts.push(norm(l.textContent));
    }
    return texts.filter(Boolean);
  }

  // Given a scored candidate list, pick the best element: prefer exact matches
  // over partial, and within the winning precision tier prefer one that's
  // editable right now rather than blindly the first in DOM order — a label can
  // match several fields in the same scope (e.g. a disabled field from a
  // section that hasn't cascaded/unlocked yet, alongside the one actually meant
  // to be filled), and grabbing the wrong one was throwing "not editable" even
  // though a usable field existed.
  function pickBestCandidate(candidates) {
    if (!candidates.length) return undefined;
    const exactMatches = candidates.filter((c) => c.exact);
    const pool = exactMatches.length ? exactMatches : candidates;
    const editableMatch = pool.find((c) => isEditable(c.el));
    return (editableMatch || pool[0]).el;
  }

  // Snapshot of the field labels currently visible under `root` -- attached to
  // loud-miss checkpoints so a resolver failure records what the form actually
  // calls its fields (e.g. whether BeSwift renders "Freight Cost" or some
  // variant), instead of needing a live repro session to find out.
  function visibleFieldLabels(root = document) {
    const texts = [...root.querySelectorAll("label, .v-label")]
      .map((el) => String(el.textContent || "").trim())
      .filter(Boolean);
    return [...new Set(texts)].slice(0, 60);
  }

  function findByAny(labels, root = document) {
    const wanted = labels.map((label) => String(label).toLowerCase().trim());
    const inputs = [...root.querySelectorAll("input,textarea,select")];

    // Pass 1 (original behaviour, unchanged): match on the input's OWN
    // aria-label/name/id/placeholder. Kept as the sole first pass so every
    // field that already resolved this way (e.g. Port Of Discharge) picks the
    // exact same element it always did — label-text matching below can never
    // reorder or override a field that Pass 1 can resolve.
    const attrCandidates = inputs.map((el) => {
      const fields = [
        String(el.getAttribute("aria-label") || "").toLowerCase().trim(),
        String(el.getAttribute("name") || "").toLowerCase().trim(),
        String(el.id || "").toLowerCase().trim(),
        String(el.getAttribute("placeholder") || "").toLowerCase().trim()
      ];
      // A short/generic label like "Name" or "Country" is a substring of more
      // specific labels elsewhere ("Contact Name", "Country Of Destination") —
      // prefer an exact match so those don't get grabbed by accident.
      const exact = wanted.some((label) => fields.includes(label));
      const partial = !exact && wanted.some((label) => fields.some((field) => field.includes(label)));
      return { el, exact, partial };
    }).filter((c) => c.exact || c.partial);

    const byAttr = pickBestCandidate(attrCandidates);
    if (byAttr) return byAttr;

    // Pass 2 (fallback, only when Pass 1 found NOTHING): resolve from the
    // input's associated visible label (<label>/.v-label/aria-labelledby).
    // BeSwift carries some fields' label only there — Presenting Bank, Country
    // Of Origin, Package Type — so those were being left blank. Scoped strictly
    // as a fallback so it cannot change which input a Pass-1 field resolves to.
    const labelCandidates = inputs.map((el) => {
      const texts = labelTextsForInput(el);
      const exact = wanted.some((label) => texts.includes(label));
      const partial = !exact && wanted.some((label) => texts.some((t) => t.includes(label)));
      return { el, exact, partial };
    }).filter((c) => c.exact || c.partial);

    return pickBestCandidate(labelCandidates);
  }

  async function clickByText(text, root = document) {
    // A radio/checkbox GROUP wrapper (e.g. Applicant Type's outer .v-input,
    // containing both "Personal" and "Other" .v-radio children) also matches
    // an `includes(needle)` text search for either option's name, and appears
    // BEFORE its own children in querySelectorAll's document order — so a
    // naive "first match wins" search grabs the group wrapper, not the specific
    // option, and ends up clicking whichever input happens to be first inside
    // it regardless of which option name was actually requested (confirmed as
    // a live risk once Applicant Type's "Other" radio was added; not just a
    // theoretical concern for Producer's Single/Multiple or Commodity Type's
    // Primary/Manufactured groups too). Prefer the MOST SPECIFIC match — the
    // one with the shortest matching text — since a single option's own
    // element never contains a sibling option's label, only a shared ancestor
    // wrapper does.
    const needle = String(text).toLowerCase();
    const candidates = [...root.querySelectorAll("label,button,.v-input,.v-label,.v-radio")]
      .filter((el) => String(el.textContent || "").toLowerCase().includes(needle));
    if (!candidates.length) return false;
    candidates.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
    const hit = candidates[0];
    const input = hit.matches("input") ? hit : hit.querySelector?.("input");
    if (input && !input.checked) {
      await cdpClickElement(hit);
      return true;
    }
    if (hit.matches("button")) {
      await cdpClickElement(hit);
      return true;
    }
    await cdpClickElement(hit);
    return true;
  }

  function setNativeValue(el, value) {
    el.focus();
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, String(value));
    else el.value = String(value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: String(value) }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isEditable(el) {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + Math.min(8, box.width / 2), box.top + Math.min(8, box.height / 2));
    return !el.disabled && !el.readOnly && style.pointerEvents !== "none"
      && (!top || top === el || el.contains(top) || top.contains(el) || isTransientOverlay(top));
  }

  // Vuetify renders a full-viewport scrim/overlay while a menu or date picker is
  // open. It sits above every field, so the elementFromPoint hit-test in
  // isEditable() reports the scrim instead of the input and the field looks
  // "not editable" purely because some *other* control happens to be open.
  // Root-caused live on production (2026-08-06): the Shipping Date picker
  // auto-opened, its scrim covered the form, and the run died on "Shipping Date
  // is not editable" even though the field was perfectly fine. A scrim is
  // transient and click-through for our purposes, so don't treat it as blocking.
  function isTransientOverlay(el) {
    if (!el) return false;
    // Our own progress toast counts as transient too — cdpClickElementAt hides
    // it for the duration of any click it would intercept, so a field sitting
    // under it is genuinely clickable and must not be judged "not editable".
    if (el.id === TOAST_ID || el.closest?.(`#${TOAST_ID}`)) return true;
    return Boolean(el.closest?.(".v-overlay__scrim, .v-overlay--active, .v-menu__content, .v-picker, .v-date-picker, .v-dialog__content"));
  }

  // Why exactly a field failed the isEditable() gate — appended to the thrown
  // error so a failed run self-diagnoses instead of needing a live repro.
  function describeUneditable(el) {
    try {
      const style = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      const top = document.elementFromPoint(box.left + Math.min(8, box.width / 2), box.top + Math.min(8, box.height / 2));
      const desc = (node) => node
        ? `${node.tagName.toLowerCase()}${node.id ? "#" + node.id : ""}.${String(node.className || "").split(/\s+/).filter(Boolean).slice(0, 3).join(".")}`
        : "none";
      return `[disabled=${!!el.disabled} readOnly=${!!el.readOnly} pointerEvents=${style.pointerEvents} `
        + `rect=${Math.round(box.left)},${Math.round(box.top)},${Math.round(box.width)}x${Math.round(box.height)} `
        + `topEl=${desc(top)} tag=${desc(el)} type=${el.type || ""}]`;
    } catch (error) {
      return "[diagnostics unavailable]";
    }
  }

  // Dismiss any open Vuetify menu/date picker so it stops covering the form.
  async function dismissOpenOverlays() {
    const scrim = document.querySelector(".v-overlay__scrim, .v-menu__content--active");
    if (!scrim) return false;
    document.activeElement?.blur?.();
    for (const target of [document.activeElement || document.body, document.body]) {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    }
    await wait(350);
    return true;
  }

  // Granular progress marker — always reports job_status "filling" (so it
  // never looks stuck/errored to anything watching just the status field),
  // but appends a distinct, timestamped message+details entry to the job's
  // log_json every time it's called. This is the "observe behavior during
  // fill" trace: poll GET /api/beswift-extension/jobs/:id/status (from the
  // popup, or any tab navigated at the URL directly — it's read-only) and
  // watch the log array grow through fillHeader/fillItems in near-real time.
  async function checkpoint(ctx, message, details) {
    // Beta: mirror the checkpoint onto the on-page rolling feed so the operator
    // sees a running summary of what's being entered, section by section / item
    // by item, without opening the popup.
    pushFeed(message, "check", details);
    await reportDetailed(ctx.baseUrl, ctx.job.automationJobId, "filling", message, details);
  }

  // Stops the fill and waits for an explicit resume signal before continuing
  // — for steps where Russell (or whoever's watching) genuinely needs to look
  // at the real page before it's safe to proceed (e.g. right after the header
  // fill, before Items starts touching dialogs). Reports "paused" with the
  // reason, shows the same reason as an on-page banner (visible to whoever's
  // sitting at the keyboard), then polls the job's status every 2s for a
  // 'resume_signal' log entry newer than this pause — either the popup's
  // Resume button (fetched directly, no relay needed there) or a plain GET to
  // .../resume from any other tab can produce that signal. No hard timeout by
  // design: a real human review step shouldn't be raced against a clock, but
  // this content-script instance is torn down for free if the tab
  // navigates/closes, so it can't leak beyond the page's own lifetime.
  async function pauseForInteraction(ctx, reason, el, meta = {}) {
    const pausedAt = new Date();
    if (el) highlightElement(el);
    await reportDetailed(ctx.baseUrl, ctx.job.automationJobId, "paused", reason);
    pushFeed(`Paused: ${reason}`, "warn");
    // Beta: render the interactive pause panel with the error+resolution capture
    // form (prefilled from the paused field's label/expected value). The
    // operator fixes the field on the page, records what was wrong, and clicks
    // Resume right here — no need to switch to the popup, which unloads on blur.
    // The popup Resume button and the right-click menu still work as fallbacks.
    renderPausePanel(ctx, reason, meta);
    for (;;) {
      await wait(2000);
      const job = await pollJobStatus(ctx.baseUrl, ctx.job.automationJobId);
      if (!job) continue; // transient poll failure — keep waiting rather than giving up
      const log = Array.isArray(job.logs) ? job.logs : [];
      const resumed = log.some((entry) => entry?.status === "resume_signal" && new Date(entry.at) > pausedAt);
      if (resumed || job.status === "filling") {
        if (el) unhighlightElement(el);
        hidePinned();
        pushFeed(`Resumed — continuing: ${reason}`, "info");
        return;
      }
    }
  }

  // Stops for a fix to one specific field — same wait/resume mechanism as
  // pauseForInteraction, just with the field named, highlighted, and scrolled
  // into view so whoever's watching doesn't have to go hunting for it. The
  // label/expected are threaded into the resolution form so the operator only
  // has to fill in what actually went wrong and how they fixed it.
  async function pauseForFieldFix(ctx, el, label, expectedValue, reason) {
    await pauseForInteraction(
      ctx,
      `Field "${label}" needs a manual fix (expected "${expectedValue}"). ${reason}`,
      el,
      { field: label, expected: expectedValue }
    );
  }

  function isFieldEditable(label) {
    const el = findByAny([label]);
    return el && isEditable(el) ? el : null;
  }

  function highlightElement(el) {
    if (!el) return;
    el.dataset.optilensPrevOutline = el.style.outline || "";
    el.dataset.optilensPrevOutlineOffset = el.style.outlineOffset || "";
    el.style.outline = "3px solid #e8462a";
    el.style.outlineOffset = "2px";
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function unhighlightElement(el) {
    if (!el) return;
    el.style.outline = el.dataset.optilensPrevOutline || "";
    el.style.outlineOffset = el.dataset.optilensPrevOutlineOffset || "";
    delete el.dataset.optilensPrevOutline;
    delete el.dataset.optilensPrevOutlineOffset;
  }

  function pollJobStatus(baseUrl, jobId) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "pollJobStatus", baseUrl, jobId }, (response) => {
          if (chrome.runtime.lastError || !response?.ok) {
            resolve(null);
            return;
          }
          resolve(response.job);
        });
      } catch (error) {
        resolve(null);
      }
    });
  }

  async function reportDetailed(baseUrl, jobId, status, message, details) {
    await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "reportStatus", baseUrl, jobId, status, message, details }, () => resolve());
      } catch (error) {
        resolve();
      }
    });
  }

  async function report(baseUrl, jobId, status, message) {
    // Beta: surface milestone reports (sign-in, fill complete) on the feed too.
    if (message) pushFeed(message, status === "filled_review" ? "check" : "info");
    // The BeSwift page is HTTPS; a direct fetch() to our http:// OptiLens
    // server from this content script gets blocked by the browser as mixed
    // content. Relay through the background service worker instead, which
    // isn't subject to the page's mixed-content restriction.
    await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "reportStatus", baseUrl, jobId, status, message }, () => resolve());
      } catch (error) {
        resolve();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Beta on-page toast: a persistent panel with a header, a pinned alert slot
  // (pause / complete / errors), and a scrollable rolling FEED of everything
  // the fill is entering — a summary of each section/item as it happens, so the
  // operator watching the page sees the same trace the server log gets, without
  // opening the popup. The pinned slot also hosts the operator's error +
  // resolution capture form when the fill pauses for a manual fix.
  // ---------------------------------------------------------------------------
  const TOAST_ID = "optilens-beswift-toast";
  const STYLE_ID = "optilens-beswift-style";
  let toastFeedEl = null;
  let toastPinnedEl = null;

  function ensureToastStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${TOAST_ID}{position:fixed!important;z-index:2147483647!important;top:16px;right:16px;
        width:420px;max-width:calc(100vw - 32px);height:auto;max-height:70vh;display:flex;flex-direction:column;
        background:#0f172a;color:#e2e8f0;border:1px solid #1e293b;border-radius:10px;
        font:12.5px/1.4 Segoe UI,Arial,sans-serif;box-shadow:0 12px 34px rgba(0,0,0,.4);overflow:hidden;
        resize:both;min-width:240px;min-height:44px;transition:opacity .12s ease}
      #${TOAST_ID}.olb-transparent{opacity:.35}
      #${TOAST_ID}.olb-transparent:hover{opacity:1}
      #${TOAST_ID}.olb-collapsed{height:auto!important;max-height:none;resize:none}
      #${TOAST_ID}.olb-collapsed .olb-pinned,#${TOAST_ID}.olb-collapsed .olb-feed{display:none!important}
      #${TOAST_ID} .olb-head{display:flex;align-items:center;gap:8px;padding:9px 12px;cursor:move;
        background:#111827;border-bottom:1px solid #1e293b;font-weight:600;letter-spacing:.2px;user-select:none}
      #${TOAST_ID} .olb-tag{background:#f97316;color:#111827;font-size:10px;font-weight:700;
        padding:1px 6px;border-radius:999px;letter-spacing:.5px}
      #${TOAST_ID} .olb-head .olb-spacer{flex:1}
      #${TOAST_ID} .olb-ctrl{cursor:pointer;background:transparent;border:0;color:#94a3b8;font-size:14px;
        line-height:1;padding:2px 5px;border-radius:5px}
      #${TOAST_ID} .olb-ctrl:hover{background:#1e293b;color:#e2e8f0}
      #${TOAST_ID} .olb-ctrl.on{color:#f97316}
      #${TOAST_ID} .olb-pinned{padding:11px 12px;border-bottom:1px solid #1e293b;line-height:1.4}
      #${TOAST_ID} .olb-pinned.olb-pause{background:#7c2d12;color:#fed7aa}
      #${TOAST_ID} .olb-pinned.olb-done{background:#14532d;color:#bbf7d0}
      #${TOAST_ID} .olb-pinned.olb-error{background:#7f1d1d;color:#fecaca}
      #${TOAST_ID} .olb-pinned.olb-info{background:#1e3a8a;color:#dbeafe}
      #${TOAST_ID} .olb-feed{list-style:none;margin:0;padding:6px 8px;overflow:auto;flex:1;min-height:60px}
      #${TOAST_ID} .olb-item{padding:4px 6px;border-radius:6px}
      #${TOAST_ID} .olb-item + .olb-item{margin-top:2px}
      #${TOAST_ID} .olb-item.olb-check{background:rgba(34,197,94,.10)}
      #${TOAST_ID} .olb-item.olb-warn{background:rgba(249,115,22,.12)}
      #${TOAST_ID} .olb-time{color:#64748b;font-variant-numeric:tabular-nums;margin-right:6px}
      #${TOAST_ID} .olb-detail{color:#94a3b8;margin:2px 0 0 2px;font-size:11.5px;word-break:break-word}
      #${TOAST_ID} .olb-form{display:flex;flex-direction:column;gap:6px;margin-top:9px}
      #${TOAST_ID} .olb-form label{display:flex;flex-direction:column;gap:2px;font-size:11px;color:#fed7aa}
      #${TOAST_ID} .olb-form input,#${TOAST_ID} .olb-form textarea{font:12px Segoe UI,Arial,sans-serif;
        background:#fff7ed;color:#111827;border:1px solid #c2410c;border-radius:5px;padding:5px 7px;width:100%;box-sizing:border-box}
      #${TOAST_ID} .olb-form textarea{resize:vertical;min-height:34px}
      #${TOAST_ID} .olb-actions{display:flex;gap:8px;margin-top:4px}
      #${TOAST_ID} .olb-btn{cursor:pointer;border:0;border-radius:6px;padding:7px 12px;font-weight:600;font-size:12px}
      #${TOAST_ID} .olb-btn.primary{background:#f97316;color:#111827}
      #${TOAST_ID} .olb-btn.ghost{background:transparent;color:#fed7aa;border:1px solid #c2410c}
      #${TOAST_ID} .olb-note{color:#94a3b8;font-size:11px;margin-top:2px}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  const TOAST_STATE_KEY = "optilensBeswiftToastState";
  let toastState = { left: null, top: null, width: null, height: null, collapsed: false, transparent: false };

  function ensureToast() {
    ensureToastStyle();
    let root = document.getElementById(TOAST_ID);
    if (root) return root;
    root = document.createElement("div");
    root.id = TOAST_ID;

    const head = document.createElement("div");
    head.className = "olb-head";
    const title = document.createElement("span");
    title.innerHTML = `OptiLens BeSwift <span class="olb-tag">BETA</span>`;
    const spacer = document.createElement("span");
    spacer.className = "olb-spacer";
    const opacityBtn = mkCtrl("◐", "Toggle see-through");
    const collapseBtn = mkCtrl("▾", "Collapse / expand");
    head.appendChild(title);
    head.appendChild(spacer);
    head.appendChild(opacityBtn);
    head.appendChild(collapseBtn);

    const pinned = document.createElement("div");
    pinned.className = "olb-pinned";
    pinned.hidden = true;
    const feed = document.createElement("ol");
    feed.className = "olb-feed";
    root.appendChild(head);
    root.appendChild(pinned);
    root.appendChild(feed);
    document.body.appendChild(root);
    toastPinnedEl = pinned;
    toastFeedEl = feed;

    wireToastControls(root, head, opacityBtn, collapseBtn);
    loadToastState(root, opacityBtn, collapseBtn);
    return root;
  }

  function mkCtrl(glyph, title) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "olb-ctrl";
    b.textContent = glyph;
    b.title = title;
    return b;
  }

  // Drag (via header), collapse, transparency toggle, and native resize. Size
  // (from CSS resize) and position/flags persist to chrome.storage.local so the
  // panel stays where the operator parked it across fills and page reloads.
  function wireToastControls(root, head, opacityBtn, collapseBtn) {
    let drag = null;
    head.addEventListener("mousedown", (e) => {
      if (e.target.closest(".olb-ctrl")) return; // let buttons click
      const rect = root.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      // Switch from right-anchored to explicit left/top so dragging is absolute.
      root.style.right = "auto";
      root.style.left = `${rect.left}px`;
      root.style.top = `${rect.top}px`;
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!drag) return;
      const maxLeft = window.innerWidth - 60;
      const maxTop = window.innerHeight - 30;
      const left = Math.min(Math.max(0, e.clientX - drag.dx), maxLeft);
      const top = Math.min(Math.max(0, e.clientY - drag.dy), maxTop);
      root.style.left = `${left}px`;
      root.style.top = `${top}px`;
    });
    document.addEventListener("mouseup", () => {
      if (!drag) return;
      drag = null;
      toastState.left = parseInt(root.style.left, 10);
      toastState.top = parseInt(root.style.top, 10);
      saveToastState();
    });

    collapseBtn.addEventListener("click", () => {
      const collapsed = root.classList.toggle("olb-collapsed");
      collapseBtn.textContent = collapsed ? "▸" : "▾";
      toastState.collapsed = collapsed;
      saveToastState();
    });

    opacityBtn.addEventListener("click", () => {
      const on = root.classList.toggle("olb-transparent");
      opacityBtn.classList.toggle("on", on);
      toastState.transparent = on;
      saveToastState();
    });

    // Persist the size the operator drags the native resize grip to.
    if (typeof ResizeObserver === "function") {
      let t = null;
      const ro = new ResizeObserver(() => {
        clearTimeout(t);
        t = setTimeout(() => {
          if (root.classList.contains("olb-collapsed")) return;
          toastState.width = root.offsetWidth;
          toastState.height = root.offsetHeight;
          saveToastState();
        }, 300);
      });
      ro.observe(root);
    }
  }

  function loadToastState(root, opacityBtn, collapseBtn) {
    try {
      chrome.storage.local.get([TOAST_STATE_KEY], (data) => {
        if (chrome.runtime.lastError) return;
        const s = data && data[TOAST_STATE_KEY];
        if (!s || typeof s !== "object") return;
        toastState = Object.assign(toastState, s);
        if (Number.isFinite(s.width)) root.style.width = `${s.width}px`;
        if (Number.isFinite(s.height) && !s.collapsed) root.style.height = `${s.height}px`;
        if (Number.isFinite(s.left) && Number.isFinite(s.top)) {
          root.style.right = "auto";
          root.style.left = `${Math.min(s.left, window.innerWidth - 60)}px`;
          root.style.top = `${Math.min(s.top, window.innerHeight - 30)}px`;
        }
        if (s.collapsed) {
          root.classList.add("olb-collapsed");
          collapseBtn.textContent = "▸";
        }
        if (s.transparent) {
          root.classList.add("olb-transparent");
          opacityBtn.classList.add("on");
        }
      });
    } catch {
      // chrome.storage unavailable (e.g. detached) — panel just won't persist.
    }
  }

  function saveToastState() {
    try {
      chrome.storage.local.set({ [TOAST_STATE_KEY]: toastState }, () => void chrome.runtime.lastError);
    } catch {
      // best-effort persistence only
    }
  }

  // Appends one line to the rolling feed with an optional compact summary of the
  // details object a checkpoint carries (importer/transport/invoice/item fields).
  function pushFeed(message, kind = "info", details) {
    ensureToast();
    const li = document.createElement("li");
    li.className = `olb-item olb-${kind}`;
    const time = document.createElement("span");
    time.className = "olb-time";
    time.textContent = new Date().toLocaleTimeString();
    const msg = document.createElement("span");
    msg.className = "olb-msg";
    msg.textContent = message;
    li.appendChild(time);
    li.appendChild(msg);
    const summary = summarizeDetails(details);
    if (summary) {
      const d = document.createElement("div");
      d.className = "olb-detail";
      d.textContent = summary;
      li.appendChild(d);
    }
    toastFeedEl.appendChild(li);
    while (toastFeedEl.children.length > 60) toastFeedEl.removeChild(toastFeedEl.firstChild);
    toastFeedEl.scrollTop = toastFeedEl.scrollHeight;
  }

  // Flattens a checkpoint details object into a short "key: value" string,
  // descending one level into nested objects (importer/transport/invoiceDetails).
  function summarizeDetails(details) {
    if (!details || typeof details !== "object") return "";
    const parts = [];
    const push = (key, value) => {
      if (value === undefined || value === null || value === "") return;
      if (typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          if (v === undefined || v === null || v === "" || typeof v === "object") continue;
          parts.push(`${k}: ${String(v)}`);
        }
      } else {
        parts.push(`${key}: ${String(value)}`);
      }
    };
    for (const [key, value] of Object.entries(details)) push(key, value);
    const text = parts.join(" · ");
    return text.length > 240 ? `${text.slice(0, 237)}…` : text;
  }

  // Pinned alert (pause / complete / error / info). Clears any pause form.
  function showPinned(kind, message) {
    ensureToast();
    toastPinnedEl.hidden = false;
    toastPinnedEl.className = `olb-pinned olb-${kind}`;
    toastPinnedEl.textContent = message;
  }

  function hidePinned() {
    if (!toastPinnedEl) return;
    toastPinnedEl.hidden = true;
    toastPinnedEl.innerHTML = "";
  }

  // Back-compat shim: existing showBanner(message) calls now render as an info
  // (or completion, if the text says so) pinned alert on the new toast.
  function showBanner(message) {
    const kind = /complete/i.test(message) ? "done" : "info";
    showPinned(kind, message);
  }

  // Renders the operator error + resolution capture form inside the pinned slot
  // while paused. Fields prefill from the paused field's known label/expected
  // value. Returns a Promise that resolves once the operator submits (resume) —
  // the resolution is posted first (if anything was entered), then the job is
  // resumed; the surrounding pause loop notices the status flip and continues.
  function renderPausePanel(ctx, reason, meta = {}) {
    ensureToast();
    toastPinnedEl.hidden = false;
    toastPinnedEl.className = "olb-pinned olb-pause";
    toastPinnedEl.innerHTML = "";

    const heading = document.createElement("div");
    heading.textContent = `PAUSED — ${reason}`;
    heading.style.fontWeight = "600";
    toastPinnedEl.appendChild(heading);

    const form = document.createElement("div");
    form.className = "olb-form";
    const field = mkField("Field", meta.field || "");
    const expected = mkField("Expected value", meta.expected || "");
    const actual = mkField("What it actually had", "");
    const fix = mkArea("What you did to fix it");
    const note = mkArea("Notes / root cause (optional)");
    form.appendChild(field.wrap);
    form.appendChild(expected.wrap);
    form.appendChild(actual.wrap);
    form.appendChild(fix.wrap);
    form.appendChild(note.wrap);

    const actions = document.createElement("div");
    actions.className = "olb-actions";
    const resumeBtn = document.createElement("button");
    resumeBtn.className = "olb-btn primary";
    resumeBtn.type = "button";
    resumeBtn.textContent = "Save fix & Resume";
    const skipBtn = document.createElement("button");
    skipBtn.className = "olb-btn ghost";
    skipBtn.type = "button";
    skipBtn.textContent = "Resume without note";
    actions.appendChild(resumeBtn);
    actions.appendChild(skipBtn);

    const hint = document.createElement("div");
    hint.className = "olb-note";
    hint.textContent = "Fix the field on the page first, then record what was wrong so it can be refined later.";

    toastPinnedEl.appendChild(form);
    toastPinnedEl.appendChild(actions);
    toastPinnedEl.appendChild(hint);

    const submit = async (withNote) => {
      resumeBtn.disabled = true;
      skipBtn.disabled = true;
      resumeBtn.textContent = "Resuming…";
      try {
        if (withNote) {
          const payload = {
            field: field.input.value.trim(),
            section: meta.section || "",
            expected: expected.input.value.trim(),
            actual: actual.input.value.trim(),
            fix: fix.input.value.trim(),
            note: note.input.value.trim(),
            source: "beta"
          };
          const hasAny = payload.field || payload.expected || payload.actual || payload.fix || payload.note;
          if (hasAny) await recordResolutionRelay(ctx.baseUrl, ctx.job.automationJobId, payload);
        }
      } catch (error) {
        // Don't block resume on a failed note write — surface it and continue.
        pushFeed(`Resolution note not saved: ${error.message}`, "warn");
      }
      try {
        await resumeJobRelay(ctx.baseUrl, ctx.job.automationJobId, withNote ? "Resumed with operator resolution." : "Resumed by operator.");
      } catch (error) {
        // The pause loop's own poll will also catch a server-side resume; if the
        // relay failed, re-enable so the operator can retry.
        pushFeed(`Resume failed: ${error.message}`, "warn");
        resumeBtn.disabled = false;
        skipBtn.disabled = false;
        resumeBtn.textContent = "Save fix & Resume";
      }
    };
    resumeBtn.addEventListener("click", () => submit(true));
    skipBtn.addEventListener("click", () => submit(false));
  }

  function mkField(labelText, value) {
    const wrap = document.createElement("label");
    wrap.textContent = labelText;
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    wrap.appendChild(input);
    return { wrap, input };
  }

  function mkArea(labelText) {
    const wrap = document.createElement("label");
    wrap.textContent = labelText;
    const input = document.createElement("textarea");
    wrap.appendChild(input);
    return { wrap, input };
  }

  function recordResolutionRelay(baseUrl, jobId, payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "recordResolution", baseUrl, jobId, payload }, (response) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (response && response.ok === false) return reject(new Error(response.error || "Resolution save failed."));
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function resumeJobRelay(baseUrl, jobId, message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "resumeJob", baseUrl, jobId, message }, (response) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (response && response.ok === false) return reject(new Error(response.error || "Resume failed."));
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function humanDelay(minMs, maxMs) {
    return wait(randomDelayMs(minMs, maxMs));
  }

  function randomDelayMs(minMs, maxMs) {
    const min = Math.max(0, Number(minMs) || 0);
    const max = Math.max(min, Number(maxMs) || min);
    return Math.round(min + Math.random() * (max - min));
  }
})();
