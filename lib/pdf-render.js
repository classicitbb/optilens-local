const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { protectPdf } = require("./pdf-protect");

// Renders printable HTML to a real, vector PDF with the machine's own
// Chromium-based browser (Edge ships with Windows) so the saved file is the same
// layout the preview and print dialog show: selectable text, embedded fonts,
// the page size from the document's @page rule.

const RENDER_TIMEOUT_MS = 45000;

function findBrowser() {
  const candidates = [
    process.env.OPTILENS_PDF_BROWSER,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    const error = new Error("PDF export needs Microsoft Edge or Google Chrome on the server (or set OPTILENS_PDF_BROWSER to its path).");
    error.statusCode = 503;
    throw error;
  }
  return found;
}

// The browser profile directory is single-instance, so renders run one at a time.
let queue = Promise.resolve();

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}

async function waitForPdf(file, deadline) {
  while (Date.now() < deadline) {
    try {
      const bytes = fs.readFileSync(file);
      if (bytes.length > 1000 && bytes.subarray(-32).toString("latin1").includes("%%EOF")) return bytes;
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const error = new Error("The PDF could not be produced in time.");
  error.statusCode = 504;
  throw error;
}

async function renderOnce(html) {
  const browser = findBrowser();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-pdf-"));
  const htmlFile = path.join(work, `${crypto.randomUUID()}.html`);
  const pdfFile = path.join(work, "out.pdf");
  fs.writeFileSync(htmlFile, html, "utf8");
  const profile = path.join(os.tmpdir(), "optilens-pdf-profile");
  const child = spawn(browser, [
    "--headless",
    "--disable-gpu",
    "--no-first-run",
    "--disable-extensions",
    "--no-pdf-header-footer",
    `--user-data-dir=${profile}`,
    `--print-to-pdf=${pdfFile}`,
    `file:///${htmlFile.replace(/\\/g, "/")}`
  ], { stdio: "ignore", windowsHide: true });
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  try {
    await waitForExit(child);
    // The launcher can exit before the document is written; wait for the file.
    return await waitForPdf(pdfFile, deadline);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function renderHtmlToPdf(html) {
  const run = queue.then(() => renderOnce(html));
  queue = run.catch(() => {});
  return run;
}

// Renders and then locks the document: print-only permissions, document
// metadata, and an open password when one is configured.
async function renderProtectedPdf(html, metadata = {}) {
  const raw = await renderHtmlToPdf(html);
  return protectPdf(raw, {
    userPassword: process.env.OPTILENS_INVOICE_PDF_PASSWORD || "",
    author: "Classic Visions",
    creator: "OptiLens Local",
    producer: "OptiLens Local",
    ...metadata
  });
}

module.exports = { renderHtmlToPdf, renderProtectedPdf, findBrowser };
