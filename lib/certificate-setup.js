// Certificate setup for LAN devices: /cert explains how to trust the OptiLens
// Local root CA on phones and PCs and serves its public certificate. IIS lets
// /cert through over plain HTTP (templates/iis-optilens-web.config) because a
// device that does not trust the CA cannot open the HTTPS site to read this.
// Only the public root certificate is ever served; its private key stays in
// the host's certificate store.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT_CA_PATH = path.join(__dirname, "..", "data", "certificates", "OptiLens-Local-Root-CA.cer");
const SECURE_HOST = process.env.OPTILENS_PUBLIC_HOST || "optilens.cv.net";
const PROFILE_ID = "net.cv.optilens.root-ca";

async function handleCertificateSetupRoute({ req, res, url, rootCaPath = ROOT_CA_PATH }) {
  const route = url.pathname.replace(/\/+$/, "") || "/";
  if (!route.startsWith("/cert")) return false;
  if (!["/cert", "/cert/ping", "/cert/optilens-root-ca.crt", "/cert/optilens-root-ca.mobileconfig"].includes(route)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "text/plain; charset=utf-8", "Method not allowed");
    return true;
  }
  // Answered over HTTPS only once the device trusts the CA; the page probes it.
  if (route === "/cert/ping") {
    send(res, 204, "text/plain; charset=utf-8", "", { "Access-Control-Allow-Origin": "*" });
    return true;
  }

  let der;
  try {
    der = await fs.promises.readFile(rootCaPath);
  } catch {
    send(res, 503, "text/plain; charset=utf-8", "The OptiLens root certificate is not available on this server yet.");
    return true;
  }

  if (route === "/cert/optilens-root-ca.crt") {
    send(res, 200, "application/x-x509-ca-cert", req.method === "HEAD" ? "" : der, {
      "Content-Disposition": 'attachment; filename="OptiLens-Local-Root-CA.crt"'
    });
  } else if (route === "/cert/optilens-root-ca.mobileconfig") {
    send(res, 200, "application/x-apple-aspen-config", req.method === "HEAD" ? "" : appleProfile(der), {
      "Content-Disposition": 'attachment; filename="OptiLens-Local.mobileconfig"'
    });
  } else {
    send(res, 200, "text/html; charset=utf-8", req.method === "HEAD" ? "" : setupPage(certificateSummary(der)), {
      "Content-Security-Policy": `default-src 'self'; connect-src 'self' https://${SECURE_HOST}; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
    });
  }
  return true;
}

function certificateSummary(der) {
  try {
    const certificate = new crypto.X509Certificate(der);
    return {
      subject: (/CN=([^\n,]+)/.exec(certificate.subject) || [])[1] || certificate.subject,
      fingerprint: certificate.fingerprint256,
      validTo: new Date(certificate.validTo)
    };
  } catch {
    return { subject: "OptiLens Local Root CA", fingerprint: crypto.createHash("sha256").update(der).digest("hex").toUpperCase().match(/../g).join(":"), validTo: null };
  }
}

// An unsigned configuration profile holding only the root certificate. iOS
// shows it as "Unverified" (true of any self-issued profile); the fingerprint
// on the setup page is how an employee confirms it is ours.
function appleProfile(der) {
  const uuid = (label) => {
    const hex = crypto.createHash("sha256").update(`${label}:`).update(der).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`.toUpperCase();
  };
  const base64 = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadCertificateFileName</key>
      <string>OptiLens-Local-Root-CA.cer</string>
      <key>PayloadContent</key>
      <data>
${base64}
      </data>
      <key>PayloadDescription</key>
      <string>Trusts the OptiLens Local certificate authority for https://${SECURE_HOST}.</string>
      <key>PayloadDisplayName</key>
      <string>OptiLens Local Root CA</string>
      <key>PayloadIdentifier</key>
      <string>${PROFILE_ID}.certificate</string>
      <key>PayloadType</key>
      <string>com.apple.security.root</string>
      <key>PayloadUUID</key>
      <string>${uuid("certificate")}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Lets this device open OptiLens Local (https://${SECURE_HOST}) on the Classic Visions network without a security warning.</string>
  <key>PayloadDisplayName</key>
  <string>OptiLens Local</string>
  <key>PayloadIdentifier</key>
  <string>${PROFILE_ID}</string>
  <key>PayloadOrganization</key>
  <string>Classic Visions</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${uuid("profile")}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}

function setupPage({ subject, fingerprint, validTo }) {
  const expires = validTo && !Number.isNaN(validTo.getTime()) ? validTo.toISOString().slice(0, 10) : "unknown";
  const secureUrl = `https://${SECURE_HOST}/`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0b1e35">
<title>OptiLens certificate setup</title>
<style>
  :root { color-scheme: light; --navy: #0b1e35; --teal: #0f7c86; --teal-dark: #075c64; --ink: #152536; --muted: #5b6b7d; --line: #d9e1e8; --paper: #f5f7fa; --ok: #17643a; --bad: #a83b35; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; background: var(--paper); color: var(--ink); line-height: 1.5; }
  header { background: var(--navy); color: white; padding: 14px 16px; font-weight: 800; }
  main { width: min(100%, 720px); margin: 0 auto; padding: 18px 16px 40px; }
  h1 { font-size: 1.6rem; line-height: 1.15; margin: 6px 0 8px; letter-spacing: -.02em; }
  h2 { font-size: 1rem; margin: 0; }
  p { margin: 8px 0; }
  .lead { color: var(--muted); }
  .card { background: white; border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; margin: 12px 0; }
  details.card > summary { cursor: pointer; font-weight: 800; list-style: none; display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  details.card > summary::after { content: "+"; color: var(--teal); font-size: 1.3rem; }
  details.card[open] > summary::after { content: "–"; }
  details.card[open] > summary { margin-bottom: 8px; }
  .yours { font-size: .7rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; background: #e4f7f7; color: var(--teal-dark); border-radius: 999px; padding: 3px 8px; margin-left: auto; }
  ol { margin: 8px 0; padding-left: 22px; }
  li { margin: 6px 0; }
  .button { display: inline-flex; align-items: center; justify-content: center; min-height: 46px; padding: 10px 18px; border-radius: 10px; border: 0; background: var(--teal); color: white; font: inherit; font-weight: 800; text-decoration: none; cursor: pointer; }
  .button.secondary { background: white; color: var(--navy); border: 1px solid var(--line); }
  .note { font-size: .88rem; color: var(--muted); }
  .warn { border-left: 4px solid #d68a25; background: #fff9ee; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .82rem; overflow-wrap: anywhere; }
  #status { font-weight: 800; }
  #status.ok { color: var(--ok); }
  #status.bad { color: var(--bad); }
  .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 10px; }
</style>
</head>
<body>
<header>OptiLens Local</header>
<main>
  <h1>Set up this device for OptiLens</h1>
  <p class="lead">OptiLens uses Classic Visions' own security certificate on the office network. Install it once on each phone, tablet or PC and the "not secure" warning goes away. This also lets RX Capture be installed as an app.</p>

  <section class="card" aria-labelledby="checkTitle">
    <h2 id="checkTitle">Is this device already set up?</h2>
    <p id="status" role="status" aria-live="polite">Checking…</p>
    <div class="row">
      <button id="checkButton" class="button secondary" type="button">Check again</button>
      <a id="openLink" class="button" href="${secureUrl}" hidden>Open OptiLens</a>
    </div>
  </section>

  <details class="card" data-platform="ios">
    <summary>iPhone or iPad</summary>
    <ol>
      <li>Open this page in <strong>Safari</strong>. Chrome and other browsers on iPhone cannot install certificates.</li>
      <li><a class="button" href="/cert/optilens-root-ca.mobileconfig">Download the iPhone profile</a><br><span class="note">Tap <strong>Allow</strong>, then <strong>Close</strong>.</span></li>
      <li>Open <strong>Settings</strong>. Tap <strong>Profile Downloaded</strong> near the top (or General → VPN &amp; Device Management → OptiLens Local).</li>
      <li>Tap <strong>Install</strong>, enter the passcode, then tap <strong>Install</strong> again. It says "Unverified"; that is expected for our own certificate.</li>
      <li><strong>Don't skip this step:</strong> go to Settings → General → About → <strong>Certificate Trust Settings</strong> and turn on <strong>${escapeHtml(subject)}</strong>.</li>
      <li>Come back here and tap <strong>Check again</strong>.</li>
    </ol>
  </details>

  <details class="card" data-platform="android">
    <summary>Android phone or tablet</summary>
    <ol>
      <li><a class="button" href="/cert/optilens-root-ca.crt">Download the certificate</a><br><span class="note">If Chrome says certificates must be installed from Settings, that's expected. The file is saved in Downloads.</span></li>
      <li>Open <strong>Settings</strong> and search for <strong>CA certificate</strong>. Usually it is under Security &amp; privacy → More security settings → Encryption &amp; credentials → Install a certificate → <strong>CA certificate</strong>.</li>
      <li>Tap <strong>Install anyway</strong>, confirm with your screen lock, and choose <strong>OptiLens-Local-Root-CA.crt</strong> from Downloads.</li>
      <li>Come back here and tap <strong>Check again</strong>.</li>
    </ol>
    <p class="note">Samsung: Settings → Security and privacy → More security settings → Install from device storage → CA certificate.</p>
  </details>

  <details class="card" data-platform="windows">
    <summary>Windows PC</summary>
    <ol>
      <li><a class="button" href="/cert/optilens-root-ca.crt">Download the certificate</a></li>
      <li>Open the downloaded file and click <strong>Install Certificate…</strong></li>
      <li>Choose <strong>Local Machine</strong> (needs an administrator), then <strong>Place all certificates in the following store</strong> → Browse → <strong>Trusted Root Certification Authorities</strong> → Finish.</li>
      <li>Restart the browser and tap <strong>Check again</strong>.</li>
    </ol>
  </details>

  <details class="card" data-platform="mac">
    <summary>Mac</summary>
    <ol>
      <li><a class="button" href="/cert/optilens-root-ca.crt">Download the certificate</a></li>
      <li>Open it. Keychain Access adds it to the <strong>System</strong> keychain.</li>
      <li>Double-click <strong>${escapeHtml(subject)}</strong>, expand <strong>Trust</strong>, and set <strong>When using this certificate</strong> to <strong>Always Trust</strong>.</li>
      <li>Restart the browser and tap <strong>Check again</strong>.</li>
    </ol>
  </details>

  <section class="card warn">
    <h2>Still not working after installing?</h2>
    <p>The device must be on the Classic Visions Wi-Fi or network. If <code>${escapeHtml(SECURE_HOST)}</code> doesn't open at all, the device isn't using the office DNS server (192.168.254.7). Ask the administrator.</p>
  </section>

  <section class="card">
    <h2>Check it's the real certificate</h2>
    <p class="note">This page is plain HTTP so that devices without the certificate can open it. Before trusting a certificate, compare its SHA-256 fingerprint with the one the administrator has on file.</p>
    <p class="mono">${escapeHtml(subject)}<br>SHA-256 ${escapeHtml(fingerprint)}<br>Expires ${escapeHtml(expires)}</p>
  </section>
</main>
<script>
(() => {
  const ua = navigator.userAgent;
  const platform = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "ios"
    : /Android/.test(ua) ? "android" : /Windows/.test(ua) ? "windows" : /Macintosh/.test(ua) ? "mac" : "";
  const mine = document.querySelector('[data-platform="' + platform + '"]');
  if (mine) {
    mine.open = true;
    mine.querySelector("summary").insertAdjacentHTML("beforeend", '<span class="yours">This device</span>');
    mine.parentNode.insertBefore(mine, document.querySelector("details.card"));
  }
  const status = document.querySelector("#status");
  const open = document.querySelector("#openLink");
  // The secure address only answers once this device trusts the certificate.
  async function check() {
    status.className = "";
    status.textContent = "Checking…";
    try {
      await fetch(${JSON.stringify(`${secureUrl}cert/ping`)} + "?t=" + Date.now(), { mode: "no-cors", cache: "no-store" });
      status.className = "ok";
      status.textContent = "✓ This device trusts OptiLens. You're all set.";
      open.hidden = false;
    } catch {
      status.className = "bad";
      status.textContent = "Not set up yet. Follow the steps for your device below.";
      open.hidden = true;
    }
  }
  document.querySelector("#checkButton").addEventListener("click", check);
  check();
})();
</script>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function send(res, status, contentType, body, headers = {}) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers
  });
  res.end(body);
}

module.exports = { handleCertificateSetupRoute, appleProfile, certificateSummary };
