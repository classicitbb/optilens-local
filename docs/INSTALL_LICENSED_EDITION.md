# Clean install of a licensed edition (installer's guide)

This guide is for the person installing OptiLens RX Capture (for example the Value Optical edition) on a lab's server for the first time. It assumes an empty machine and an empty database. For upgrades, see `LOCAL_UPDATES.md` in the core repository; for how licensing works, see `EDITIONS.md`.

You need three things from the vendor before you start. None of them is in the repository.

| Item | What it is |
| --- | --- |
| Source access | Read access to the edition's repository (for Value Optical, `classicitbb/optilens-value-optical`) |
| `data/edition.json` | The signed licence for this lab. Without it the application starts with only the core (sign-in, users, settings) |
| Lab details | The lab number, remote operator ID and the Innovations *incoming* folder path, which you enter in step 8 |

Do not write passwords, keys or connection strings in this repository, in tickets or in shell history. The commands below prompt for them.

## 1. Prepare the server

- Windows with an administrator account for the install.
- **Node.js 20 or later** (`node --version`) and **Git**.
- **SQL Server** (Express is enough) with TCP/IP enabled, plus `sqlcmd` on the server, or SQL Server Management Studio on any machine that can reach it.
- The server can open the Innovations incoming folder (a network share or a local path). Whoever runs the service must be able to write there.
- Outbound HTTPS to the licence renewal address, if the licence has one (trials and annual licences do). If the network blocks it, nothing breaks, but renewals will not arrive.

## 2. Get the code

```powershell
cd C:\
git clone https://github.com/classicitbb/optilens-value-optical optilens
cd optilens
npm ci --omit=dev --no-audit --no-fund
```

Check that this is a licensed build: `lib\edition-build.json` must exist and contain `{"requireManifest": true}`. If it does not, you have the wrong repository. Stop, because a copy of the full source would run every module.

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

- The commands were checked against the build output and the code, not yet run on a blank server. Expect to correct details on the first real install, and send the corrections back as a pull request to core.
- Windows service installation is not covered. The scheduled-task watchdog is the supported way to keep the application up.
