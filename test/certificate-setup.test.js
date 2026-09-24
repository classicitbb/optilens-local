const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { handleCertificateSetupRoute, appleProfile } = require("../lib/certificate-setup");

function response() {
  return {
    status: null, headers: {}, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
}

async function request(pathname, rootCaPath, method = "GET") {
  const res = response();
  const handled = await handleCertificateSetupRoute({ req: { method }, res, url: new URL(`http://192.168.254.7${pathname}`), rootCaPath });
  return { handled, res };
}

const der = Buffer.from("3082010a0282010100c0ffee", "hex");
const certPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cert-setup-")), "root.cer");
fs.writeFileSync(certPath, der);

test("certificate setup serves the page and the public root certificate only", async () => {
  const page = await request("/cert/", certPath);
  assert.equal(page.handled, true);
  assert.equal(page.res.status, 200);
  assert.match(page.res.headers["Content-Type"], /text\/html/);
  assert.match(page.res.body, /Certificate Trust Settings/);
  assert.match(page.res.body, /SHA-256 [0-9A-F:]{95}/);
  assert.match(page.res.headers["Content-Security-Policy"], /connect-src 'self' https:\/\/optilens\.cv\.net/);

  const crt = await request("/cert/optilens-root-ca.crt", certPath);
  assert.equal(crt.res.headers["Content-Type"], "application/x-x509-ca-cert");
  assert.deepEqual(crt.res.body, der);

  const profile = await request("/cert/optilens-root-ca.mobileconfig", certPath);
  assert.equal(profile.res.headers["Content-Type"], "application/x-apple-aspen-config");
  assert.match(profile.res.body, /<string>com\.apple\.security\.root<\/string>/);
  assert.ok(profile.res.body.includes(der.toString("base64")));

  assert.equal((await request("/cert/ping", certPath)).res.status, 204);
  assert.equal((await request("/cert/other", certPath)).handled, false);
  assert.equal((await request("/certificates", certPath)).handled, false);
  assert.equal((await request("/rx-capture", certPath)).handled, false);
  assert.equal((await request("/cert", certPath, "POST")).res.status, 405);
  assert.equal((await request("/cert", path.join(os.tmpdir(), "missing-root.cer"))).res.status, 503);
});

test("the iPhone profile has stable identifiers for the same certificate", () => {
  const uuids = (text) => text.match(/[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-8[0-9A-F]{3}-[0-9A-F]{12}/g);
  assert.deepEqual(uuids(appleProfile(der)), uuids(appleProfile(der)));
  assert.equal(new Set(uuids(appleProfile(der))).size, 2);
  assert.notDeepEqual(uuids(appleProfile(der)), uuids(appleProfile(crypto.randomBytes(40))));
});

test("IIS keeps /cert on HTTP ahead of the HTTPS redirect", () => {
  const config = fs.readFileSync(path.join(__dirname, "..", "templates", "iis-optilens-web.config"), "utf8");
  assert.ok(config.indexOf('match url="^cert(?:/.*)?$"') > -1);
  assert.ok(config.indexOf("certificate setup over HTTP") < config.indexOf("Redirect OptiLens HTTP to HTTPS"));
});
