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

## Windows CLI launcher

- `npm run codex:launch` starts the pinned Codex CLI `0.156.1` in a native `cmd.exe` console and clears inherited `TERM=dumb`; use `npm run codex:launch:current` to start the globally installed CLI instead. The desktop shortcut invokes PowerShell with `-File` rather than targeting the `.ps1` directly.
- Codex CLI `0.157.0` has a reported Windows daemon startup regression for which `0.156.1` is a documented workaround. Current Codex Windows guidance recommends Windows 11 and lists recent Windows 10 as best effort; it does not list Windows Server. Claude Code documents Windows Server 2019 support. Treat the pin as a compatibility workaround, not a supported-platform guarantee.

## RX Capture

- `/rx-capture` is a full-screen, authenticated mobile intake page inside the existing Node HTTP process.
- `lib/rx-capture/normalized-order.js` is the source-neutral boundary shared by photo capture and future manual/customer/API entry paths.
- RX Capture records and non-clinical audit metadata live in the private app database under the `rx_capture` schema. Order reads and updates are owner-scoped in Milestone 1.
- RX Capture treats blank ADD, prism, and base cells as intentionally absent optional data, not missing data. ADD becomes required only when the extracted lens type/design explicitly indicates a multifocal family; illegible marks remain uncertain for employee review.
- RX Capture normalizes patient names and references to uppercase at both the review form and normalized-order boundary. Its calculated ED from A/B replaces an unchanged extracted ED; a later operator-entered ED remains an explicit override.
- RX Capture review displays extracted lens fields and optional frame details. Missing frame/lens metadata does not block review; an absent frame state defaults explicitly to `TO_BE_TRACED`, with measurements left null until a real trace replaces them.
- RX Capture treats unresolved or uncertain extraction marks as visible warnings, not an intake dead-end. The intake owner can save the editable draft, choose an exact source-validated lens and optional coating, then use the dedicated `rx-capture.release`-guarded submit action to generate, stage, and release in one deliberate confirmation. The `.rx` serializer preserves unknown optical/frame values as blank; it never invents them. A valid patient name and exact active lens remain required because the proven Innovations serializer needs them.
- On application startup, RX Capture reschedules persisted `PROCESSING` captures for safe recovery. Voice intake derives and validates clip duration from the uploaded audio bytes before any transcription request. A retried staged release treats hash-matching archive/incoming files as a reconciliation of an interrupted audit, not a second delivery.
- `lib/rx-capture/order-builder.js` is the deterministic bridge from a reviewed normalized order plus exact source selections to the existing proven `.rx` renderer. It preserves unresolved extracted values as blanks, rejects fuzzy catalogue choices, and never infers frame trace data.
- RX Capture catalogue availability is sourced from Innovations `LensItem` configurations with `Flags & 2 = 0`; Pricing Automation rows enrich supplier metadata but do not determine whether a lens is selectable. Edged RX Capture jobs communicate edging through frame fields and do not emit the `EDGE TO FIT` miscellaneous item.
- Active file-drop destinations are operational routing records managed in Integrations → Innovations Sync. They can be customer- and purpose-scoped; a matching customer route overrides the default route, while the legacy configured incoming folder remains a fallback. Credentials Vault remains for credentials, not a growing set of routing rules.

## Knowledge maintenance

- PR #57 RX outbox fixture coverage runs with `node --test test/rx-order-submitter.test.js`. It preserves cloud-rendered OD-only/OS-only Hashref bytes and tests watcher accepted/rejected/pending verdicts and worker completion payloads without network or file-drop writes. Single-eye `rx_eye` codes 1/2 remain provisional until live Innovations intake is verified. Current watcher acceptance means file disappearance only; pending also produces `ok: true`, so neither proves creation of an Innovations order.

Update this file with public-safe, durable facts that help the next agent: repository layout, non-sensitive commands, module ownership, generated-file rules, and architectural decisions. Do not record infrastructure topology, credential details, live endpoints, internal identities, private paths, customer data, or secret values. Retrieve authorized operational context from configured tools and secure host documentation at execution time.
