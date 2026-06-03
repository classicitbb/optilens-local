# OptiLens Local Setup

## What Exists Now

The project has been reset from the old static page into a platform starter.

- LAN URL target: `http://192.168.254.9:8080/`
- Platform database recommendation: `optilens_local`
- Display name: OptiLens Local
- First module: Delivery and Export
- First historic source: `CV_Accounts_be.accdb`
- First release write behavior: app-owned shipment close/reopen/edit only
- Source write-back: disabled until explicitly designed and approved

## Run The Web App

From `O:\`:

```powershell
npm start
```

Then open:

```text
http://192.168.254.9:8080/
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
   - `O:\database\004-seed-platform.sql`

This creates:

- `optilens_local`
- `core` schema
- `delivery` schema
- `integration` schema
- `archive` schema
- Platform seed records

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
