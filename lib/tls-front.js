// Built-in HTTPS for sites with no reverse proxy (see docs/INSTALL_LICENSED_EDITION.md).
//
// When a certificate is configured the app also listens for HTTPS and hands every
// request to the same handler as the plain HTTP listener, which then only needs
// to answer on the loopback address. A second listener on the usual HTTP port
// sends browsers to HTTPS, except /cert, which stays on HTTP because a device
// that does not trust the certificate yet could not open an HTTPS page to read
// how to install it.
//
//   OPTILENS_TLS_PFX, OPTILENS_TLS_PFX_PASSPHRASE   a PKCS#12 bundle, or
//   OPTILENS_TLS_CERT, OPTILENS_TLS_KEY             PEM files (OPTILENS_TLS_KEY_PASSPHRASE if encrypted)
//   OPTILENS_HTTPS_PORT          default 443
//   OPTILENS_HTTP_REDIRECT_PORT  default 80, 0 turns the redirect listener off
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");

const HOST_HEADER = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

function readTlsOptions(env = process.env, readFile = fs.readFileSync) {
  if (env.OPTILENS_TLS_PFX) {
    return { pfx: readFile(env.OPTILENS_TLS_PFX), passphrase: env.OPTILENS_TLS_PFX_PASSPHRASE || undefined };
  }
  if (env.OPTILENS_TLS_CERT || env.OPTILENS_TLS_KEY) {
    if (!env.OPTILENS_TLS_CERT || !env.OPTILENS_TLS_KEY) throw new Error("Set both OPTILENS_TLS_CERT and OPTILENS_TLS_KEY.");
    return { cert: readFile(env.OPTILENS_TLS_CERT), key: readFile(env.OPTILENS_TLS_KEY), passphrase: env.OPTILENS_TLS_KEY_PASSPHRASE || undefined };
  }
  return null;
}

function portFrom(value, fallback) {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${value} is not a valid port.`);
  return port;
}

// The Location for a plain-HTTP request, or null when the Host header is not a
// plain host name or address (so it is never echoed into a redirect).
function httpsLocation({ hostHeader, url, httpsPort, fallbackHost }) {
  let host = hostHeader && HOST_HEADER.test(hostHeader) ? hostHeader : fallbackHost;
  if (!host) return null;
  host = host.replace(/:\d+$/, "");
  const target = String(url || "/").startsWith("/") ? String(url || "/") : `/${url}`;
  if (/[\r\n]/.test(target)) return null;
  return `https://${host}${httpsPort === 443 ? "" : `:${httpsPort}`}${target}`;
}

function createRedirectHandler({ httpsPort, fallbackHost, handleCertificateRoute }) {
  return async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (handleCertificateRoute && await handleCertificateRoute({ req, res, url })) return;
      const location = httpsLocation({ hostHeader: req.headers.host, url: req.url, httpsPort, fallbackHost });
      if (!location) {
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Bad request");
        return;
      }
      const safe = req.method === "GET" || req.method === "HEAD";
      res.writeHead(safe ? 301 : 308, { Location: location, "Content-Type": "text/plain; charset=utf-8" });
      res.end(req.method === "HEAD" ? undefined : `Moved to ${location}`);
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  };
}

function listen(server, port, label, log) {
  return new Promise((resolve) => {
    server.once("error", (error) => {
      log(`${label} could not listen on port ${port}: ${error.code || error.message}. ${error.code === "EADDRINUSE" ? "Another program (often IIS) is using it." : error.code === "EACCES" ? "The port is reserved or needs more rights." : ""}`.trim());
      resolve(false);
    });
    server.listen(port, "0.0.0.0", () => {
      log(`${label} listening on port ${port}`);
      resolve(true);
    });
  });
}

// Starts the HTTPS and redirect listeners. `appServer` is the existing HTTP
// server: its 'request' listener is reused, so there is one set of routes.
async function startTlsFront({ appServer, env = process.env, handleCertificateRoute, log = console.log, readFile = fs.readFileSync }) {
  let options;
  try { options = readTlsOptions(env, readFile); } catch (error) {
    log(`HTTPS is configured but its certificate could not be read: ${error.message}`);
    return { https: null, redirect: null, error: error.message };
  }
  if (!options) return { https: null, redirect: null };

  const httpsPort = portFrom(env.OPTILENS_HTTPS_PORT, 443);
  const redirectPort = portFrom(env.OPTILENS_HTTP_REDIRECT_PORT, 80);
  const result = { https: null, redirect: null, httpsPort, redirectPort };
  let secure;
  try { secure = https.createServer({ ...options, minVersion: "TLSv1.2" }); } catch (error) {
    log(`HTTPS is configured but the certificate was not accepted: ${error.message}`);
    return { ...result, error: error.message };
  }
  secure.on("request", (req, res) => appServer.emit("request", req, res));
  if (await listen(secure, httpsPort, "HTTPS", log)) result.https = secure;

  if (redirectPort > 0) {
    const redirect = http.createServer(createRedirectHandler({ httpsPort, fallbackHost: env.OPTILENS_PUBLIC_HOST || "", handleCertificateRoute }));
    if (await listen(redirect, redirectPort, "HTTP redirect", log)) result.redirect = redirect;
  }
  return result;
}

module.exports = { createRedirectHandler, httpsLocation, readTlsOptions, startTlsFront };
