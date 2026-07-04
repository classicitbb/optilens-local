chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "reportStatus") {
    // The BeSwift page is HTTPS; a fetch() to our http:// OptiLens server made
    // from the content script (page context) gets blocked as mixed content.
    // Service worker fetches aren't subject to that page-level restriction, so
    // content.js relays status reports through here instead of fetching itself.
    reportJobStatus(message.baseUrl, message.jobId, message.status, message.message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "cdpClickPoint") {
    // See handleCdpClick's comment below for why this exists — content.js
    // cannot reliably click Vuetify's dropdown fields/options itself.
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "No tab id on the click request." });
      return false;
    }
    handleCdpClick(tabId, message.x, message.y)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "cdpDetach") {
    const tabId = sender.tab?.id;
    if (tabId) detachDebugger(tabId);
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type !== "startJob") return false;
  startJob(message.baseUrl, message.claimCode)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "Job failed" }));
  return true;
});

// Confirmed live (2026-07-04): a content script's own el.click() — and every
// JS-dispatchable equivalent (MouseEvent mousedown/mouseup/click sequences,
// PointerEvent sequences, even keyboard ArrowDown/Enter) — toggles Vuetify's
// "is-menu-active" CSS class on the field's wrapper, but never actually
// mounts/activates the real .v-menu__content dropdown overlay (it stays in
// the DOM with 0x0 dimensions and no "active" class). Only a genuinely
// trusted click — confirmed live via Claude's own OS-level computer-use mouse
// click during manual testing — opens it. This is why fillHeader/fillItems
// were getting "stuck": pickByLabel's typeValue() call still writes the
// correct-looking text into the field (that part IS just DOM manipulation,
// so it always "worked"), but with no real dropdown ever opened there was no
// option to click and no genuine Vuetify v-model commit — so the visible
// text looked right while the component's actual selection state, and
// everything cascading from it (Service Type unlocking the rest of the form,
// in particular), silently never happened.
//
// A content script cannot generate a truly trusted input event — that's a
// hard browser guarantee, not something fixable by any dispatchEvent trick.
// The Chrome DevTools Protocol (reachable from the extension's background
// service worker via chrome.debugger, which Puppeteer/Playwright also build
// on for exactly this reason) injects mouse events at the same level as real
// OS input and IS treated as trusted by the page. So: content.js now asks
// background.js to perform the actual click via chrome.debugger, at a
// viewport coordinate content.js computed from the target element's own
// getBoundingClientRect() — used both for opening a dropdown field and for
// clicking its resolved option.
const debuggedTabs = new Set();

async function handleCdpClick(tabId, x, y) {
  if (!debuggedTabs.has(tabId)) {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        debuggedTabs.add(tabId);
        resolve();
      });
    });
  }
  await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdpSend(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

function cdpSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
}

function detachDebugger(tabId) {
  if (!debuggedTabs.has(tabId)) return;
  debuggedTabs.delete(tabId);
  chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
}

// If the tab navigates or closes mid-fill, drop our bookkeeping so a later
// job against a reused tabId doesn't skip re-attaching.
chrome.tabs.onRemoved.addListener((tabId) => debuggedTabs.delete(tabId));

async function startJob(baseUrl, claimCode) {
  const response = await fetch(`${baseUrl}/api/beswift-extension/jobs/${encodeURIComponent(claimCode)}`, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Claim failed");

  const automationJobId = data.job?.automationJobId;

  try {
    const tab = await chrome.tabs.create({ url: data.portal.url, active: true });

    // Step 1: land on the BeSwift home page and click Sign In. This triggers a
    // real cross-origin OAuth redirect to a Keycloak SSO login page, which
    // fully unloads this tab's script context (confirmed live) — so the login
    // step below has to run as a *separate* content.js injection on the new
    // page, driven by this background script watching tab navigation, rather
    // than one continuous script surviving the redirect.
    await waitForTabState(tab.id, (url) => /^https?:\/\//i.test(url || ""));
    await settle(600);
    const clickResult = await sendToTab(tab.id, { type: "clickSignIn", baseUrl, automationJobId });

    if (!clickResult.alreadySignedIn) {
      // Step 2: wait for the SSO redirect to finish loading, then fill + submit
      // Keycloak's login form (fields confirmed live: #username, #password, #kc-login).
      await waitForTabState(tab.id, (url) => /^https:\/\/sso\./i.test(url || ""));
      await settle(600);
      await sendToTab(tab.id, {
        type: "fillLogin",
        baseUrl,
        automationJobId,
        username: data.portal.username,
        password: data.portal.password
      });

      // Step 3: wait for the post-login redirect back to the BeSwift app.
      await waitForTabState(
        tab.id,
        (url) => /^https:\/\/(?:training\.)?beswift\.gov\.bb/i.test(url || "") && !/^https:\/\/sso\./i.test(url || "")
      );
      await settle(600);
    }

    // Step 4: fill the certificate form (now authenticated either way).
    await sendToTab(tab.id, { type: "fillBeswiftCo", baseUrl, job: data.job, portal: data.portal, payload: data.payload });
  } catch (error) {
    // If anything in the sign-in/fill flow fails, report it so the job doesn't
    // sit stuck in "claimed" forever with no explanation and no way to retry.
    await reportJobError(baseUrl, automationJobId, error.message || "Failed during the BeSwift sign-in/fill flow.");
    throw error;
  }
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response && response.ok === false) {
        reject(new Error(response.error || "A BeSwift automation step failed."));
        return;
      }
      resolve(response || {});
    });
  });
}

// Waits for the tab to reach "complete" status while its URL satisfies
// predicate. Checks current state first (in case it's already there), then
// listens for further navigation, so it's safe to call repeatedly across
// multiple hops (home page -> SSO -> back to home page) without racing a
// state change that already happened before the listener was attached.
function waitForTabState(tabId, predicate, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let settledFlag = false;
    const finish = (fn, arg) => {
      if (settledFlag) return;
      settledFlag = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      fn(arg);
    };
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (tab.status === "complete" && predicate(tab.url)) finish(resolve);
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        finish(reject, new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tab.status === "complete" && predicate(tab.url)) finish(resolve);
    });
    const timer = setTimeout(
      () => finish(reject, new Error("Timed out waiting for the BeSwift page to reach the expected state.")),
      timeoutMs
    );
  });
}

function settle(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reportJobError(baseUrl, automationJobId, message) {
  await reportJobStatus(baseUrl, automationJobId, "error", message).catch(() => {});
}

async function reportJobStatus(baseUrl, automationJobId, status, message) {
  if (!automationJobId) return;
  await fetch(`${baseUrl}/api/beswift-extension/jobs/${encodeURIComponent(automationJobId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, message })
  });
}
