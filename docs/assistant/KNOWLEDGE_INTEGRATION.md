# OptiLens Assistant — Innova-Training Knowledge Integration
> Agent handoff document. Any agent (Antigravity, Claude, Codex, etc.) reading this
> has everything needed to continue or extend this feature.
>
> Last updated: 2026-08-20 | Commit: 3574d32

---

## What Was Built

The OptiLens system assistant (`/api/assistant/ask`) is now grounded on the
full **Innova-Training documentation repository**. On every `systemAsk()` call
the assistant receives the complete operational knowledge of Classic Visions /
Innovations LMS as a system-level context message — status codes, SQL syntax,
customer data, API patterns, report IDs, AR snapshots, and how-to guides.

A new endpoint (`GET /api/assistant/knowledge`) lets operators and agents
inspect which documents are loaded, their sizes, and the cache age.

---

## Architecture & Data Flow

```
User question
    │
    ▼
POST /api/assistant/ask
    │
    ▼
lib/metrics/assistant.js  →  systemAsk()
    │
    ├─ 1. SYSTEM_ASSISTANT_PROMPT      (static, inline — role, rules, GenStatus codes,
    │                                   key status IDs, API patterns, module URLs,
    │                                   output format rules, action block template)
    │
    ├─ 2. buildKnowledgeContext()      ← lib/knowledge-base.js
    │       Loads & concatenates Innova-Training/*.md files
    │       Cached 5 min (in-memory). First call reads ~80 KB from disk.
    │
    ├─ 3. Route context               (current page, inventory summary if on metrics)
    │
    ├─ 4. Chat history                (last 6 turns)
    │
    └─ 5. User question
    │
    ▼
LLM (Ollama / OpenAI-compatible endpoint)
    │
    ▼
Response: { answer, actionProposal }
    actionProposal → frontend renders clickable "Execute Action" card
    navigate_to    → window.location.href deeplink (no server round-trip)
```

---

## Files Involved

### Backend

| File | Role |
|---|---|
| [`lib/knowledge-base.js`](../../lib/knowledge-base.js) | Loads Innova-Training docs, caches result, exposes `buildKnowledgeContext()` / `getKnowledgeStatus()` / `clearKnowledgeCache()` |
| [`lib/metrics/assistant.js`](../../lib/metrics/assistant.js) | `systemAsk()` — builds LLM message array incl. knowledge injection. `SYSTEM_ASSISTANT_PROMPT` — rich static context. Exports `getKnowledgeStatus`. |
| [`server.js`](../../server.js) | Registers routes: `POST /api/assistant/ask`, `GET /api/assistant/knowledge`, `GET /api/assistant/tools` |

### Frontend

| File | Role |
|---|---|
| [`public/shared.js`](../../public/shared.js) | `sendGlobalAssistantQuestion()` — sends question to `/api/assistant/ask`. `appendAssistantMessage()` — renders answer + action card. Action click handler → `navigate_to` executes `window.location.href`. |

### Training Docs (external repo)

| Path | Content | Loaded chars |
|---|---|---|
| `Innova-Training/01-system-overview.md` | Company, API auth, status codes, GenStatus, users, infrastructure | 14 000 |
| `Innova-Training/02-sql-guide.md` | PSQL syntax rules, all core tables (Orders, RxJobs, StockItems, LensItem, Invoices…) | 21 000 |
| `Innova-Training/04-constraints-guide.md` | Report parameter/constraint syntax | 7 000 |
| `Innova-Training/05-tam-reports.md` | TAM report series | 8 000 |
| `Innova-Training/06-api-reference.md` | Full Innovations REST API reference | 7 000 |
| `Innova-Training/07-how-to-operate.md` | Step-by-step task guides | 7 000 |
| `Innova-Training/source-context/innovations-knowledge.md` | Additional knowledge | 8 500 |
| `Innova-Training/03-report-queries.md` | 80+ report SQL queries (190 KB — first 8 000 chars loaded) | 8 000 |

Default path: `C:\Users\Administrator\Documents\GitHub\Innova-Training`
Override via env: `INNOVA_TRAINING_PATH=<path>`

---

## Key Constants (in `lib/knowledge-base.js`)

```js
CACHE_TTL_MS = 5 * 60 * 1000   // 5-minute in-memory cache
REPORT_QUERIES_EXCERPT_CHARS = 8000  // only first 8 KB of the 190 KB report file
```

Each entry in `KNOWLEDGE_FILES[]` has `{ file, label, maxChars }`. Adjust
`maxChars` if a doc needs more context, but watch total token budget.

---

## How to Add a New Training Document

