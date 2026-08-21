# Privileged Admin Data Access API

This API exposes arbitrary SQL to authenticated `platform.admin` users after a per-execution confirmation challenge. It is disabled unless `OPTILENS_PRIVILEGED_DATA_ACCESS_ENABLED=true` is set outside the repository.

## Sources

- `app-mssql`
- `source-mssql`
- `mirror-mssql`
- `reporting-mssql`
- `source-psql`

The configured account decides which tables and views are available. Configure write credentials separately with the relevant `OPTILENS_ADMIN_*_WRITE_USER` and `OPTILENS_ADMIN_*_WRITE_PASSWORD` settings. Never place a password in this document, a skill, or browser code.

## Execute a statement

1. `POST /api/admin/data-access/challenge` with `{ "source", "sql", "mode": "read" | "write" }`.
2. Display the returned SQL and confirmation text to the administrator.
3. `POST /api/admin/data-access/execute` with the `challengeId` and exact `confirmation`. Write statements also require the returned `writeConfirmation`.

Challenges expire after five minutes and are bound to the authenticated user, source, mode, and exact SQL text. Results are capped by `OPTILENS_PRIVILEGED_DATA_ACCESS_MAX_ROWS` and use `OPTILENS_PRIVILEGED_DATA_ACCESS_TIMEOUT_MS`.

Pass `artifactFormat` (`csv`, `xlsx`, or `pdf`) to `execute` to create an app-managed artifact. Download it through the authenticated URL returned in the result.

## Dashboard metrics

After a scalar query succeeds, `POST /api/admin/data-access/dashboard-metrics` with `{ "title", "description", "executionId" }`. The `executionId` is short-lived and belongs to the same administrator, so dashboard values cannot be supplied directly by a browser request.

Run the normal application migrations before using dashboard metrics. Each execution and metric creation records a lightweight event in `core.audit_events`.
