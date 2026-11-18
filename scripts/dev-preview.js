#!/usr/bin/env node
"use strict";

// npm run dev:preview
//
// Runs OptiLens Local as a safe dev preview: its own port, hot reload for pages and styles,
// automatic restart on server/library edits, automatic UI rebuild, and every background
// worker, write-back path and self-update switched off (see lib/dev-preview.js).
//
// Usage: node scripts/dev-preview.js [--port 8090] [--here]
//   --here   allow running inside the production checkout (edits there are live; not advised)

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { DEFAULT_DEV_PORT, looksLikeLiveHost } = require("../lib/dev-preview");

const root = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const allowHere = argv.includes("--here");
const portFlag = argv.indexOf("--port");
const preferredPort = portFlag >= 0 ? Number(argv[portFlag + 1]) : Number(process.env.OPTILENS_DEV_PORT || DEFAULT_DEV_PORT);

function say(message) {
  console.log(`[dev-preview] ${message}`);
}

function fail(message) {
  console.error(`[dev-preview] ${message}`);
  process.exit(1);
}

// Windows keeps the service settings in the user/machine environment (see .claude/launch.json),
// not in the current shell. Bring the OPTILENS_* ones across so the preview sees the same data.
function importWindowsEnvironment() {
  if (process.platform !== "win32") return;
  const script = "$r=@{}; foreach($s in 'Machine','User'){ $v=[Environment]::GetEnvironmentVariables($s); foreach($k in $v.Keys){ if($k -like 'OPTILENS_*'){ $r[$k]=[string]$v[$k] } } }; $r | ConvertTo-Json -Compress";
  const result = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0 || !result.stdout.trim()) return;
  try {
    for (const [key, value] of Object.entries(JSON.parse(result.stdout))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // The .env file still applies; nothing to import.
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

async function pickPort(start) {
  for (let port = start; port < start + 20; port++) {
    if (await portIsFree(port)) return port;
  }
  fail(`No free port between ${start} and ${start + 19}.`);
}

function runUiBuild() {
  const started = Date.now();
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "build-ui.mjs")], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status === 0) say(`UI rebuilt in ${Date.now() - started} ms.`);
  else console.error(`[dev-preview] UI build failed:\n${String(result.stderr || result.stdout).trim().slice(0, 1200)}`);
  return result.status === 0;
}

// scripts/ui holds the React/Tailwind sources that compile into public/assets/ui.
function watchUiSources() {
  const sourceDir = path.join(root, "scripts", "ui");
  if (!fs.existsSync(sourceDir)) return;
  let timer = null;
  let building = false;
  let queued = false;
  const rebuild = () => {
    if (building) { queued = true; return; }
    building = true;
    runUiBuild();
    building = false;
    if (queued) { queued = false; rebuild(); }
  };
  try {
    fs.watch(sourceDir, { recursive: true }, (_event, name) => {
      if (!name || /(~|\.tmp|\.swp)$/.test(String(name))) return;
      clearTimeout(timer);
      timer = setTimeout(rebuild, 250);
    });
    say("Watching scripts/ui; UI sources rebuild on save.");
  } catch (error) {
    say(`Could not watch scripts/ui (${error.message}); run npm run build:ui after UI edits.`);
  }
}

async function main() {
  if (looksLikeLiveHost(root) && !allowHere) {
    fail([
      "This checkout is the production service checkout (its watchdog is writing data/watchdog.log).",
      "Edits here are served to staff immediately and block the guarded updater.",
      "Create the isolated dev checkout once with:  npm run dev:setup",
      "then run the preview from there. To run here anyway, pass --here."
    ].join("\n[dev-preview] "));
  }
  if (!fs.existsSync(path.join(root, "node_modules"))) fail("node_modules is missing. Run npm ci (or npm run dev:setup) first.");

  importWindowsEnvironment();
  if (!fs.existsSync(path.join(root, "public", "assets", "ui"))) runUiBuild();

  const port = await pickPort(preferredPort);
  const env = { ...process.env, OPTILENS_DEV_PREVIEW: "1", OPTILENS_DEV_PORT: String(port) };
  delete env.OPTILENS_PORT;

  say(`Starting on http://127.0.0.1:${port}  (production is untouched: workers, write-back and self-update are off)`);
  if (env.OPTILENS_DEV_DB_NAME) say(`Using scratch app database ${env.OPTILENS_DEV_DB_NAME}.`);
  else say("App database is the real one; saved settings are real. Set OPTILENS_DEV_DB_NAME to use a scratch copy.");
  say("Edit public/*, styles or templates: the browser updates itself. Edit server.js or lib/*: the server restarts.");

  const child = spawn(
    process.execPath,
    ["--watch-path=server.js", "--watch-path=lib", "--watch-preserve-output", "server.js"],
    { cwd: root, env, stdio: "inherit", windowsHide: true }
  );
  watchUiSources();

  const stop = () => { child.kill(); setTimeout(() => process.exit(0), 300).unref(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((error) => fail(error.stack || error.message));
