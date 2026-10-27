const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createRedirectHandler, httpsLocation, readTlsOptions, startTlsFront } = require("../lib/tls-front");

function request(options, mod = http) {
  return new Promise((resolve, reject) => {
    const req = mod.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

function listening(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("no certificate configured means no HTTPS", () => {
  assert.equal(readTlsOptions({}), null);
});

test("a PFX or a PEM pair is read, and half a pair is refused", () => {
  const reads = [];
  const readFile = (file) => { reads.push(file); return Buffer.from(file); };
  assert.deepEqual(readTlsOptions({ OPTILENS_TLS_PFX: "a.pfx", OPTILENS_TLS_PFX_PASSPHRASE: "pw" }, readFile), { pfx: Buffer.from("a.pfx"), passphrase: "pw" });
  const pem = readTlsOptions({ OPTILENS_TLS_CERT: "c.pem", OPTILENS_TLS_KEY: "k.pem" }, readFile);
  assert.deepEqual(Object.keys(pem).sort(), ["cert", "key", "passphrase"]);
  assert.throws(() => readTlsOptions({ OPTILENS_TLS_CERT: "c.pem" }, readFile), /both OPTILENS_TLS_CERT and OPTILENS_TLS_KEY/);
});

test("the redirect keeps the host and path, moves to the HTTPS port, and never echoes a bad Host", () => {
  assert.equal(httpsLocation({ hostHeader: "lab-srv", url: "/a?b=1", httpsPort: 443, fallbackHost: "x" }), "https://lab-srv/a?b=1");
  assert.equal(httpsLocation({ hostHeader: "192.168.1.5:80", url: "/", httpsPort: 8443, fallbackHost: "x" }), "https://192.168.1.5:8443/");
  assert.equal(httpsLocation({ hostHeader: "[fe80::1]:80", url: "/", httpsPort: 443, fallbackHost: "x" }), "https://[fe80::1]/");
  assert.equal(httpsLocation({ hostHeader: "evil.com/path", url: "/", httpsPort: 443, fallbackHost: "lab-srv" }), "https://lab-srv/");
  assert.equal(httpsLocation({ hostHeader: "a b", url: "/", httpsPort: 443, fallbackHost: "" }), null);
  assert.equal(httpsLocation({ hostHeader: "lab-srv", url: "/x\r\nSet-Cookie: a=b", httpsPort: 443, fallbackHost: "" }), null);
});

test("port 80 redirects to HTTPS but leaves /cert on HTTP", async () => {
  const handled = [];
  const server = http.createServer(createRedirectHandler({
    httpsPort: 443,
    fallbackHost: "lab-srv",
    handleCertificateRoute: async ({ res, url }) => {
      if (!url.pathname.startsWith("/cert")) return false;
      handled.push(url.pathname);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("certificate page");
      return true;
    }
  }));
  const port = await listening(server);
  try {
    const get = await request({ host: "127.0.0.1", port, path: "/rx?id=7", headers: { Host: "lab-srv" } });
    assert.equal(get.status, 301);
    assert.equal(get.headers.location, "https://lab-srv/rx?id=7");

    const post = await request({ host: "127.0.0.1", port, path: "/api/orders", method: "POST", headers: { Host: "lab-srv" } });
    assert.equal(post.status, 308);

    const cert = await request({ host: "127.0.0.1", port, path: "/cert/optilens-root-ca.crt" });
    assert.equal(cert.status, 200);
    assert.equal(cert.body, "certificate page");
    assert.deepEqual(handled, ["/cert/optilens-root-ca.crt"]);
  } finally { server.close(); }
});

// Needs openssl to make a throwaway certificate; skipped where it is not installed.
function makeCertificate(dir) {
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const run = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { encoding: "utf8" });
  return run.status === 0 ? { key, cert } : null;
}

test("HTTPS answers with the app's own request handler and port 80 redirects to it", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-tls-"));
  const material = makeCertificate(dir);
  if (!material) return t.skip("openssl is not available");

  const app = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ secure: Boolean(req.socket.encrypted), url: req.url }));
  });
  // Free ports for the two listeners.
  const probe = http.createServer();
  const httpsPort = await listening(probe);
  probe.close();
  const probe2 = http.createServer();
  const redirectPort = await listening(probe2);
  probe2.close();

  const messages = [];
  const front = await startTlsFront({
    appServer: app,
    env: { OPTILENS_TLS_CERT: material.cert, OPTILENS_TLS_KEY: material.key, OPTILENS_HTTPS_PORT: String(httpsPort), OPTILENS_HTTP_REDIRECT_PORT: String(redirectPort), OPTILENS_PUBLIC_HOST: "localhost" },
    log: (message) => messages.push(message)
  });
  try {
    assert.ok(front.https && front.redirect, messages.join("\n"));
    const secure = await request({ host: "127.0.0.1", port: httpsPort, path: "/api/ping", ca: fs.readFileSync(material.cert), servername: "localhost" }, https);
    assert.equal(secure.status, 200);
    assert.deepEqual(JSON.parse(secure.body), { secure: true, url: "/api/ping" });

    const moved = await request({ host: "127.0.0.1", port: redirectPort, path: "/start", headers: { Host: "localhost" } });
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.location, `https://localhost:${httpsPort}/start`);

    const old = await request({ host: "127.0.0.1", port: httpsPort, path: "/", ca: fs.readFileSync(material.cert), servername: "localhost", maxVersion: "TLSv1.1", minVersion: "TLSv1" }, https).catch((error) => error);
    assert.ok(old instanceof Error, "TLS 1.1 is refused");
  } finally {
    if (front.https) front.https.close();
    if (front.redirect) front.redirect.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an unreadable certificate is reported and the app keeps running without HTTPS", async () => {
  const messages = [];
  const front = await startTlsFront({
    appServer: http.createServer(),
    env: { OPTILENS_TLS_PFX: path.join(os.tmpdir(), "missing-optilens.pfx") },
    log: (message) => messages.push(message)
  });
  assert.equal(front.https, null);
  assert.ok(front.error);
  assert.match(messages.join("\n"), /certificate could not be read/);
});
