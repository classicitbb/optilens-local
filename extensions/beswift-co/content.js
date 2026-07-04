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
    setByLabel("Applicant Reference", payload.applicantReference);
    setByLabel("Contact Name", payload.applicant?.contacts?.[0]?.name);
    setByLabel("Contact Mobile No", payload.applicant?.contacts?.[0]?.mobile);
    setByLabel("Contact Email", payload.applicant?.contacts?.[0]?.email);
    clickByText("Same As Importer");
    clickByText("Same as Exporter");
    setByLabel("Name", imp.name);
    setByLabel("Address", imp.address);
    setByLabel("Shipping Marks", (t.shippingMarks || "").slice(0, 35));
    setByLabel("Shipping Date", t.shippingDate);
    setByLabel("Other Transport Information", t.trackingNumber ? `AWB: ${t.trackingNumber}` : "");
    setByLabel("Customer Order No.", inv.customerOrderNo);
    setByLabel("Cube Quantity", inv.cubeQuantity);
    setByLabel("Freight Cost", inv.freightCost);
    await pickByLabel("Country", imp.country);
    await pickByLabel("Port Of Loading", t.portOfLoading || "GRANTLEY");
    await pickByLabel("Country Of Destination", t.countryOfDestination);
    await pickByLabel("Port Of Discharge", t.portOfDischarge);
    await pickByLabel("Mode Of Transport", t.modeOfTransport);
    await pickByLabel("Carrier", t.carrier);
    await pickByLabel("Delivery Terms", t.deliveryTerms || "Free on Board");
    await pickByLabel("Currency", inv.currency === "BB$" ? "BARBADOS DOLLAR" : inv.currency);
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
      await pickByLabel("Commodity", item.hsCode, root);
      setByLabel("Commercial Description", item.commercialDescription, root);
      clickByText(payload.origin?.commodityType || "Manufactured", root);
      setByLabel("Manufacturer Name", payload.producer?.name, root);
      await pickByLabel("Country of Origin", payload.origin?.countryOfOrigin, root);
      await pickByLabel("Rule Of Origin", payload.origin?.ruleOfOrigin || "Percentage Value", root);
      await pickByLabel("Origin Criterion", "L", root);
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
    typeValue(el, String(value));
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    await wait(200);
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    return true;
  }

  function findByAny(labels, root = document) {
    const wanted = labels.map((label) => String(label).toLowerCase());
    const inputs = [...root.querySelectorAll("input,textarea,select")];
    return inputs.find((el) => {
      const aria = String(el.getAttribute("aria-label") || "").toLowerCase();
      const name = String(el.getAttribute("name") || "").toLowerCase();
      const id = String(el.id || "").toLowerCase();
      const placeholder = String(el.getAttribute("placeholder") || "").toLowerCase();
      const text = [aria, name, id, placeholder].join(" ");
      return wanted.some((label) => text.includes(label));
    });
  }

  function clickByText(text, root = document) {
    const needle = String(text).toLowerCase();
    const hit = [...root.querySelectorAll("label,button,.v-input,.v-label,.v-radio")]
      .find((el) => String(el.textContent || "").toLowerCase().includes(needle));
    const input = hit?.querySelector?.("input");
    if (input && !input.checked) input.click();
    else if (hit && hit.matches("button")) hit.click();
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
