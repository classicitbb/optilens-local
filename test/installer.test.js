const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "optilens-installer-"));
// loadEdition records the latest time it has seen; keep that out of the repo's data folder.
process.env.OPTILENS_EDITION_CLOCK_FILE = path.join(scratch, "clock.json");

const root = path.join(__dirname, "..");
const installDir = path.join(root, "scripts", "install");
const { checkLicence } = require("../scripts/install/first-run");
const { signPayload } = require("../lib/edition");

const keys = crypto.generateKeyPairSync("ed25519");
const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const publicPem = keys.publicKey.export({ type: "spki", format: "pem" });

function licence(overrides = {}, { sign = true } = {}) {
  const payload = {
    licensee: "Value Optical Ltd", edition: "value-optical", modules: ["rx-capture", "vault"],
    licenceId: "value-optical-abc123", issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(), ...overrides
  };
  const file = path.join(scratch, `licence-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify({ payload, signature: sign ? signPayload(payload, privatePem) : "AAAA" }));
  return file;
}

test("a valid licence is reported with what it grants", () => {
  const result = checkLicence(licence(), { publicKey: publicPem });
  assert.equal(result.ok, true);
  assert.equal(result.licensee, "Value Optical Ltd");
  assert.deepEqual(result.modules.sort(), ["rx-capture", "vault"]);
  assert.equal(result.trial, false);
  assert.ok(result.daysLeft >= 89);
});

test("licences that cannot be used are rejected with the reason", () => {
  assert.match(checkLicence(licence({ expiresAt: "2020-01-01T00:00:00.000Z" }), { publicKey: publicPem }).error, /expired/);
  assert.match(checkLicence(licence({}, { sign: false }), { publicKey: publicPem }).error, /signature/);
  assert.match(checkLicence(licence({ revoked: true }), { publicKey: publicPem }).error, /withdrawn/);
  assert.match(checkLicence(path.join(scratch, "missing.json"), { publicKey: publicPem }).error, /not found/);
  const junk = path.join(scratch, "junk.json");
  fs.writeFileSync(junk, "not json");
  assert.match(checkLicence(junk, { publicKey: publicPem }).error, /not valid JSON/);
  // A licence signed with another key does not verify against the vendor key.
  assert.match(checkLicence(licence()).error, /signature/);
});

test("a trial licence says so", () => {
  const result = checkLicence(licence({ trial: true, expiresAt: new Date(Date.now() + 5 * 86400000).toISOString() }), { publicKey: publicPem });
  assert.equal(result.trial, true);
  assert.ok(result.daysLeft <= 5);
});

test("first-run.js answers on stdout and never echoes the request", () => {
  const run = spawnSync(process.execPath, [path.join(installDir, "first-run.js")], { input: JSON.stringify({ action: "nonsense", admin: { password: "Secret-Value-123" } }), encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stdout + run.stderr, /Secret-Value-123/);
  assert.equal(JSON.parse(run.stdout).ok, false);
});

// ---- PowerShell: the pure helpers, in every PowerShell the installer supports.

function shells() {
  const found = [];
  for (const exe of ["pwsh", "powershell"]) {
    const probe = spawnSync(exe, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
    if (probe.status === 0) found.push(exe);
  }
  return found;
}

function runPs(exe, body) {
  const script = `$ErrorActionPreference='Stop'; Import-Module '${path.join(installDir, "OptiLens.Install.psm1")}' -Force\n${body}`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const run = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { encoding: "utf8" });
  assert.equal(run.status, 0, `${exe} failed: ${run.stderr || run.stdout}`);
  return JSON.parse(run.stdout.trim().split(/\r?\n/).pop());
}

const GOOD_ANSWERS = JSON.stringify({
  admin: { username: "lab.admin" },
  site: { labNum: "1177", custSeqNum: "2", remoteOperator: "1177-004" },
  folders: { incoming: "D:\\Innovations\\In", staging: "", archive: "\\\\srv\\share\\Archive" },
  port: 8080,
  sql: { mode: "auto" }
});

function answersWith(change) {
  const answers = JSON.parse(GOOD_ANSWERS);
  change(answers);
  return JSON.stringify(answers);
}

for (const exe of shells()) {
  test(`${exe}: both installer scripts parse`, () => {
    for (const file of ["Install-OptiLens.ps1", "OptiLens.Install.psm1"]) {
      const out = runPs(exe, `$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path.join(installDir, file)}',[ref]$null,[ref]$e); @{ errors = @($e | ForEach-Object { $_.Message }) } | ConvertTo-Json -Compress`);
      assert.deepEqual(out.errors, [], file);
    }
  });

  test(`${exe}: generated passwords are strong and safe in .env, sqlcmd and T-SQL`, () => {
    const out = runPs(exe, "@{ items = @(1..40 | ForEach-Object { New-StrongPassword }) } | ConvertTo-Json -Compress");
    assert.equal(new Set(out.items).size, 40);
    for (const pw of out.items) {
      assert.equal(pw.length, 24);
      assert.match(pw, /^[A-Za-z0-9_-]+$/);
      assert.match(pw, /[A-Z]/);
      assert.match(pw, /[a-z]/);
      assert.match(pw, /[0-9]/);
    }
  });

  test(`${exe}: .env text is merged without losing anything else`, () => {
    const out = runPs(exe, [
      "$text = \"# keep me`r`nOPTILENS_PORT=9000`r`nOTHER=1`r`n\"",
      "$v = [ordered]@{ OPTILENS_PORT = '8080'; OPTILENS_DB_USER = 'optilens_app' }",
      "$merged = Merge-EnvText -Text $text -Values $v",
      "@{ merged = $merged; port = (Get-EnvValue -Text $merged -Key 'OPTILENS_PORT'); missing = (Get-EnvValue -Text $merged -Key 'NOPE'); fromEmpty = (Merge-EnvText -Text '' -Values $v) } | ConvertTo-Json -Compress"
    ].join("\n"));
    assert.equal(out.merged, "# keep me\r\nOPTILENS_PORT=8080\r\nOTHER=1\r\nOPTILENS_DB_USER=optilens_app\r\n");
    assert.equal(out.port, "8080");
    assert.equal(out.missing, null);
    assert.equal(out.fromEmpty, "OPTILENS_PORT=8080\r\nOPTILENS_DB_USER=optilens_app\r\n");
  });

  test(`${exe}: answers are validated`, () => {
    const cases = {
      good: GOOD_ANSWERS,
      empty: "{}",
      builtIn: answersWith((a) => { a.admin.username = "optilens"; }),
      badLab: answersWith((a) => { a.site.labNum = "11 77"; }),
      relative: answersWith((a) => { a.folders.incoming = "relative\\In"; }),
      badPort: answersWith((a) => { a.port = 99999; }),
      existingNoName: answersWith((a) => { a.sql.mode = "existing"; })
    };
    const body = Object.entries(cases).map(([name, json]) => `$r['${name}'] = Test-InstallAnswers -Answers ('${Buffer.from(json).toString("base64")}' | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) } | ConvertFrom-Json)`).join("\n");
    const out = runPs(exe, `$r = @{}\n${body}\n$r | ConvertTo-Json -Compress -Depth 4`);
    assert.deepEqual(out.good, []);
    assert.equal(out.empty.length, 4);
    assert.match(out.builtIn.join(" "), /built-in/);
    assert.match(out.badLab.join(" "), /labNum/);
    assert.match(out.relative.join(" "), /full path/);
    assert.match(out.badPort.join(" "), /port/);
    assert.match(out.existingNoName.join(" "), /sql.instance/);
  });

  test(`${exe}: an existing SQL Server instance is judged on room and capacity`, () => {
    const out = runPs(exe, [
      "$base = @{ Running=$true; Connected=$true; IsSysadmin=$true; Edition='Express Edition (64-bit)'; MajorVersion=16; UserDataMB=500; UserDbCount=2; FreeMB=50000; HasOptilensDb=$false; LoginMode=2; StaticTcpPort=1433 }",
      "function Verdict($changes) { $f = $base.Clone(); foreach ($k in $changes.Keys) { $f[$k] = $changes[$k] }; Test-SqlCapacity -Facts ([PSCustomObject]$f) }",
      "@{",
      "  ok = (Verdict @{})",
      "  stopped = (Verdict @{ Running = $false; Connected = $false })",
      "  notAdmin = (Verdict @{ IsSysadmin = $false })",
      "  old = (Verdict @{ MajorVersion = 12 })",
      "  smallDisk = (Verdict @{ FreeMB = 2000 })",
      "  busy = (Verdict @{ UserDataMB = 9000 })",
      "  busyStandard = (Verdict @{ UserDataMB = 90000; Edition = 'Standard Edition (64-bit)' })",
      "  windowsOnly = (Verdict @{ LoginMode = 1; StaticTcpPort = $null })",
      "  existingDb = (Verdict @{ HasOptilensDb = $true })",
      "} | ConvertTo-Json -Compress -Depth 5"
    ].join("\n"));
    assert.equal(out.ok.Eligible, true);
    assert.deepEqual([].concat(out.ok.Warnings), []);
    assert.equal(out.stopped.Eligible, false);
    assert.match(out.notAdmin.Reasons.join(" "), /sysadmin/);
    assert.match(out.old.Reasons.join(" "), /older than 2016/);
    assert.match(out.smallDisk.Reasons.join(" "), /at least 5 GB/);
    assert.match(out.busy.Reasons.join(" "), /1.4 GB/);
    assert.equal(out.busyStandard.Eligible, true, "only Express has the shared-memory limit");
    assert.equal(out.windowsOnly.Eligible, true);
    assert.equal(out.windowsOnly.Warnings.length, 2, "both the sign-in mode and the fixed port need a restart");
    assert.match(out.existingDb.Warnings.join(" "), /optilens_local already exists/);
  });

  test(`${exe}: the installer reaches first-run.js and reads its reply`, () => {
    const missing = path.join(scratch, "no-such-licence.json").replace(/'/g, "''");
    const out = runPs(exe, `Invoke-FirstRun -Root '${root}' -Request @{ action = 'licence'; file = '${missing}' } | ConvertTo-Json -Compress`);
    assert.equal(out.ok, false);
    assert.match(out.error, /not found/);
  });

  test(`${exe}: instance names, ports, winget results and Node versions`, () => {
    const out = runPs(exe, [
      "@{",
      "  free = (Get-FreeInstanceName)",
      "  taken = (Get-FreeInstanceName -Taken 'sqlexpress')",
      "  taken2 = (Get-FreeInstanceName -Taken 'SQLEXPRESS','OPTILENS')",
      "  port = (Get-FreeTcpPort)",
      "  port2 = (Get-FreeTcpPort -InUse 1433,14330)",
      "  wingetOk = (Get-WingetFailure -ExitCode 0)",
      "  wingetSame = (Get-WingetFailure -ExitCode -1978335189)",
      "  wingetBad = (Get-WingetFailure -ExitCode 1)",
      "  node20 = (Test-NodeVersion 'v20.11.1'); node18 = (Test-NodeVersion 'v18.19.0'); junk = (Test-NodeVersion 'nope')",
      "  server = (ConvertTo-SqlServerName -Port 1433)",
      "} | ConvertTo-Json -Compress"
    ].join("\n"));
    assert.equal(out.free, "SQLEXPRESS");
    assert.equal(out.taken, "OPTILENS");
    assert.equal(out.taken2, "OPTILENS2");
    assert.equal(out.port, 1433);
    assert.equal(out.port2, 14331);
    assert.equal(out.wingetOk, null);
    assert.equal(out.wingetSame, null);
    assert.match(out.wingetBad, /code 1/);
    assert.deepEqual([out.node20, out.node18, out.junk], [true, false, false]);
    assert.equal(out.server, "127.0.0.1,1433");
  });
}

