// Plugin checker for the BeSwift CO (Beta) browser extension.
//
// The Delivery & Export workflow can only auto-fill certificates if this
// extension is installed and current, but a page has no way to enumerate
// extensions. The extension therefore ships a site bridge (site-bridge.js)
// that answers a ping on the OptiLens origins; this script pings it, compares
// the reported version against the release the server currently advertises,
// and shows the result on the tab row.
//
// Installation is by Edge machine policy (ExtensionInstallForcelist), so the
// "missing" case is a configuration problem on that workstation, not something
// the user can fix by clicking a link - the panel therefore tells them exactly
// what to run rather than pretending a web page can install it.
(() => {
  "use strict";

  const PING_TIMEOUT_MS = 1200;
  const button = document.getElementById("beswiftExtBtn");
  if (!button) return;

  const STATES = {
    checking: { icon: "extension", title: "Checking BeSwift extension..." },
    ok:       { icon: "extension", title: "BeSwift extension installed and up to date" },
    outdated: { icon: "sync_problem", title: "BeSwift extension needs an update" },
    missing:  { icon: "extension_off", title: "BeSwift extension not installed" },
    unknown:  { icon: "help", title: "BeSwift extension status unavailable" }
  };

  let release = null;
  let detected = null;

  function setState(state) {
    const meta = STATES[state] || STATES.unknown;
    button.dataset.extState = state;
    button.textContent = meta.icon;
    button.title = meta.title;
    button.setAttribute("aria-label", meta.title);
  }

  // Ask the extension to identify itself. Resolves null when nothing answers,
  // which is the "not installed" signal.
  function pingExtension() {
    return new Promise((resolve) => {
      // document_start marker - present even if the message round trip is slow.
      const marked = document.documentElement.dataset.optilensBeswiftExt;
      if (marked) {
        resolve({ version: marked, id: document.documentElement.dataset.optilensBeswiftExtId || null });
        return;
      }
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        resolve(value);
      };
      const onMessage = (event) => {
        if (event.source !== window) return;
        if (event.data?.type !== "optilens-beswift-ext-pong") return;
        done(event.data.info || null);
      };
      window.addEventListener("message", onMessage);
      window.postMessage({ type: "optilens-beswift-ext-ping" }, window.location.origin);
      setTimeout(() => done(null), PING_TIMEOUT_MS);
    });
  }

  // Numeric-segment compare so "0.10.0" sorts above "0.9.0".
  function compareVersions(a, b) {
    const pa = String(a || "0").split(".").map(Number);
    const pb = String(b || "0").split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d < 0 ? -1 : 1;
    }
    return 0;
  }

  async function check() {
    setState("checking");
    try {
      const response = await fetch("/api/beswift-extension/release", { cache: "no-store" });
      release = response.ok ? await response.json() : null;
    } catch {
      release = null;
    }
    detected = await pingExtension();

    if (!detected) return setState("missing");
    if (!release?.version) return setState("unknown");
    setState(compareVersions(detected.version, release.version) < 0 ? "outdated" : "ok");
  }

  function panelMarkup() {
    const shipped = release?.version || "unknown";
    const policy = release?.policyValue || "";
    if (!detected) {
      // The command runs from the GitHub share rather than a repo path: a
      // workstation that needs the extension will not have a checkout, but it
      // can reach the share. (The CRX itself still comes over HTTP - Windows
      // Edge refuses external installs from file:// or UNC update URLs.)
      const cmd = release?.installCommand || "";
      return `
        <p><strong>Not installed on this browser.</strong></p>
        <p>The extension is deployed by Edge policy, so a web page cannot install
           it. On this workstation, open an <strong>Administrator</strong> command
           prompt and run:</p>
        <pre class="ext-cmd">${cmd}</pre>
        <button type="button" class="beswift-ext-copy">Copy command</button>
        <p>Then restart Edge. It installs automatically and stays updated.</p>
        <p class="ext-muted">Policy value: <code>${policy}</code></p>
        <p class="ext-muted">Dev machine with no policy yet? <a href="${release?.crxUrl || "#"}" class="beswift-ext-download">Download the .crx</a> and drag it onto <code>edge://extensions</code> with Developer mode on.</p>`;
    }
    if (compareVersions(detected.version, shipped) < 0) {
      return `
        <p><strong>Update pending.</strong> Installed ${detected.version}, available ${shipped}.</p>
        <p>Edge applies this automatically - it was asked to check when this page
           loaded. If it hasn't applied within a few minutes, restart Edge, or
           force it from <code>edge://extensions</code> with Developer mode on and
           "Update".</p>`;
    }
    return `
      <p><strong>Installed and up to date.</strong> Version ${detected.version}.</p>
      <p class="ext-muted">Extension ID <code>${detected.id || release?.extensionId || ""}</code>.
         Updates are delivered automatically by Edge policy and re-checked each
         time this page loads.</p>`;
  }

  function showPanel() {
    document.getElementById("beswiftExtPanel")?.remove();
    const panel = document.createElement("div");
    panel.id = "beswiftExtPanel";
    panel.className = "beswift-ext-panel";
    panel.innerHTML = `
      <div class="beswift-ext-panel-head">
        <strong>BeSwift extension</strong>
        <button type="button" class="beswift-ext-close" aria-label="Close">&times;</button>
      </div>
      <div class="beswift-ext-panel-body">${panelMarkup()}</div>
      <div class="beswift-ext-panel-foot">
        <button type="button" class="beswift-ext-recheck">Re-check</button>
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector(".beswift-ext-close").addEventListener("click", () => panel.remove());
    panel.querySelector(".beswift-ext-recheck").addEventListener("click", async () => {
      await check();
      panel.querySelector(".beswift-ext-panel-body").innerHTML = panelMarkup();
      wireCopy(panel);
    });
    wireCopy(panel);
  }

  // Clipboard write can reject on an insecure origin; fall back to selecting
  // the text so the command is still easy to copy by hand.
  function wireCopy(panel) {
    const copyBtn = panel.querySelector(".beswift-ext-copy");
    if (!copyBtn) return;
    copyBtn.addEventListener("click", async () => {
      const cmd = release?.installCommand || "";
      try {
        await navigator.clipboard.writeText(cmd);
        copyBtn.textContent = "Copied";
      } catch {
        const pre = panel.querySelector(".ext-cmd");
        if (pre) {
          const range = document.createRange();
          range.selectNodeContents(pre);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        copyBtn.textContent = "Selected - press Ctrl+C";
      }
      setTimeout(() => { copyBtn.textContent = "Copy command"; }, 2500);
    });
  }

  button.addEventListener("click", showPanel);
  check();
})();
