const baseInput = document.querySelector("#baseUrl");
const claimInput = document.querySelector("#claimCode");
const startBtn = document.querySelector("#startBtn");
const statusEl = document.querySelector("#status");
const jobPanel = document.querySelector("#jobPanel");
const jobStatusLine = document.querySelector("#jobStatusLine");
const resumeBtn = document.querySelector("#resumeBtn");
const jobLogEl = document.querySelector("#jobLog");

let pollTimer = null;

chrome.storage.local.get(["baseUrl", "lastAutomationJobId"], (data) => {
  if (data.baseUrl) baseInput.value = data.baseUrl;
  // The extension popup unloads whenever it loses focus (normal Chrome
  // behavior) — the fill/pause loop lives on in content.js/the server
  // regardless, so reopening the popup just needs to pick the live status
  // panel back up rather than losing track of the job.
  if (data.lastAutomationJobId) {
    startPolling(baseInput.value.trim().replace(/\/$/, ""), data.lastAutomationJobId);
  }
});

startBtn.addEventListener("click", () => {
  const baseUrl = baseInput.value.trim().replace(/\/$/, "");
  const claimCode = claimInput.value.trim();
  if (!baseUrl || !claimCode) {
    statusEl.textContent = "Enter the OptiLens URL and claim code.";
    return;
  }
  chrome.storage.local.set({ baseUrl });
  statusEl.textContent = "Claiming job...";
  chrome.runtime.sendMessage({ type: "startJob", baseUrl, claimCode }, (response) => {
    if (chrome.runtime.lastError) {
      statusEl.textContent = chrome.runtime.lastError.message;
      return;
    }
    statusEl.textContent = response?.ok ? "Portal opened. Keep this browser window active for review." : (response?.error || "Unable to start job.");
    if (response?.ok && response.automationJobId) {
      chrome.storage.local.set({ lastAutomationJobId: response.automationJobId });
      startPolling(baseUrl, response.automationJobId);
    }
  });
});

resumeBtn.addEventListener("click", async () => {
  const baseUrl = baseInput.value.trim().replace(/\/$/, "");
  const jobId = resumeBtn.dataset.jobId;
  if (!jobId) return;
  resumeBtn.disabled = true;
  resumeBtn.textContent = "Resuming...";
  try {
    const response = await fetch(`${baseUrl}/api/beswift-extension/jobs/${encodeURIComponent(jobId)}/resume`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Resume failed.");
  } catch (error) {
    jobStatusLine.textContent = `Resume failed: ${error.message}`;
  } finally {
    resumeBtn.disabled = false;
    resumeBtn.textContent = "Resume";
  }
});

// Polls the read-only status endpoint directly — popup pages (chrome-extension://
// origin) aren't subject to the mixed-content block that forces content.js to
// relay through background.js, so this can fetch http:// straight away.
function startPolling(baseUrl, automationJobId) {
  if (pollTimer) clearInterval(pollTimer);
  jobPanel.hidden = false;
  resumeBtn.dataset.jobId = automationJobId;
  const tick = async () => {
    try {
      const response = await fetch(`${baseUrl}/api/beswift-extension/jobs/${encodeURIComponent(automationJobId)}/status`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Status fetch failed.");
      renderJob(data.job);
    } catch (error) {
      jobStatusLine.textContent = `Status unavailable: ${error.message}`;
    }
  };
  tick();
  pollTimer = setInterval(tick, 2000);
}

function renderJob(job) {
  jobStatusLine.textContent = `Job ${job.automationJobId} — status: ${job.status}`;
  resumeBtn.hidden = job.status !== "paused";
  const entries = Array.isArray(job.logs) ? job.logs.slice(-15) : [];
  jobLogEl.innerHTML = "";
  for (const entry of entries) {
    const li = document.createElement("li");
    const time = entry.at ? new Date(entry.at).toLocaleTimeString() : "";
    li.textContent = `[${time}] ${entry.status}: ${entry.message || ""}`;
    jobLogEl.appendChild(li);
  }
}
