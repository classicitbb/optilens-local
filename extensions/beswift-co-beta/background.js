// Right-click "companion" to the popup's Resume button — lets an operator fix
// a stuck field directly on the page (no need to switch focus to the popup,
// which unloads its own log/Resume view anyway when it loses focus) and
// resume from wherever they are. Not field-specific: it resumes whichever job
// is currently paused for this tab, which is enough context for the operator
// (the paused banner/log entry already says which field needed a look).
// removeAll+create at top-level (not gated on onInstalled) because MV3 service
// workers restart frequently and onInstalled only fires on actual
// install/update — this way the menu item is always there whenever the
// worker wakes up, without erroring on a duplicate id.
chrome.contextMenus.removeAll(() => {
  chrome.contextMenus.create({
    id: "optilens-beswift-resume",
    title: "OptiLens BeSwift (Beta): Resume automation",
    contexts: ["all"]
  });
});

// Tracks which job (if any) is running in which tab, so the context-menu
// handler (which only gets a tabId, not the job) knows what to resume.
const tabJobs = new Map();

// ---------------------------------------------------------------------------
// Auto-drive harness (beta only, opt-in via the popup's "Auto-drive" toggle or
// chrome.storage.local.autoDrive). Polls the OptiLens server for a queued job
// and starts it without a popup click, closing the previous run's BeSwift tab
// first. This is what turns "fix code → create job → click popup → watch" into
// an unattended fix/retry loop: create a job server-side and it runs itself.
// Deliberately conservative — one job at a time, only while enabled, and it
// never claims a job that is already claimed/running.
// ---------------------------------------------------------------------------
const AUTO_DRIVE_ALARM = "optilens-beswift-autodrive";
let autoDriveBusy = false;
let autoDriveTabId = null;

chrome.alarms.create(AUTO_DRIVE_ALARM, { periodInMinutes: 0.25 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTO_DRIVE_ALARM) pollForQueuedJob().catch(() => {});
});

// Self-reload. Neither the Chrome MCP nor any other automation we have
// reach edge://extensions (Edge is the browser this runs in), so a code change
// to THIS file or the manifest would otherwise strand the extension on stale
// code until a human clicks Reload. Instead the worker asks the server for a
// fingerprint of the extension's own files and reloads itself when it changes.
// Guarded to idle only — reloading mid-fill would kill a running certificate.
// The new stamp is stored BEFORE reload() so a failed reload can't loop.
async function reloadIfStale(base) {
  if (autoDriveBusy) return false;
  let stamp = null;
  try {
    const response = await fetch(`${base}/api/beswift-extension/build`, { cache: "no-store" });
    if (!response.ok) return false;
    stamp = (await response.json())?.stamp || null;
  } catch {
    return false;
  }
  if (!stamp) return false;

  const { buildStamp } = await chrome.storage.local.get(["buildStamp"]);
  if (!buildStamp) {
    // First sighting — record it without reloading, so enabling auto-drive
    // doesn't immediately bounce the worker.
    await chrome.storage.local.set({ buildStamp: stamp });
    return false;
  }
  if (buildStamp === stamp) return false;

  await chrome.storage.local.set({ buildStamp: stamp });
  chrome.runtime.reload();
  return true;
}

