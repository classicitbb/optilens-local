# Clean install of a licensed edition (installer's guide)

This guide is for the person installing OptiLens RX Capture (for example the Value Optical edition) on a lab's server for the first time. It assumes an empty machine and an empty database. For upgrades, see `LOCAL_UPDATES.md` in the core repository; for how licensing works, see `EDITIONS.md`.

You need three things from the vendor before you start.

| Item | What it is |
| --- | --- |
| The code | The vendor puts the licensed build on the server (a folder containing `server.js` and `lib\edition-build.json`). You do not clone anything and need no repository access or tokens |
| The licence | A signed `edition.json`, delivered separately from the code. Without it the application starts with only the core (sign-in, users, settings) |
| Lab details | The lab number, remote operator ID, the Innovations *incoming* folder path and the name you want for the lab's administrator |

## Automated install (recommended)

From an **elevated** PowerShell, in the folder the vendor delivered:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install\Install-OptiLens.ps1
```

It installs Node.js, Git for Windows, the Claude Code CLI and SQL Server Express with `winget`, asks for the answers it needs, and finishes with the app running and checked. Add `-DryRun` first to see the plan without changing anything. To skip the questions that have fixed answers, copy `scripts\install\install.config.example.json`, fill it in and pass `-ConfigFile`.

What it asks:

| Question | Notes |
| --- | --- |
| Path to the licence file | The `edition.json` from the vendor. It is verified before anything is installed |
| Port | Default 8080 |
| Innovations incoming, staging and archive folders | Full paths. Incoming must already be reachable; staging and archive are created |
| Lab number, customer sequence, remote operator, agent name | Saved as the lab's site settings |
| Administrator username, display name, email | Not `optilens`; that account is the built-in one and is turned off |
| Administrator password | Typed twice at a masked prompt |
| Use an existing SQL Server instance? | Only asked when an instance with room is found (see below) |
| Windows password for the service account | Asked once by the Windows credentials dialog, for the scheduled task that keeps the app running |

**SQL Server.** The installer looks for instances already on the machine. An instance is offered only if it is running, you can sign in to it as a sysadmin with your Windows account, it is SQL Server 2016 or later, its disk has at least 5 GB free, and (for Express) its databases total under 6 GB, because Express shares 1.4 GB of memory across all databases. If it qualifies, you are asked whether to use it. If it needs a restart (mixed sign-in or a fixed TCP port), you are asked to allow that. Otherwise, or if you answer no, it installs a new Express instance: `SQLEXPRESS`, or `OPTILENS` if that name is taken. It never installs over an existing instance. Either way it ends with `optilens_local` fully migrated and a dedicated `optilens_app` login whose password is generated and kept only in `.env`.

**Claude Code CLI.** The installer puts `claude` on the machine (`winget` package `Anthropic.ClaudeCode`, plus Git for Windows, which it uses for shell tools) and checks `claude --version`. It cannot sign in for you: after the install, open a new terminal as the person who will use it, run `claude` once and sign in. It is installed for the Windows account that ran the installer.

**Passwords.** The installer never reads a password from a file, a parameter or an environment variable. Its own passwords it generates. Yours you type at the prompt. Nothing secret is written to `data\install.log`.

**Repeating it.** Each step checks whether it is already done, so after a failure fix the cause and run it again. Answers already given are remembered in `data\install-state.json` (no secrets). A second run never resets the administrator's password or the database login.

**Updates.** The code was delivered by the vendor, not cloned, so there is no Git remote to pull from. The installer sets `OPTILENS_AUTO_APPLY_UPDATES=false` when the folder has no `.git`. The vendor delivers updates; see the vendor's instructions.

### For an agent running the installer

1. Read this document, then run `Install-OptiLens.ps1 -DryRun` and read the plan.
2. Collect the non-secret answers from the person, write them to a config file outside the repository, and run the installer with `-ConfigFile`.
3. The installer needs a terminal where a person can type the administrator password and the Windows password. Do not ask for these in chat, and do not try to supply them yourself. Open a visible terminal for the person, or ask them to run the command.
4. The output is one `PASS`, `SKIP`, `FAIL` or `PLAN` line per step. On `FAIL` the message says what to fix. Fix it and run the same command again.
5. Do not edit `data\edition.json`, and do not change `.env` by hand while the installer is running.
6. When it ends with `OptiLens is installed`, open the URL it prints and confirm the sign-in page loads.

The rest of this document is the same procedure by hand. Use it if the installer cannot run, or to understand what it did.

# Manual install

Do not write passwords, keys or connection strings in this repository, in tickets or in shell history. The commands below prompt for them.

## 1. Prepare the server

- Windows with an administrator account for the install.
- **Node.js 20 or later** (`node --version`). Git is not needed.
- **SQL Server** (Express is enough) with TCP/IP enabled, plus `sqlcmd` on the server, or SQL Server Management Studio on any machine that can reach it.
- The server can open the Innovations incoming folder (a network share or a local path). Whoever runs the service must be able to write there.
- Outbound HTTPS to the licence renewal address, if the licence has one (trials and annual licences do). If the network blocks it, nothing breaks, but renewals will not arrive.

## 2. Get the code

The vendor has put the licensed build in a folder on the server. Install its packages from inside that folder:

```powershell
cd <the delivered folder>
npm ci --omit=dev --no-audit --no-fund
```

Check that this is a licensed build: `lib\edition-build.json` must exist and contain `{"requireManifest": true}`. If it does not, stop and ask the vendor, because a copy of the full source would run every module.

## 3. Create the database

The database must be named `optilens_local`; the migrations select it by name. As a SQL administrator:

```powershell
sqlcmd -S "SERVER\INSTANCE" -E -N -C -b -i database\001-create-database.sql
```

This creates the empty database and its schemas. It does nothing if the database already exists. Use `-U` and `-P` instead of `-E` if you sign in with a SQL login.

## 4. Create the application's SQL login

1. Open `scripts\create-sql-login-template.sql` in SQL Server Management Studio, connected as a SQL administrator.
2. Replace `REPLACE_WITH_STRONG_PASSWORD` with a real password. Do not save the edited file into the repository.
3. Run it. It creates the login `optilens_app` and makes it owner of `optilens_local` only.
4. Leave the commented `Innovations` block alone. A licensed lab does not read that database.

## 5. Configure the application

Copy `.env.example` to `.env` in the repository root (the application reads it at start-up) and set only these values:

```text
OPTILENS_HOST=0.0.0.0
OPTILENS_PORT=8080
OPTILENS_DB_SERVER=SERVER\INSTANCE
OPTILENS_DB_NAME=optilens_local
OPTILENS_DB_USER=optilens_app
OPTILENS_DB_PASSWORD=<the password from step 4>
OPTILENS_DB_ENCRYPT=true
OPTILENS_DB_TRUST_CERT=true
```

Remove or ignore the other lines in `.env.example`. They belong to modules this edition does not include (QuickBooks, Innovations reporting and so on). If the lab uses git updates from a branch other than `master`, add `OPTILENS_UPDATE_BRANCH=main`. Confirm the branch name with the vendor.

`.env` is not tracked by Git. Restrict its permissions to administrators and the service account.

## 6. Install the licence

Copy the vendor's `edition.json` to `data\edition.json` (create `data\` if it is missing). Do not edit it: the signature covers every field, and a changed file is ignored. You confirm it took effect in step 7, once the application is running.

## 7. Start the application, run migrations, sign in

```powershell
npm start
```

In a second window:

```powershell
Invoke-RestMethod http://127.0.0.1:8080/api/health/live
Invoke-RestMethod -Method Post http://127.0.0.1:8080/api/admin/migrate
```

`/api/health/live` must answer. The migration call returns the list of files it applied. On a clean install, expect the core files, then the RX Capture files (`043` onward). It is safe to run again: files already applied are skipped. A licensed edition applies only its own modules' migrations.

Open `http://<server>:8080/` in a browser. A clean install has no user accounts, so the sign-in dialog opens in **Create first admin** mode. Create the lab's first administrator there, with a name and password of the lab's own. There is no built-in account and no vendor password. Until that first administrator exists, anyone who can reach the port can create it, so do this straight away; if the server is on a shared network, start with `OPTILENS_HOST=127.0.0.1` in `.env` and do it from the server itself, then switch back to `0.0.0.0` and restart.

