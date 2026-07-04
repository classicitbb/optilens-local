chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

  const tab = await chrome.tabs.create({ url: data.portal.url, active: true });
  await waitForTab(tab.id);
  await chrome.tabs.sendMessage(tab.id, { type: "fillBeswiftCo", baseUrl, job: data.job, portal: data.portal, payload: data.payload });
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
