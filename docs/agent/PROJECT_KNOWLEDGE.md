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

## RX Capture

- `/rx-capture` is a full-screen, authenticated mobile intake page inside the existing Node HTTP process.
- `lib/rx-capture/normalized-order.js` is the source-neutral boundary shared by photo capture and future manual/customer/API entry paths.
- RX Capture records and non-clinical audit metadata live in the private app database under the `rx_capture` schema. Order reads and updates are owner-scoped in Milestone 1.
- RX Capture treats blank ADD, prism, and base cells as intentionally absent optional data, not missing data. ADD becomes required only when the extracted lens type/design explicitly indicates a multifocal family; illegible marks remain uncertain for employee review.
- RX Capture review displays extracted lens fields and optional frame details. Missing frame/lens metadata does not block review; an absent frame state defaults explicitly to `TO_BE_TRACED`, with measurements left null until a real trace replaces them.
- Milestone 1 stops at structured extraction, employee correction, persistence, and `NEEDS_INFO` / `READY_FOR_REVIEW` status. It does not approve, serialize, stage, release, or write Innovations data.

## Knowledge maintenance

Update this file with public-safe, durable facts that help the next agent: repository layout, non-sensitive commands, module ownership, generated-file rules, and architectural decisions. Do not record infrastructure topology, credential details, live endpoints, internal identities, private paths, customer data, or secret values. Retrieve authorized operational context from configured tools and secure host documentation at execution time.