Once signed in as that administrator, open `/api/system/edition` in the browser. It must show the licensee, the expected modules (for Value Optical, `rx-capture` and `vault`) and an end date that makes sense. If it does not, see Troubleshooting.

**Do this immediately, before anyone else uses the system:**

1. Open `/admin/users` and create a named administrator for each person who will manage the system. Keep the first one as a spare.
2. Confirm every account has a password its owner chose.

Migrations never create, enable or re-password an account, so updates do not change who can sign in.

## 8. Enter the lab's site settings

Sign in as an administrator, open **RX Capture**, then the gear button. Fill in:

- lab number, customer sequence, remote operator and agent name;
- the Innovations **incoming**, **staging** and **archive** folders.

Select **Check folders**. Every folder must report reachable and writable. Until the lab number, remote operator and incoming folder are saved, the application refuses to approve, submit or release any order, so a new lab never sends a file under another lab's number.

Placing a first test order is the real check. Do it with the lab's Innovations contact, who can confirm the file arrived and delete it.

## 9. Keep it running

Set the application to start at boot and recover on its own. From an elevated PowerShell in the repository root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-app-watchdog-task.ps1
```

It prompts for the password of the Windows account the application will run as and registers a task that starts the application at boot and restarts it if `/api/health/live` stops answering. Use `-RunAsUser "DOMAIN\User"` to choose the account. The account needs write access to the repository folder and the incoming folder.

Open TCP 8080 in Windows Firewall for the lab's network only. If the lab wants HTTPS, put a reverse proxy in front of port 8080 (IIS with a certificate, for example) and leave the application on HTTP.

Stop and start it with `scripts\stop-app.ps1` and `scripts\start-app.ps1`.

## 10. Hand-over checklist

- [ ] `GET /api/health/live` answers, and the service restarts after a reboot.
- [ ] `GET /api/system/edition` (signed in as an administrator) lists the expected modules and end date.
- [ ] Named administrators exist, and no account has a password the lab did not choose.
- [ ] **Check folders** reports all folders reachable and writable.
- [ ] One test order went from capture to the Innovations incoming folder and the lab confirmed it.
- [ ] The database is in the lab's backup job.
- [ ] You told the lab when the licence ends and who renews it. A trial or expired licence leaves only sign-in, users and settings, and licensed pages answer 402.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Login failed for user 'optilens_app'` | Wrong password in `.env`, or the login was not created (step 4). Fix it and restart. |
| `Invalid object name 'core.…'` | Migrations have not run. Run step 7's migration call. |
| Every page except sign-in answers 404 | No valid licence. Check that `data\edition.json` exists, that the service account can read it, and that `/api/system/edition` reports why it was rejected. If it says the signature is invalid, ask the vendor for a fresh copy. |
| Pages answer 402 | The licence has ended. Ask the vendor for a renewal. |
| `listen EACCES` on 8080 | Windows reserved the port. Pick another with `OPTILENS_PORT`, or see `netsh interface ipv4 show excludedportrange protocol=tcp`. |
| Submit is refused | Site settings are incomplete (step 8). |
| Database error on a server with a named instance | Enable TCP/IP and SQL Browser for the instance, or give the explicit port in `OPTILENS_DB_SERVER`. |

## Known gaps in this guide

- Neither the manual steps nor `Install-OptiLens.ps1` has run on a blank server yet. What is tested: the licence check, the password, `.env`, validation and SQL-capacity logic, both scripts parsing in PowerShell 5.1 and 7, and a dry run. What is not: the `winget` installs of Node.js and SQL Express (including `/INSTANCENAME` for a second instance), the registry changes that enable TCP/IP and mixed sign-in, and the scheduled task. Expect to correct details on the first real install, and send them back as a pull request to core.
- Windows service installation is not covered. The scheduled-task watchdog is the supported way to keep the application up.