async function pollForQueuedJob() {
  if (autoDriveBusy) return;
  const { autoDrive, baseUrl } = await chrome.storage.local.get(["autoDrive", "baseUrl"]);
  if (!autoDrive || !baseUrl) return;
  const base = String(baseUrl).replace(/\/$/, "");

  // Pick up new code before claiming anything, so a job always runs against
  // the freshest build rather than one deploy behind.
  if (await reloadIfStale(base)) return;

  let job = null;
  try {
    const response = await fetch(`${base}/api/beswift-extension/next-job`, { cache: "no-store" });
    if (!response.ok) return;
    job = (await response.json())?.job || null;
  } catch {
    return; // server unreachable — try again on the next alarm
  }
  if (!job?.claimCode) return;

  autoDriveBusy = true;
  try {
    // Close the previous run's tab so each attempt starts from a clean
    // certificate form rather than stacking half-filled tabs.
    if (autoDriveTabId !== null) {
      await new Promise((resolve) => chrome.tabs.remove(autoDriveTabId, () => { void chrome.runtime.lastError; resolve(); }));
      autoDriveTabId = null;
    }
    const result = await startJob(base, job.claimCode);
    autoDriveTabId = result?.tabId ?? null;
  } catch {
    // startJob already reported the failure server-side; the next alarm will
    // pick up whatever job is queued after the operator/agent fixes the cause.
  } finally {
    autoDriveBusy = false;
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "optilens-beswift-resume" || !tab?.id) return;
  const job = tabJobs.get(tab.id);
  if (!job) return; // no known paused job for this tab — silently no-op
  resumeJobDirect(job.baseUrl, job.automationJobId, "Resumed via right-click.")
    .catch(() => {}); // best-effort; content.js's own poll loop will just keep waiting if this fails
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "reportStatus") {
    // The BeSwift page is HTTPS; a fetch() to our http:// OptiLens server made
    // from the content script (page context) gets blocked as mixed content.
    // Service worker fetches aren't subject to that page-level restriction, so
    // content.js relays status reports through here instead of fetching itself.
    reportJobStatus(message.baseUrl, message.jobId, message.status, message.message, message.details)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "pollJobStatus") {
    // Same mixed-content reasoning as reportStatus, other direction: content.js
    // (running on the HTTPS BeSwift page) can't GET our http:// status
    // endpoint directly during pauseForInteraction()'s poll loop, so it asks
    // the service worker to fetch it instead.
    fetchJobStatus(message.baseUrl, message.jobId)
      .then((job) => sendResponse({ ok: true, job }))
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
  if (message?.type === "cdpTypeText") {
    const tabId = sender.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: "No tab id on the type request." });
      return false;
    }
    handleCdpTypeText(tabId, message.text)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "recordResolution") {
    // Beta: relay the operator's error+resolution note to the OptiLens server
    // (content.js can't POST http:// from the HTTPS BeSwift page — mixed content).
    recordFillResolution(message.baseUrl, message.jobId, message.payload)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "resumeJob") {
    // Beta: on-page Resume button — same server /resume call the popup and the
    // right-click menu make, relayed through the worker (no mixed-content issue).
    resumeJobDirect(message.baseUrl, message.jobId, message.message || "Resumed by operator.")
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
    .then((result) => sendResponse({ ok: true, ...result }))
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

async function handleCdpTypeText(tabId, text) {
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
  await cdpSend(tabId, "Input.insertText", { text: String(text || "") });
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
chrome.tabs.onRemoved.addListener((tabId) => {
  debuggedTabs.delete(tabId);
  tabJobs.delete(tabId);
});

async function startJob(baseUrl, claimCode) {
  const response = await fetch(`${baseUrl}/api/beswift-extension/jobs/${encodeURIComponent(claimCode)}`, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Claim failed");

  const automationJobId = data.job?.automationJobId;

  try {
    const tab = await chrome.tabs.create({ url: certificateStartUrl(data.portal.url), active: true });
    tabJobs.set(tab.id, { baseUrl, automationJobId });

    // Step 1: try the certificate route on the BeSwift app origin first.
    // If the browser still has a valid BeSwift session, that tab can fill
    // immediately. If not, BeSwift either shows a Sign In trigger or redirects
    // to SSO; both branches below still fall back to the normal login flow.
    // Opening a fresh app tab per claimed job also means concurrent jobs do
    // not have to share or reuse one live form tab.
    await waitForTabState(tab.id, (url) => /^https?:\/\//i.test(url || ""));
    await settle(2500);
    let currentTab = await chromeTab(tab.id);
    let clickResult = { alreadySignedIn: false };

    if (!isSsoUrl(currentTab.url)) {
      clickResult = await sendToTab(tab.id, { type: "clickSignIn", baseUrl, automationJobId });
      await settle(800);
      currentTab = await chromeTab(tab.id);
    }

    if (!clickResult.alreadySignedIn) {
      // Step 2: wait for the SSO redirect to finish loading, then fill + submit
      // Keycloak's login form (fields confirmed live: #username, #password, #kc-login).
      if (!isSsoUrl(currentTab.url)) {
        await waitForTabState(tab.id, (url) => isSsoUrl(url));
      }
      await settle(600);
      await sendToTabAllowingNavigation(tab.id, {
        type: "fillLogin",
        baseUrl,
        automationJobId,
        username: data.portal.username,
        password: data.portal.password
      });

      // Step 3: wait for the post-login redirect back to the BeSwift app.
      await waitForTabState(
        tab.id,
        (url) => isBeswiftAppUrl(url) && !isSsoUrl(url)
      );
      await settle(600);
    }

    // Step 4: fill the certificate form (now authenticated either way).
    await sendToTab(tab.id, { type: "fillBeswiftCo", baseUrl, job: data.job, portal: data.portal, payload: data.payload });
    return { automationJobId, tabId: tab.id };
  } catch (error) {
    // If anything in the sign-in/fill flow fails, report it so the job doesn't
    // sit stuck in "claimed" forever with no explanation and no way to retry.
    await reportJobError(baseUrl, automationJobId, error.message || "Failed during the BeSwift sign-in/fill flow.");
    throw error;
  }
}

function certificateStartUrl(portalUrl) {
  const origin = appOriginForPortalUrl(portalUrl);
  return `${origin}/#/lpco/certificates/new`;
}

function appOriginForPortalUrl(portalUrl) {
  const raw = String(portalUrl || "").trim();
  try {
    const url = new URL(raw || "https://training.beswift.gov.bb/");
    const host = url.hostname.toLowerCase();
    if (host.includes("training.beswift.gov.bb")) return "https://training.beswift.gov.bb";
    if (host.includes("beswift.gov.bb")) return "https://beswift.gov.bb";
  } catch {
    // Fall through to the training app default below.
  }
  return "https://training.beswift.gov.bb";
}

function isSsoUrl(url) {
  return /^https:\/\/sso\./i.test(String(url || ""));
}

function isBeswiftAppUrl(url) {
  return /^https:\/\/(?:training\.)?beswift\.gov\.bb/i.test(String(url || ""));
}

function chromeTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(tab);
    });
  });
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

