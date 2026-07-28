# In-app local updates

OptiLens Local checks its loaded application files every minute while an administrator is signed in. The server also fetches the configured Git upstream every five minutes. The header's update button performs an immediate file and Git check.

When new files are found, the button becomes **Apply updates**. Selecting it performs the applicable work silently and reloads the browser once the updated app is healthy:

- Browser files reload without restarting the Node service.
- A fetched upstream Git update is fast-forward pulled from the configured branch before maintenance starts. A dirty checkout is never overwritten; the update notice explains that its local changes must be committed or stashed first.
- Server, library, script, dependency, and migration changes restart the Node service so startup workers are recreated.
- `package.json` or `package-lock.json` changes, and every pulled Git update, run reproducible `npm ci --omit=dev --no-audit --no-fund` first.
- Changed app database migrations, and every pulled Git update, run through the existing idempotent migration runner before the restart.

The update endpoint is restricted to `platform.admin`. The PowerShell work is launched only from that endpoint, hidden from the desktop, and writes progress/errors to `data/local-update.log`; ordinary users never see a console window. Administrators can open **User menu -> View update logs** to inspect the update log, watchdog log, and server error tail without browsing the filesystem. Each apply rechecks that Git is clean, records the original revision, runs syntax and application tests before migrations/restart, and rolls back the source/dependency revision if a pre-migration step fails. Database migrations are intentionally not rolled back because they can contain durable business changes. Login sessions are encrypted with Windows DPAPI for the service account and preserved across the controlled restart, subject to their existing eight-hour expiry.

Manual apply is the default: a fetched update is announced and an administrator selects **Apply updates**. To opt into unattended fast-forward Git pulls, set the user or machine environment variable `OPTILENS_AUTO_APPLY_UPDATES=true` and restart the app once. Automatic mode refuses to overwrite a dirty checkout and leaves the update as a notification instead.

## Host recovery

The authenticated server endpoint launches the update script on the same Windows host that runs `server.js`; this is where the pull, maintenance work, and Node restart occur. Administrators can also use **User menu -> Stop app** to intentionally stop the local host process; the shortcut, tray monitor, or watchdog can start it again.

The app starts a lightweight host-side watchdog automatically. It checks `/api/health/live` every minute, starts a replacement process when the app itself is not responding, and stays out of the way while an update holds its maintenance lock. A database or source-system outage therefore triggers connection recovery rather than needless service restart churn. For recovery after a full Windows reboot or user sign-out, install the scheduled watchdog **once on that host** with `npm run app:watchdog:install` from an elevated administrator session. The installer prompts for the current Windows account password and registers the task to run as that account whether the user is logged on or not. To install for a specific operator account, run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-app-watchdog-task.ps1 -RunAsUser "DOMAIN\User"`. The older `SYSTEM` mode is still available with `npm run app:watchdog:install:system`; in that mode all `OPTILENS_*` host credentials used by the service must be configured as **machine** environment variables, and the configured Git remote must be accessible to that service account. The app also reconnects failed MSSQL pools on the next request, retries the Zen mirror sync with bounded backoff, and retries live gateway internet calls with exponential backoff. Connected browser sessions display a reconnecting notice and restore their authenticated state and dashboard data when health returns.

## Interactive host monitor

The Node service, watchdog, update runner, and sync workers remain hidden background processes. The tray monitor is the intentional interactive surface for a host operator: `npm run app:tray` starts in the tray, and the status window opens from the tray menu or double-click. The tray icon shows green, warning, or error state for each connection and can independently restart or stop OptiLens Local. Run `npm run app:tray:startup` once from the host operator's Windows session to launch that monitor silently at sign-in; it is separate from the background service and does not keep the app alive. Windows cannot display a tray icon or desktop notification before an interactive sign-in, so the watchdog handles pre-login uptime and the tray monitor appears after the operator signs in.

Use the desktop shortcut created by `scripts/create-desktop-shortcut.ps1` (or `npm run app:monitor:shortcut`) to launch the taskbar-visible `OptiLensHostMonitor.exe`. It starts without an open PowerShell window and can be closed from the taskbar. Use the local service/taskbar workflow to open the web UI separately.

Updates do not run source-system imports, exports, or write-back jobs automatically. Those operations remain explicit because they can act on business data outside the application itself.
