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
  if (message?.type !== "startJob") return false;
  startJob(message.baseUrl, message.claimCode)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "Job failed" }));
  return true;
});

async function startJob(baseUrl, claimCode) {
  const response = await fetch(`${baseUrl}/api/beswift-extension/jobs/${encodeURIComponent(claimCode)}`, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Claim failed");

  try {
    const tab = await chrome.tabs.create({ url: data.portal.url, active: true });
    await waitForTab(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: "fillBeswiftCo", baseUrl, job: data.job, portal: data.portal, payload: data.payload });
  } catch (error) {
    // If anything after claiming fails (tab didn't open, content script never
    // received the message, etc.), report it so the job doesn't sit stuck in
    // "claimed" forever with no explanation and no way to retry.
    await reportJobError(baseUrl, data.job?.automationJobId, error.message || "Failed to open the BeSwift tab or reach the fill script.");
    throw error;
  }
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

function waitForTab(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1200);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}
