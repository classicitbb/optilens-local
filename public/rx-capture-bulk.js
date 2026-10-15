// Bulk upload for RX Capture, shared by the capture page (browser) and the
// tests. It only decides which dropped files are acceptable, uploads them a few
// at a time and words the progress. Reading the prescriptions happens on the
// server, one queued order per file.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.RxBulk = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const MAX_FILES = 100;
  const MAX_FILE_BYTES = 8 * 1024 * 1024;
  const UPLOAD_CONCURRENCY = 3;

  const isPdf = (file) => file.type === "application/pdf" || (!file.type && /\.pdf$/i.test(file.name || ""));
  const isImage = (file) => String(file.type || "").startsWith("image/");

  function fileKey(file) {
    return [file.name, file.size, file.lastModified || 0].join("|");
  }

  // Splits dropped or chosen files into those that can be queued and those that
  // cannot (with the reason). `existing` are items already in the list.
  function acceptFiles(files, existing = []) {
    const seen = new Set(existing.map((item) => fileKey(item.file)));
    const accepted = [];
    const rejected = [];
    for (const file of Array.from(files || [])) {
      if (!isPdf(file) && !isImage(file)) { rejected.push({ name: file.name, reason: "Not an image or PDF." }); continue; }
      if (file.size > MAX_FILE_BYTES) { rejected.push({ name: file.name, reason: "Larger than 8 MB." }); continue; }
      if (!file.size) { rejected.push({ name: file.name, reason: "The file is empty." }); continue; }
      const key = fileKey(file);
      if (seen.has(key)) { rejected.push({ name: file.name, reason: "Already in the list." }); continue; }
      if (existing.length + accepted.length >= MAX_FILES) { rejected.push({ name: file.name, reason: `Only ${MAX_FILES} files per bulk upload.` }); continue; }
      seen.add(key);
      accepted.push({ file, status: "ready", message: "" });
    }
    return { accepted, rejected };
  }

  function newBatchId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const hex = (count) => Array.from({ length: count }, () => Math.floor(Math.random() * 16).toString(16)).join("");
    return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
  }

  // Uploads every item that is ready or failed before, a few at a time. A file
  // that fails does not stop the others. `upload(item)` resolves on success and
  // throws an error (optionally with .status) otherwise.
  async function uploadAll(items, upload, { concurrency = UPLOAD_CONCURRENCY, onUpdate = () => {} } = {}) {
    const pending = items.filter((item) => item.status === "ready" || item.status === "error");
    let cursor = 0;
    async function worker() {
      while (cursor < pending.length) {
        const item = pending[cursor];
        cursor += 1;
        item.status = "uploading";
        item.message = "";
        onUpdate(item);
        try {
          await upload(item);
          item.status = "queued";
        } catch (error) {
          if (error?.status === 409 && /already uploaded/i.test(error.message || "")) {
            item.status = "duplicate";
          } else {
            item.status = "error";
          }
          item.message = String(error?.message || "Upload failed.");
        }
        onUpdate(item);
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
    return countItems(items);
  }

  function countItems(items) {
    const counts = { ready: 0, uploading: 0, queued: 0, duplicate: 0, error: 0 };
    for (const item of items) counts[item.status] = (counts[item.status] || 0) + 1;
    return counts;
  }

  // One-line progress for the batch banner on the recent orders screen.
  function progressText(summary) {
    if (!summary || !summary.total) return "Waiting for the first file…";
    const parts = [];
    if (summary.finished) {
      parts.push(`All ${summary.total} read`);
      parts.push(`${summary.ready} ready to review`);
    } else {
      parts.push(`${summary.done} of ${summary.total} read`);
      if (summary.processing) parts.push(`${summary.processing} reading now`);
      if (summary.queued) parts.push(`${summary.queued} waiting`);
      if (summary.ready) parts.push(`${summary.ready} ready to review`);
    }
    if (summary.needsAttention) parts.push(`${summary.needsAttention} need attention`);
    if (summary.failed) parts.push(`${summary.failed} failed`);
    return parts.join(" · ");
  }

  function percentDone(summary) {
    if (!summary || !summary.total) return 0;
    return Math.round((summary.done / summary.total) * 100);
  }

  function formatSize(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return { MAX_FILES, MAX_FILE_BYTES, UPLOAD_CONCURRENCY, acceptFiles, countItems, formatSize, newBatchId, percentDone, progressText, uploadAll };
});
