# OptiLens Local Setup

## What Exists Now

The project has been reset from the old static page into a platform starter.

- LAN URL target: `http://192.168.254.9:8080/`
- Platform database recommendation: `optilens_local`
- Display name: OptiLens Local
- First module: Delivery and Export
- Additional module starter: Pricing Automation
- First historic source: `CV_Accounts_be.accdb`
- First release write behavior: app-owned shipment close/reopen/edit only
- Source write-back: disabled until explicitly designed and approved
- PWA install: available from the browser install option at the LAN URL

## Run The Web App

From `O:\`:

```powershell
npm start
```

Then open:

```text
http://192.168.254.9:8080/
```

For a background run that survives the current PowerShell window:

```powershell
O:\scripts\start-app.ps1
```

To restart after code changes:

```powershell
O:\scripts\restart-app.ps1
```

To install a Windows Scheduled Task that starts the app at boot and checks it every minute:

```powershell
O:\scripts\install-app-watchdog-task.ps1
```

The watchdog calls `O:\scripts\ensure-app-running.ps1`, which checks `http://127.0.0.1:8080/api/health` and restarts the Node process if it is not responding.

If Windows reports `listen EACCES` on port `8080`, check whether the port is reserved:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
```

Remove only the `8080` exclusion from an elevated PowerShell window:

```powershell
netsh interface ipv4 delete excludedportrange protocol=tcp startport=8080 numberofports=1
```

Until that elevated fix is available, the scripts can run the app on an unreserved temporary port:

```powershell
O:\scripts\start-app.ps1 -Port 8090
O:\scripts\install-app-watchdog-task.ps1 -Port 8090
```

## LAN Name And Alias URLs

The app listens on `0.0.0.0:8080`, so the machine name should work on the LAN when name resolution is available:

```text
http://MSSQL-SVR:8080/
```

For a friendlier alias such as `http://optilens:8080/`, add a DNS `A` record for `optilens` pointing to `192.168.254.9`. For a quick single-machine test, add this line to that client PC's `C:\Windows\System32\drivers\etc\hosts` file:

```text
192.168.254.9 optilens
```

Current verification note:

- The Node app is running successfully from this session at `http://127.0.0.1:8080/` and `http://192.168.254.1:8080/`.
- The requested `http://192.168.254.9:8080/` currently serves the static page from IIS/static hosting.
- To make API routes work at `192.168.254.9`, run the Node app on that server or configure IIS on that server to reverse-proxy `/api/*` and module routes to the Node app.

Useful API checks:

```text
http://127.0.0.1:8080/api/health
http://127.0.0.1:8080/api/dashboard
http://127.0.0.1:8080/api/modules
```

## SQL Server Status

Windows integrated authentication was tested with:

```text
Data Source=MSSQL-SVR;Integrated Security=True;Encrypt=True;TrustServerCertificate=True
```

It failed in this session with an SSPI/Kerberos credential error. That usually means this session does not have a usable Windows security token for that SQL Server connection.

The easiest next step is to use a SQL login for setup, or have a SQL admin run the database scripts.

## Create The App Database With SQL Admin Access

In SQL Server Management Studio:

1. Connect to `MSSQL-SVR` as a SQL admin.
2. Open and run:
   - `O:\database\001-create-database.sql`
   - `O:\database\002-core-schema.sql`
   - `O:\database\003-delivery-module-schema.sql`
   - `O:\database\006-pricing-module-schema.sql`
   - `O:\database\004-seed-platform.sql`
   - `O:\database\007-auth-hardening.sql`

This creates:

- `optilens_local`
- `core` schema
- `delivery` schema
- `pricing` schema
- `integration` schema
- `archive` schema
- Platform seed records
- User credential, role, and permission hardening records

## Desktop Shortcut / PWA Install

Open the LAN URL in Microsoft Edge or Chrome:

```text
http://192.168.254.9:8080/
```

Use the browser install option to install OptiLens Local as an app. The installed app uses the PWA manifest and can be launched from a Start menu or desktop shortcut. API write actions still go through the Node service and private app database.

Browser PWA service workers require a secure origin. `localhost` works for testing, but a LAN IP over plain HTTP may need HTTPS before the browser offers a full PWA install. Until HTTPS is configured, deploy a normal Windows URL shortcut:

```powershell
O:\scripts\create-desktop-shortcut.ps1 -Url "http://192.168.254.9:8080/" -PublicDesktop
```

## Create A SQL Login For The App

