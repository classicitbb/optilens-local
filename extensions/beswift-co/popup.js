const baseInput = document.querySelector("#baseUrl");
const claimInput = document.querySelector("#claimCode");
const startBtn = document.querySelector("#startBtn");
const statusEl = document.querySelector("#status");

chrome.storage.local.get(["baseUrl"], (data) => {
  if (data.baseUrl) baseInput.value = data.baseUrl;
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
  });
});
