# OptiLens Local Agent Instructions

## Project direction

OptiLens Local is an internal Windows/Node platform and the private operational counterpart to the hosted Classic Visions website. The delivery/export workflow is one module within a broader modular platform.

## Required reading

- `docs/agent/PROJECT_KNOWLEDGE.md`
- `docs/agent/INTEGRATIONS.md`
- `docs/agent/HANDOFF.md`
- `docs/REMOTE_AGENT_OPERATIONS.md` before host access, deployment, restart, or recovery
- For operations-agent work: the review brief, README, build task, then relevant code/tests under `docs/operations-agent/`

## Data rules

- Preserve historic data.
- Discovery against source systems is read-only by default.
- Application-owned changes belong in the private app database and require audit context.
- Source-system writeback is disabled by default and remains separately gated.
- Use separate least-privilege read and write identities.
- Privileged SQL follows the implemented confirmation, limit, timeout, and audit policy.
- Do not expose on-premise databases to the public internet.

## Architecture rules

- Keep platform core separate from modules.
- Preserve legacy identifiers during migration.
- Use durable events, idempotent actions, bounded retries, dead-letter handling, reconciliation, feature flags, health monitoring, and emergency disable controls.
- Unknown or ambiguous matches become exceptions; do not guess.
- Keep supplier/internal status separate from customer-facing status.
- External messages and AI output become durable records before processing.
- AI returns validated proposals; deterministic code controls business rules and writes.

## Security

- Never commit credentials, secret values, private connection strings, LAN addresses, internal hostnames, usernames, DSNs, or private filesystem paths.
- Use environment variables, Windows secret storage, approved credential managers, and secure host aliases.
- Browser code receives no server credentials.
- Change-capable endpoints require authentication and authorization.
- Keep public operational status free of private infrastructure detail.

## Workflow

- Work only in the authoritative host checkout identified by secure host configuration.
- Preserve unrelated human changes and use feature branches.
- Use the guarded remote editing/deployment flow; do not edit multiple checkouts.
- Run relevant syntax checks and `npm test`; finish deployments with the documented health verification.
- Do not repeatedly restart or reset after a failed recovery. Preserve logs and report the failure.
- Scheduled synchronizations and source-system writes are outside routine standing authorization.

## Scope

Implement only the immediate milestone in the applicable build task. Future architecture described in review briefs is not automatically authorized scope.
