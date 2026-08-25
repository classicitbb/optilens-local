# Project Knowledge

- Repository: `classicitbb/optilens-local`
- Default branch: `master`
- Last verified: 2026-08-24
- Role: Internal OptiLens application
- Business owner and production approver: Russell Hunte

## Start points

- Project rules: `AGENTS.md`
- Commands and dependencies: `package.json`
- Configuration-name template: `.env.example`
- Remote operating procedure: `docs/REMOTE_AGENT_OPERATIONS.md`
- Current scoped build instructions: the applicable module documentation
- Exact continuation: `docs/agent/HANDOFF.md`

## Verified development baseline

- Node.js 20 or later.
- Install dependencies with the repository’s npm lockfile workflow.
- Run `npm run check` and `npm test` for relevant code changes.
- Use the documented guarded lifecycle and health-verification procedures for authorized host work.

## Knowledge maintenance

Update this file with public-safe, durable facts that help the next agent: repository layout, non-sensitive commands, module ownership, generated-file rules, and architectural decisions. Do not record infrastructure topology, credential details, live endpoints, internal identities, private paths, customer data, or secret values. Retrieve authorized operational context from configured tools and secure host documentation at execution time.