In SQL Server Management Studio:

1. Open `O:\scripts\create-sql-login-template.sql`.
2. Replace `REPLACE_WITH_STRONG_PASSWORD` with a strong password.
3. Run it as SQL admin.
4. Do not save the real password in the repository.

The login template:

- Creates SQL login `optilens_app`.
- Grants it owner rights on `optilens_local`.
- Leaves source `Innovations` read-only grant commented out until approved.

## Save App DB Credentials Without Editing Code

After the SQL login exists, run this in PowerShell:

```powershell
O:\scripts\set-app-db-env.ps1 -Server "MSSQL-SVR" -Database "optilens_local" -User "optilens_app"
```

It prompts for the password and saves the app database settings as Windows user environment variables. The password is not written to the repository.

Then restart the app:

```powershell
Get-NetTCPConnection -LocalPort 8080 | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
cd O:\
npm start
```

Check:

```text
http://127.0.0.1:8080/api/health
```

When credentials are correct, `appDatabase.state` should be `online`.

## Run Database Setup From CLI

If you have a SQL admin login:

```powershell
O:\scripts\run-db-setup-with-sql-login.ps1 -Server "MSSQL-SVR" -User "YOUR_SQL_ADMIN" -Password "YOUR_PASSWORD"
```

If Windows auth works from a normal logged-in desktop:

```powershell
O:\scripts\run-db-setup-with-windows-auth.ps1 -Server "MSSQL-SVR"
```

## First Build Sequence

1. Confirm the web app loads at `http://192.168.254.9:8080/`.
2. Create `optilens_local`.
3. Create the app SQL login.
4. Add environment variables for app DB connection.
5. Build the Access backend import job from `CV_Accounts_be.accdb`.
6. Import last-12-month active records plus archive path.
7. Connect the Delivery and Export module to app-owned shipment sessions.
8. Add read-only source lookup for `ShipmentItems` by `CustomerAccount` and `ShipmentID`.
9. Add authentication for change-capable module screens.
10. Keep the dashboard route unauthenticated for LAN display.

## First Admin Login

After app DB credentials are configured and migrations have been applied, open:

```text
http://127.0.0.1:8080/admin/users
```

If no password credential exists yet, the sign-in dialog switches to first-admin bootstrap mode. Create the first administrator there. Before the first credential exists, `/api/admin/migrate` remains available so a fresh install can create the auth tables. After bootstrap, migrations require `platform.admin`, and only an account with the `users.manage` permission can create, disable, or update users.

The auth hardening migration also seeds and resets this default administrator each time migrations are run:

```text
Username: optilens
Password: optilens
```

Use this only as a bootstrap login. After setup, create named administrator accounts and disable the default `optilens` account from `/admin/users`.

If the login page returns `Login failed for user 'optilens_app'`, the Node app cannot connect to the private app database yet. Fix or recreate the SQL Server login first, then rerun migrations so the `optilens` account is seeded:

1. In SQL Server Management Studio, connect to `MSSQL-SVR` as a SQL admin.
2. Open `O:\scripts\create-sql-login-template.sql`.
3. Replace `REPLACE_WITH_STRONG_PASSWORD` with the same password you will save for `OPTILENS_DB_PASSWORD`.
4. Run the script.
5. Run `O:\scripts\set-app-db-env.ps1 -Server "MSSQL-SVR" -Database "optilens_local" -User "optilens_app"` and enter that password.
6. Restart the Node app.
7. Run migrations, then sign in with `optilens` / `optilens`.

If the login page or API returns `Invalid object name 'core.user_credentials'`, the app database exists but the auth hardening migration has not been applied to that database. Run:

```powershell
Invoke-WebRequest -UseBasicParsing -Method Post http://127.0.0.1:8080/api/admin/migrate
```

Then restart the app and sign in with `optilens` / `optilens`.

Protected module APIs now require login. The dashboard and basic health/status routes remain available for LAN display, but changing dashboard layout, delivery sessions, pricing data, connector secrets, credential vault data, migrations, and cleanup actions require an authenticated user with the matching permission.

## Access Import Dry Run

The current dry-run command is:

```powershell
python O:\scripts\access-import-dry-run.py --source "C:\Users\cvre\OneDrive\OPTICINFO\CV Accounts BE DB\CV_Accounts_be.accdb" --output "O:\docs\access-import-dry-run.json"
```

The result is also available through:

```text
http://127.0.0.1:8080/api/access-import/dry-run
```
