# Integration Operating Rules

This public file records boundaries, not private topology.

- Verify every required connector in the active session using a harmless read-only call.
- Access to GitHub does not grant access to hosts, databases, accounting, mail, or the hosted website.
- Use scoped, authenticated, audited integration tools.
- Keep credentials and private infrastructure details in approved secret/configuration systems.
- Keep customer-safe hosted behavior separate from private operational access.
- Use versioned contracts, idempotency, bounded retries, audit context, and reconciliation.
- For assigned repository build tasks, production application deployment, app-database migrations, restart, and health verification are standing-authorized. Source-system writes, external sends, credential/permission changes, destructive actions, and access expansion remain separately controlled unless the task expressly includes them.
- Record new non-sensitive connector names and contract ownership here; record private access details only in the approved secure system.

## RX Capture image extraction

- The server calls the configured OpenAI Responses-compatible endpoint with one or two image inputs and a strict normalized-order JSON Schema.
- Credentials resolve server-side from the existing assistant/OpenAI Credentials Vault entry, with `OPENAI_API_KEY` retained only as a legacy fallback. The browser never receives the key.
- Credentials → API Keys exposes a dedicated OpenAI API entry with provider, base URL, model, and masked API key fields; its harmless connectivity check uses bearer authentication against the provider model list.
- RX-specific non-secret configuration names are `OPENAI_RX_MODEL`, `OPENAI_RX_BASE_URL`, and `RX_CAPTURE_RETAIN_IMAGES`.
- Requests set provider storage off. Local temporary images are removed after successful extraction unless retention is deliberately enabled.
- A live extraction is billable and must not be used as a harmless connector check. Verify configuration without logging secret values; perform a real-image call only with explicit authorization and suitable patient-data approval.
