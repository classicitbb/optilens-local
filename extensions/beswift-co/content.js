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
      runFill(message).then(() => sendResponse({ ok: true })).catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });
      return true;
    }
    return false;
  });

  async function runFill(ctx) {
    const payload = ctx.payload.payload;
    await ensureOnCertificateForm();
    await report(ctx.baseUrl, ctx.job.automationJobId, "filling", "Signed in. Filling available fields.");
    await fillHeader(ctx, payload);
    await pauseForInteraction(
      ctx,
      "Header filled (Applicant/Exporter/Importer/Producer/Consignee/Transport/Invoice). " +
      "Verify these sections before Items are added — Importer scoping and the Applicant TIN pick are the parts most " +
      "likely to need a manual fix. Resume when ready to continue."
    );
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
    await setByLabel("Presenting Bank", inv.presentingBank);
    await setByLabel("Cube Quantity", inv.cubeQuantity);
    await setByLabel("Freight Cost", inv.freightCost);
    await checkpoint(ctx, "Invoice Details filled.", { invoiceDetails: inv });
  }

  async function fillItems(ctx, payload) {
    const items = payload.items || [];
    await checkpoint(ctx, `Starting Items (${items.length} item(s) to add).`);
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const opened = await clickAddItem();
      if (!opened) {
        showBanner(`Header filled. Add Item button was not found; add item ${i + 1} manually from the OptiLens payload.`);
        await checkpoint(ctx, `Item ${i + 1}/${items.length}: Add Item button not found — stopped for manual add.`);
        return;
      }
      await wait(900);
      const root = document.querySelector(".v-dialog--active") || document;
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
      await setByLabel("Commodity", item.hsCode, root);
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
      await pickByLabel("Package Type", payload.packaging?.packageType || "Box, fibreboard", root);
      await setByLabel("Item Quantity", item.quantity, root);
      await refreshFieldOptionsByLabel("Unit of Measure", root);
      if (!fieldHasValue("Unit of Measure", root)) {
        await pickByLabel("Unit of Measure", "Number of Units", root);
      }
      if (!fieldHasValue("Unit of Measure", root)) throw new Error("Unit of Measure did not commit.");
      await setByLabel("Unit Cost", item.unitCost, root);
      await checkpoint(ctx, `Item ${i + 1}/${items.length}: fields filled, about to Save.`, { hsCode: item.hsCode, description: item.commercialDescription });
      await clickDialogSave(root);
      await wait(900);
      await checkpoint(ctx, `Item ${i + 1}/${items.length}: Save clicked.`);
    }
    await checkpoint(ctx, `All ${items.length} item(s) processed.`);
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
    if (value === undefined || value === null || value === "") return false;
    const el = findByAny([label], root);
    if (!el) return false;
    if (!isEditable(el)) {
      const existing = String(el.value || "").trim();
      if (options.acceptExistingDisabled && existing) return true;
      throw new Error(`${label} is not editable.`);
    }
    await humanTypeElement(el, String(value));
    return true;
  }

  async function pickByLabel(label, value, root = document) {
    if (!value) return false;
    const el = findByAny([label], root);
    if (!el) return false;
    if (!isEditable(el)) throw new Error(`${label} is not editable.`);

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
    await openDropdownForElement(el);
    await humanDelay(250, 550);
    selectElementText(el);
    await cdpTypeText(String(value));

    // Some option lists (e.g. Country, seen live showing a loading spinner
    // and "field is required" error) appear to load asynchronously and may
    // not be ready right when typing happens — retype once partway through
    // the wait to re-trigger filtering against a list that's since finished
    // loading, and use a longer overall timeout for this class of field.
    let option = await waitFor(() => findVisibleDropdownOption(value), 3000, 150);
    if (!option) {
      selectElementText(el);
      await cdpTypeText(String(value));
      option = await waitFor(() => findVisibleDropdownOption(value), 5000, 150);
    }
    if (option) {
      // The resolved option is a real rendered element too — click it the
      // same trusted way, for the same reason as above.
      await cdpClickElement(option);
      await humanDelay(450, 900);
    } else {
      // Last-resort fallback for any field that isn't this autocomplete
    // widget (kept from before the CDP fix, cheap to leave in place).
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
      await wait(200);
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    }
    await humanDelay(450, 850);
    return true;
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
    await cdpClickPoint(x, y);
    await humanDelay(HUMAN_DELAY.clickMin, HUMAN_DELAY.clickMax);
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

  function findByAny(labels, root = document) {
    const wanted = labels.map((label) => String(label).toLowerCase().trim());
    const inputs = [...root.querySelectorAll("input,textarea,select")];
    const candidates = inputs.map((el) => {
      const fields = [
        String(el.getAttribute("aria-label") || "").toLowerCase().trim(),
        String(el.getAttribute("name") || "").toLowerCase().trim(),
        String(el.id || "").toLowerCase().trim(),
        String(el.getAttribute("placeholder") || "").toLowerCase().trim()
      ];
      const exact = wanted.some((label) => fields.includes(label));
      const partial = !exact && wanted.some((label) => fields.some((field) => field.includes(label)));
      return { el, exact, partial };
    }).filter((c) => c.exact || c.partial);

    if (!candidates.length) return undefined;

    // A short/generic label like "Name" or "Country" is a substring of more
    // specific labels elsewhere on the form ("Contact Name", "Country Of
    // Destination") — prefer an exact (trimmed) label match over a partial
    // one so those don't get matched by accident. Within whichever precision
    // tier actually has candidates, prefer one that's editable right now
    // rather than blindly taking the first in DOM order — a label can match
    // several fields in the same scope (e.g. a disabled field from a section
    // that hasn't cascaded/unlocked yet, alongside the one actually meant to
    // be filled), and grabbing the wrong one was throwing "not editable" even
    // though a usable field existed.
    const exactMatches = candidates.filter((c) => c.exact);
    const pool = exactMatches.length ? exactMatches : candidates;
    const editableMatch = pool.find((c) => isEditable(c.el));
    return (editableMatch || pool[0]).el;
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
    return !el.disabled && !el.readOnly && style.pointerEvents !== "none" && (!top || top === el || el.contains(top) || top.contains(el));
  }

  // Granular progress marker — always reports job_status "filling" (so it
  // never looks stuck/errored to anything watching just the status field),
  // but appends a distinct, timestamped message+details entry to the job's
  // log_json every time it's called. This is the "observe behavior during
  // fill" trace: poll GET /api/beswift-extension/jobs/:id/status (from the
  // popup, or any tab navigated at the URL directly — it's read-only) and
  // watch the log array grow through fillHeader/fillItems in near-real time.
  async function checkpoint(ctx, message, details) {
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
  async function pauseForInteraction(ctx, reason, el) {
    const pausedAt = new Date();
    if (el) highlightElement(el);
    await reportDetailed(ctx.baseUrl, ctx.job.automationJobId, "paused", reason);
    showBanner(
      `PAUSED — ${reason} Fix it on the page, then either click Resume in the OptiLens BeSwift popup, ` +
      `or right-click anywhere on this page and choose "OptiLens BeSwift: Resume automation".`
    );
    for (;;) {
      await wait(2000);
      const job = await pollJobStatus(ctx.baseUrl, ctx.job.automationJobId);
      if (!job) continue; // transient poll failure — keep waiting rather than giving up
      const log = Array.isArray(job.logs) ? job.logs : [];
      const resumed = log.some((entry) => entry?.status === "resume_signal" && new Date(entry.at) > pausedAt);
      if (resumed || job.status === "filling") {
        if (el) unhighlightElement(el);
        showBanner(`Resumed — continuing: ${reason}`);
        return;
      }
    }
  }

  // Stops for a fix to one specific field — same wait/resume mechanism as
  // pauseForInteraction, just with the field named, highlighted, and scrolled
  // into view so whoever's watching doesn't have to go hunting for it.
  async function pauseForFieldFix(ctx, el, label, expectedValue, reason) {
    await pauseForInteraction(
      ctx,
      `Field "${label}" needs a manual fix (expected "${expectedValue}"). ${reason}`,
      el
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

  function showBanner(message) {
    const old = document.getElementById("optilens-beswift-banner");
    if (old) old.remove();
    const banner = document.createElement("div");
    banner.id = "optilens-beswift-banner";
    banner.textContent = message;
    banner.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "top:16px",
      "right:16px",
      "width:min(520px,calc(100vw - 32px))",
      "max-height:38vh",
      "overflow:auto",
      "padding:12px 14px",
      "background:#f97316",
      "color:#111827",
      "border:1px solid rgba(124,45,18,.35)",
      "border-radius:8px",
      "font:13px Segoe UI,Arial,sans-serif",
      "line-height:1.35",
      "box-shadow:0 10px 30px rgba(0,0,0,.24)",
      "pointer-events:none"
    ].join(";");
    document.body.appendChild(banner);
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