1. Drop the `.md` file into `C:\Users\Administrator\Documents\GitHub\Innova-Training\`
   (or a subdirectory).

2. Add an entry to `KNOWLEDGE_FILES` in `lib/knowledge-base.js`:
   ```js
   { file: "my-new-doc.md", label: "My New Topic", maxChars: 8000 }
   ```

3. Restart the server (`npm run app:restart`) or wait 5 min for cache to expire.

4. Verify via `GET /api/assistant/knowledge` — the new file should appear in
   `files[]` with `found: true`.

No changes to `assistant.js` or `server.js` are required.

---

## How to Extend Output Types

The assistant can already produce: plain text, markdown tables, code blocks,
and deeplink action cards. To add a new output capability:

### Add a new action tool (server side)
In `lib/metrics/assistant.js`, add an entry to `ACTION_TOOLS`:
```js
my_new_action: {
  name: "my_new_action",
  label: "Human-readable label",
  description: "What it does",
  requiresConfirmation: true   // set true for destructive actions
}
```

Then handle it in `executeAction()`:
```js
} else if (action === "my_new_action") {
  resultData = await doTheThing(params);
}
```

Add the action name to the `SYSTEM_ASSISTANT_PROMPT` available actions list
so the LLM knows it can propose it.

### Add a new action type (frontend side)
In `public/shared.js`, inside the `msgContainer` click handler:
```js
if (action === "my_new_action" && params.something) {
  // handle client-side without a server round-trip
  doClientThing(params.something);
  return;
}
```

---

## Endpoints

| Method | Path | Auth | Returns |
|---|---|---|---|
| `POST` | `/api/assistant/ask` | `delivery.read` | `{ answer, actionProposal, model, configured }` |
| `POST` | `/api/assistant/execute-action` | `delivery.read` | `{ success, action, result, audit }` |
| `GET` | `/api/assistant/tools` | `delivery.read` | `{ tools: ACTION_TOOLS }` |
| `GET` | `/api/assistant/knowledge` | `delivery.read` | `{ trainingPath, pathAccessible, files[], loadedFiles, totalKbOnDisk, cacheAge }` |
| `GET` | `/api/business-metrics/assistant/status` | `delivery.read` | LLM endpoint reachability |
| `GET` | `/api/business-metrics/assistant/config` | `delivery.read` | Provider config (key redacted) |
| `POST` | `/api/business-metrics/assistant/config` | `delivery.read` | Save provider config |

---

## Test Commands (run from repo root)

```powershell
# Syntax check
node --check lib/knowledge-base.js
node --check lib/metrics/assistant.js
node --check server.js

# Knowledge files check (no server needed)
node -e "const kb = require('./lib/knowledge-base'); const s = kb.getKnowledgeStatus(); console.log(JSON.stringify(s, null, 2))"

# Knowledge endpoint (requires auth session — 401 means route is registered)
Invoke-WebRequest -Uri http://localhost:8080/api/assistant/knowledge -Method GET

# Full restart
npm run app:restart
```

---

## Open Extension Points

These are things that could be built next, in priority order:

1. **Markdown rendering in the chat drawer** — `appendAssistantMessage()` currently renders plain text with `<br>`. Adding a lightweight markdown renderer (e.g. `marked.js`) would make tables, bold, and code blocks display correctly.

2. **Per-route knowledge injection** — inject route-specific excerpts (e.g. only the delivery-related sections when on `/modules/delivery-export`) to stay within smaller model context windows.

3. **Cache invalidation API** — `POST /api/assistant/knowledge/reload` calls `clearKnowledgeCache()` so an operator can force a fresh load after adding a new doc, without restarting the server.

4. **Artifact output type** — allow the assistant to produce a downloadable file (CSV, PDF) as a response. Requires a new action tool and a temp-file write path.

5. **Deeper report-queries loading** — the 190 KB `03-report-queries.md` is currently excerpted at 8 000 chars. A semantic search layer (embeddings) would let the assistant pull only the relevant report SQL rather than truncating.

6. **More training docs** — as new analyses are done (cost sheets, lens inventory, AR aging updates), drop the `.md` into `Innova-Training/` and they are auto-loaded on the next cache refresh.

---

## Related Documents

- [`docs/AI_AGENT_MONITOR_HARNESS.md`](../AI_AGENT_MONITOR_HARNESS.md) — how agents start/stop/verify the server
- [`docs/operations-agent/README.md`](../operations-agent/README.md) — operations automation direction
- [`docs/operations-agent/CODEX_BUILD_TASK.md`](../operations-agent/CODEX_BUILD_TASK.md) — Milestone 1 build scope
- [`AGENTS.md`](../../AGENTS.md) — non-negotiable platform rules all agents must follow
- [`Innova-Training/CLAUDE_FILES.md`](../../../../Innova-Training/CLAUDE_FILES.md) — inventory of all training docs
