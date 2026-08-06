const baseInput = document.querySelector("#baseUrl");
const claimInput = document.querySelector("#claimCode");
const startBtn = document.querySelector("#startBtn");
const statusEl = document.querySelector("#status");
const jobPanel = document.querySelector("#jobPanel");
const jobStatusLine = document.querySelector("#jobStatusLine");
const resumeBtn = document.querySelector("#resumeBtn");
const jobLogEl = document.querySelector("#jobLog");
const resolutionBox = document.querySelector("#resolutionBox");
const resField = document.querySelector("#resField");
const resExpected = document.querySelector("#resExpected");
const resActual = document.querySelector("#resActual");
const resFix = document.querySelector("#resFix");
const resNote = document.querySelector("#resNote");

let pollTimer = null;

const autoDriveInput = document.querySelector("#autoDrive");

// Auto-drive: background.js polls /api/beswift-extension/next-job on an alarm
// and starts whatever job is queued, so an agent can create a job server-side
// and have it run (and re-run after a code fix) with no popup click. Persisting
// baseUrl here matters — the worker reads it from storage, not from this form.
autoDriveInput.addEventListener("change", () => {
  const baseUrl = baseInput.value.trim().replace(/\/$/, "");
  chrome.storage.local.set({ autoDrive: autoDriveInput.checked, baseUrl });
  statusEl.textContent = autoDriveInput.checked
    ? "Auto-drive on — queued jobs will start themselves."
    : "Auto-drive off.";
});

chrome.storage.local.get(["baseUrl", "lastAutomationJobId", "autoDrive"], (data) => {
  if (data.baseUrl) baseInput.value = data.baseUrl;
  autoDriveInput.checked = Boolean(data.autoDrive);
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
    // Beta: if the operator recorded what went wrong, POST it first so it's
    // captured for a later AI refinement pass, then resume the job. Popup pages
    // (chrome-extension:// origin) can fetch http:// directly — no relay needed.
    const payload = {
      field: resField.value.trim(),
      expected: resExpected.value.trim(),
      actual: resActual.value.trim(),
      fix: resFix.value.trim(),
      note: resNote.value.trim(),
      source: "beta-popup"
    };
    if (payload.field || payload.expected || payload.actual || payload.fix || payload.note) {
      await fetch(`${baseUrl}/api/beswift-extension/jobs/${encodeURIComponent(jobId)}/resolution`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).catch(() => {}); // don't block resume on a note-write failure
    }
    const response = await fetch(`${baseUrl}/api/beswift-extension/jobs/${encodeURIComponent(jobId)}/resume`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Resume failed.");
    [resField, resExpected, resActual, resFix, resNote].forEach((el) => { el.value = ""; });
  } catch (error) {
    jobStatusLine.textContent = `Resume failed: ${error.message}`;
  } finally {
    resumeBtn.disabled = false;
    resumeBtn.textContent = "Save fix & Resume";
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
  const paused = job.status === "paused";
  resumeBtn.hidden = !paused;
  resolutionBox.hidden = !paused;
  // Prefill the fix form from the latest 'paused' log entry's field/expected,
  // when the pause named a specific field — but don't clobber what the operator
  // is already typing.
  if (paused && !resField.value && !resFix.value) {
    const logs = Array.isArray(job.logs) ? job.logs : [];
    const lastPause = [...logs].reverse().find((entry) => entry?.status === "paused");
    const match = /Field "([^"]+)" needs a manual fix \(expected "([^"]*)"\)/.exec(lastPause?.message || "");
    if (match) {
      resField.value = match[1];
      resExpected.value = match[2];
    }
  }
  const entries = Array.isArray(job.logs) ? job.logs.slice(-15) : [];
  jobLogEl.innerHTML = "";
  for (const entry of entries) {
    const li = document.createElement("li");
    const time = entry.at ? new Date(entry.at).toLocaleTimeString() : "";
    li.textContent = `[${time}] ${entry.status}: ${entry.message || ""}`;
    jobLogEl.appendChild(li);
  }
}
