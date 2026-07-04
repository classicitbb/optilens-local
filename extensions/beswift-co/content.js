(function () {
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
    await fillHeader(payload);
    await fillItems(payload);
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
    // Poll for either a Sign In button (need to log in) or the actual CO
    // application form already being present (an existing session means
    // we're already signed in) — actively waiting for one of these two
    // positive signals avoids silently concluding "already signed in" just
    // because the button happened to be slow to render on a fresh page.
    const result = await waitFor(() => {
      const btn = findSignInButton();
      if (btn) return { type: "button", el: btn };
      if (findByAny(["applicant reference", "customer order no"])) return { type: "already" };
      return null;
    }, 10000, 300);

    if (!result) {
      throw new Error("Could not find a Sign In button or the BeSwift form on this page.");
    }
    if (result.type === "already") {
      return { alreadySignedIn: true };
    }
    result.el.click();
    return { alreadySignedIn: false };
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
    typeValue(found.u, username);
    typeValue(found.p, password);
    const submit = document.querySelector("#kc-login, button[type='submit'], input[type='submit']")
      || [...document.querySelectorAll("button,input[type='submit']")].find((el) => /login|sign in|submit/i.test(el.textContent || el.value || ""));
    if (!submit) {
      throw new Error("Could not find the BeSwift sign-in submit button.");
    }
    submit.click();
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

  async function fillHeader(payload) {
    const t = payload.transport || {};
    const inv = payload.invoiceDetails || {};
    const imp = payload.importer || {};

    // General Information — Regime/Service Type are fixed values, and the
    // rest of the form (Applicant/Exporter/Importer/Producer/Consignee/
    // Transport/Invoice sections) doesn't even render until both are picked
    // (confirmed live — the form is empty except these two fields at first).
    await pickByLabel("Regime", payload.regime || "Export");
    await pickByLabel("Service Type", payload.serviceType || "Certificate of Origin - CARICOM");
    setByLabel("Applicant Reference", payload.applicantReference);
    setByLabel("Contact Name", payload.applicant?.contacts?.[0]?.name);
    setByLabel("Contact Mobile No", payload.applicant?.contacts?.[0]?.mobile);
    setByLabel("Contact Email", payload.applicant?.contacts?.[0]?.email);

    // Applicant Details — Applicant Type defaults to "Personal" (confirmed live:
    // prefills the logged-in BeSwift user's own individual TIN/name), but Classic
    // Visions must file as "Other" (a company). Switching to "Other" clears those
    // fields and turns TIN into a dropdown with exactly one option (CONFIG.company.tin);
    // selecting it auto-fills Name/Address/Country/Parish, so nothing else needs
    // to be set here. Scope both the radio click and the TIN pick to the Applicant
    // Details section — "Other" and "TIN" both also appear in Exporter/Producer/
    // Consignee sections further down the form.
    const applicantSection = findSectionContainer("Applicant Details");
    if ((payload.applicantType || "Other").toLowerCase() === "other") {
      clickByText("Other", applicantSection || document);
      await wait(300);
      await pickByLabel("TIN", payload.applicant?.tin, applicantSection || document);
    }

    // Exporter/Supplier Details defaults to "Same as Applicant" checked
    // (confirmed live) — this click is a no-op safety net in case it isn't.
    const exporterSection = findSectionContainer("Exporter/Supplier Details");
    clickByText("Same as Applicant", exporterSection || document);

    // Importer Details is a separate section (Name/Address/Country only) that
    // sits side-by-side with Exporter/Supplier — must scope to it specifically,
    // since Applicant/Exporter/Producer/Consignee all expose fields with the
    // exact same labels (confirmed live: Name/Address/Country repeat 4+ times).
    const importerSection = findSectionContainer("Importer Details");
    setByLabel("Name", imp.name, importerSection || document);
    setByLabel("Address", imp.address, importerSection || document);
    await pickByLabel("Country", imp.country, importerSection || document);

    // Producer/Manufacturer Details — assume a single producer (Classic
    // Visions itself) and reuse the Exporter/Supplier details for it.
    const producerSection = findSectionContainer("Producer/Manufacturer Details");
    clickByText("Single", producerSection || document);
    clickByText("Same as Exporter", producerSection || document);

    // Consignee Details — same company as Importer.
    const consigneeSection = findSectionContainer("Consignee Details");
    clickByText("Same As Importer", consigneeSection || document);

    // Transport Information
    setByLabel("Shipping Marks", (t.shippingMarks || "").slice(0, 35));
    setByLabel("Shipping Date", t.shippingDate);
    setByLabel("Other Transport Information", t.trackingNumber ? `AWB: ${t.trackingNumber}` : "");
    await pickByLabel("Port Of Loading", t.portOfLoading || "GRANTLEY");
    await pickByLabel("Country Of Destination", t.countryOfDestination);
    await pickByLabel("Port Of Discharge", t.portOfDischarge);
    await pickByLabel("Mode Of Transport", t.modeOfTransport);
    await pickByLabel("Carrier", t.carrier);
    await pickByLabel("Delivery Terms", t.deliveryTerms || "Free on Board");

    // Invoice Details
    await pickByLabel("Currency", inv.currency === "BB$" ? "BARBADOS DOLLAR" : inv.currency);
    setByLabel("Customer Order No.", inv.customerOrderNo);
    setByLabel("Presenting Bank", inv.presentingBank);
    setByLabel("Cube Quantity", inv.cubeQuantity);
    setByLabel("Freight Cost", inv.freightCost);
  }

  async function fillItems(payload) {
    for (let i = 0; i < (payload.items || []).length; i += 1) {
      const item = payload.items[i];
      const opened = await clickAddItem();
      if (!opened) {
        showBanner(`Header filled. Add Item button was not found; add item ${i + 1} manually from the OptiLens payload.`);
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
      // code without going through that modal was NOT confirmed live — check
      // the first real run and switch to driving the search modal if it's
      // rejected.
      setByLabel("Commodity", item.hsCode, root);
      setByLabel("Commercial Description", item.commercialDescription, root);
      clickByText(payload.origin?.commodityType || "Manufactured", root);
      setByLabel("Manufacturer Name", payload.producer?.name, root);
      await pickByLabel("Country of Origin", payload.origin?.countryOfOrigin, root);
      await pickByLabel("Rule Of Origin", payload.origin?.ruleOfOrigin || "Percentage Value", root);
      await pickByLabel("Origin Criterion", payload.origin?.originCriterion || "L", root);
      setByLabel("Gross Weight", item.weightKg, root);
      setByLabel("Invoice #", payload.invoiceDetails?.invoiceNumbers, root);
      setByLabel("Invoice Date", payload.invoiceDetails?.invoiceDate, root);
      setByLabel("Number of Package", payload.packaging?.numberOfPackages, root);
      await pickByLabel("Package Type", payload.packaging?.packageType || "Box, fibreboard", root);
      setByLabel("Item Quantity", item.quantity, root);
      await pickByLabel("Unit of Measure", item.uom || "Number of Units", root);
      setByLabel("Unit Cost", item.unitCost, root);
      clickDialogSave(root);
      await wait(900);
    }
  }

  async function clickAddItem() {
    const button = [...document.querySelectorAll("button")]
      .find((el) => /add item|add commodity|item/i.test(el.textContent || "") && !el.disabled);
    if (!button) return false;
    button.click();
    return true;
  }

  function clickDialogSave(root) {
    const buttons = [...root.querySelectorAll("button")];
    const save = buttons.find((el) => /save|ok|add|check|✓/i.test(el.textContent || el.getAttribute("aria-label") || "") && !el.disabled);
    if (save) save.click();
  }

  function setByLabel(label, value, root = document) {
    if (value === undefined || value === null || value === "") return false;
    const el = findByAny([label], root);
    if (!el) return false;
    if (!isEditable(el)) throw new Error(`${label} is not editable.`);
    typeValue(el, String(value));
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
    // a real OS-level mouse click) opens it. typeValue() below still writes
    // the correct-looking text straight into the input regardless (that part
    // is just DOM manipulation), which is exactly why this failure mode looks
    // like a "stuck" or "not committed" dropdown rather than an obvious
    // error: the field visibly shows the right text, but the component's
    // real selection state — and everything that cascades from it, e.g.
    // Service Type unlocking the rest of the form — never actually happened.
    // Fix: ask background.js to open the field via chrome.debugger (Chrome
    // DevTools Protocol), which injects mouse events the page treats as
    // trusted, same mechanism Puppeteer/Playwright rely on.
    await cdpClickElement(el);
    await wait(250);
    typeValue(el, String(value));

    // Some option lists (e.g. Country, seen live showing a loading spinner
    // and "field is required" error) appear to load asynchronously and may
    // not be ready right when typing happens — retype once partway through
    // the wait to re-trigger filtering against a list that's since finished
    // loading, and use a longer overall timeout for this class of field.
    let option = await waitFor(() => findVisibleDropdownOption(value), 3000, 150);
    if (!option) {
      typeValue(el, String(value));
      option = await waitFor(() => findVisibleDropdownOption(value), 5000, 150);
    }
    if (option) {
      // The resolved option is a real rendered element too — click it the
      // same trusted way, for the same reason as above.
      await cdpClickElement(option);
    } else {
      // Last-resort fallback for any field that isn't this autocomplete
      // widget (kept from before the CDP fix, cheap to leave in place).
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
      await wait(200);
      el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    }
    await wait(300);
    return true;
  }

  // Asks background.js to click the center of `el` via chrome.debugger
  // (Input.dispatchMouseEvent) instead of el.click() — see pickByLabel's
  // comment for why a content-script click doesn't work for this component.
  function cdpClickElement(el) {
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
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

  function findVisibleDropdownOption(value) {
    const menu = [...document.querySelectorAll(".v-menu__content.menuable__content__active, .v-autocomplete__content, .v-select-list")]
      .find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    if (!menu) return null;
    const needle = String(value).trim().toLowerCase();
    const items = [...menu.querySelectorAll(".v-list-item")];
    return items.find((li) => (li.textContent || "").trim().toLowerCase() === needle)
      || items.find((li) => (li.textContent || "").trim().toLowerCase().includes(needle));
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
    const allHeadings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6,.v-card__title,.v-toolbar__title,.v-subheader,legend")]
      .filter((el) => (el.textContent || "").trim().length > 0);
    const heading = allHeadings.find((el) => (el.textContent || "").trim().toLowerCase() === needle);
    if (!heading) return null;

    let container = heading.parentElement;
    let best = container;
    while (container && container !== document.body) {
      const headingsInside = allHeadings.filter((h) => container.contains(h));
      if (headingsInside.length === 1) {
        best = container;
        container = container.parentElement;
      } else {
        break;
      }
    }
    return best;
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

  function clickByText(text, root = document) {
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
    if (!candidates.length) return;
    candidates.sort((a, b) => (a.textContent || "").length - (b.textContent || "").length);
    const hit = candidates[0];
    const input = hit.matches("input") ? hit : hit.querySelector?.("input");
    if (input && !input.checked) input.click();
    else if (hit.matches("button")) hit.click();
  }

  function typeValue(el, value) {
    el.focus();
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isEditable(el) {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + Math.min(8, box.width / 2), box.top + Math.min(8, box.height / 2));
    return !el.disabled && !el.readOnly && style.pointerEvents !== "none" && (!top || top === el || el.contains(top) || top.contains(el));
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
    banner.style.cssText = "position:fixed;z-index:2147483647;left:16px;right:16px;bottom:16px;padding:12px 14px;background:#0b1e35;color:#fff;border-radius:8px;font:13px Segoe UI,Arial,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.28)";
    document.body.appendChild(banner);
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
