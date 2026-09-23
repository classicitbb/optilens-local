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
- RX Capture treats unresolved or uncertain extraction marks as visible warnings, not an intake dead-end. The intake owner can save the editable draft, choose an exact source-validated lens and optional coating, then use the dedicated `rx-capture.release`-guarded submit action to generate, stage, and release in one deliberate confirmation. The `.rx` serializer preserves unknown optical/frame values as blank; it never invents them. A valid patient name and exact active lens remain required because the proven Innovations serializer needs them.
- `lib/rx-capture/order-builder.js` is the deterministic bridge from a reviewed normalized order plus exact source selections to the existing proven `.rx` renderer. It preserves unresolved extracted values as blanks, rejects fuzzy catalogue choices, and never infers frame trace data.
- Active file-drop destinations are operational routing records managed in Integrations → Innovations Sync. They can be customer- and purpose-scoped; a matching customer route overrides the default route, while the legacy configured incoming folder remains a fallback. Credentials Vault remains for credentials, not a growing set of routing rules.

## Knowledge maintenance

Update this file with public-safe, durable facts that help the next agent: repository layout, non-sensitive commands, module ownership, generated-file rules, and architectural decisions. Do not record infrastructure topology, credential details, live endpoints, internal identities, private paths, customer data, or secret values. Retrieve authorized operational context from configured tools and secure host documentation at execution time.