function sendToTabAllowingNavigation(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        const message = chrome.runtime.lastError.message || "";
        if (/message channel closed|receiving end does not exist|could not establish connection/i.test(message)) {
          resolve({});
          return;
        }
        reject(new Error(message));
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

async function reportJobStatus(baseUrl, automationJobId, status, message, details) {
  if (!automationJobId) return;
  await fetch(`${baseUrl}/api/beswift-extension/jobs/${encodeURIComponent(automationJobId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, message, details: details ?? null })
  });
}

// Read-only poll of the job's current status/log — used by
// pauseForInteraction()'s wait loop to notice a resume signal.
async function fetchJobStatus(baseUrl, automationJobId) {
  if (!automationJobId) throw new Error("No automation job id to poll.");
  const response = await fetch(`${baseUrl}/api/beswift-extension/jobs/${encodeURIComponent(automationJobId)}/status`, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Status poll failed.");
  return data.job;
}

// Beta: POST an operator's error+resolution note. Service-worker fetch, so no
// mixed-content concern posting to the http:// OptiLens server.
async function recordFillResolution(baseUrl, automationJobId, payload) {
  if (!automationJobId) throw new Error("No automation job id for the resolution note.");
  const response = await fetch(
    `${baseUrl}/api/beswift-extension/jobs/${encodeURIComponent(automationJobId)}/resolution`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {})
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Resolution save failed.");
  return data.resolution;
}

// Used by the right-click "Resume automation" menu item — a service-worker
// fetch, same as everywhere else in this file, so no mixed-content concern.
async function resumeJobDirect(baseUrl, automationJobId, message) {
  if (!automationJobId) throw new Error("No automation job id to resume.");
  const response = await fetch(
    `${baseUrl}/api/beswift-extension/jobs/${encodeURIComponent(automationJobId)}/resume?message=${encodeURIComponent(message || "")}`,
    { cache: "no-store" }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Resume failed.");
  return data.job;
}