test("a dry run lists the whole plan, asks nothing and changes nothing", { skip: process.platform !== "win32" || shells().length === 0 }, () => {
  const dir = fs.mkdtempSync(path.join(scratch, "dry-"));
  const config = path.join(dir, "install.json");
  fs.writeFileSync(config, JSON.stringify({
    licenceFile: licence(), port: 8081,
    folders: { incoming: "D:\\Innovations\\Incoming", staging: "D:\\Innovations\\Staging", archive: "D:\\Innovations\\Archive" },
    admin: { username: "lab.admin", displayName: "Lab Admin" },
    site: { labNum: "1177", custSeqNum: "1", remoteOperator: "1177-004", agentName: "LL" }
  }));
  const stateFile = path.join(root, "data", "install-state.json");
  const before = fs.existsSync(stateFile);
  const run = spawnSync(shells()[0], ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(installDir, "Install-OptiLens.ps1"), "-DryRun", "-ConfigFile", config], { encoding: "utf8" });
  const out = run.stdout + run.stderr;
  assert.equal(run.status, 0, out);
  for (const step of ["Install Node.js", "Install Claude Code CLI", "Install packages", "Check and apply the licence", "Install SQL Server", "Configure SQL Server", "Create database and login", "Write .env", "Create folders", "Apply migrations", "Create administrator and site settings", "Open the firewall", "Start the application", "Keep it running", "Verify"]) {
    assert.match(out, new RegExp(`PLAN\\s+${step}`), step);
  }
  assert.match(out, /Dry run only/);
  assert.equal(fs.existsSync(stateFile), before, "a dry run writes no state");
});

test("the installer's files are classified for licensed builds", () => {
  const map = JSON.parse(fs.readFileSync(path.join(root, "editions", "file-map.json"), "utf8"));
  assert.ok(map.rules.some((rule) => rule.match.startsWith("scripts/install") && rule.owner === "core"), "scripts/install/** must ship as core");
});
