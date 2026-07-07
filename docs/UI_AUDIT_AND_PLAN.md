# OptiLens Local — UI Consistency Audit & Modularization Plan

_Date: 2026-07-07 · Scope: `public/` front-end (app shell + tool pages) · Author: audit pass_

## 1. Verdict

The platform is close to being a proper "shell + tools" product, but it is **not there yet**. The shell concept exists in spirit (a shared header, `shared.js`, `styles.css`, a launcher and search), but it is **copy-pasted rather than owned in one place**, and each tool page has been allowed to grow its own private styling. That is exactly why Doc Studio feels coherent (it is a single self-contained app) while the rest feels like a set of loosely related pages.

The good news: the design tokens, colour system, and shell CSS are already solid and centralised in `styles.css`. The fix is mostly **de-duplication and enforcement**, not a rewrite.

## 2. How it is built today

Static HTML per page, served by `server.js` via a hand-maintained route map (no templating engine). Every page links `styles.css` and `shared.js`. `shared.js` injects the overlays (launcher, search, auth, account), wires the theme toggle, and — tellingly — runs `normalizeHeaderIcons()` to *rewrite stale header markup at runtime*.

```
Shell (should be barebones frame)      Tools (should be self-contained)
─────────────────────────────────      ───────────────────────────────
index.html + app.js (Launch Pad)       delivery-export.html + .js
shared.js  (launcher/search/auth)      pricing-automation.html + .js
styles.css (tokens + shell + a lot)    doc-studio.html → iframes ds/studio.html
settings.html + settings.js            business-metrics.html
credentials.html                       integrations.html
admin-users.html + admin-users.js      automation.html
release-notes.html
login.html
```

## 3. Findings

### 3.1 The header is duplicated in all 11 pages — and has already drifted

The `<header class="top">` block is hand-copied into every page. It is **no longer identical**:

- `index.html` uses Material Symbols `<span>` icons; every other page still uses legacy inline `<svg>` icons. `shared.js.normalizeHeaderIcons()` exists purely to paper over this drift at runtime.
- `index.html` has a notifications button and a dashboard "edit" toggle; the tool pages don't.
- `auth-hide-signed-out` classes exist on `index.html` only.
- The search button behaves differently per page (`delivery-export` and `settings` hard-code `onclick="window.location='/'"`; others open the palette).
- The theme toggle glyph is `☽` on legacy pages vs a Material Symbol on `index`.

This is the single biggest source of "it doesn't feel like one app." Any header change today means editing 11 files and hoping they stay in sync (they haven't).

### 3.2 Every tool re-invents its own CSS in a private `<style>` block

Inline `<style>` line counts:

| Page | Inline CSS lines |
|---|---|
| pricing-automation.html | ~661 |
| statement-template.html | ~493 |
| release-notes.html | ~299 |
| credentials.html | ~187 |
| login.html | ~72 |
| business-metrics.html | ~15 |
| integrations.html | ~9 |
| doc-studio / delivery-export / settings / admin-users / automation | 0 |

`styles.css` is a 54 KB monolith shared by all, but the heavy tools bypass it with hundreds of lines of page-local CSS. That means spacing, cards, buttons, tables and form controls are defined multiple times, slightly differently, per tool — the visible inconsistency you noticed.

### 3.3 Font & asset loading is inconsistent

- `pricing-automation.html` loads an italic axis of Plus Jakarta Sans nobody else loads.
- Some pages load the Material Symbols stylesheet in `<head>`; others rely on `shared.js` injecting it late (causes an icon flash / FOUT).
- Cache-busting `?v=` is used on exactly one link (`delivery-export`), so shell CSS changes cache inconsistently across pages.

### 3.4 Information architecture: too many top-level "admin" pages

`settings`, `credentials`, `admin-users` (Users), and `release-notes` are all separate top-level destinations, but conceptually they are **shell administration**, not tools. This matches your instinct: Users, Credentials and Release Notes belong **inside Settings as tabs**.

### 3.5 Repo clutter / manageability

17 `.bak-*` snapshots sit in `public/` and the repo root (`delivery-export.*`, `styles.css`, `server.js`). They are served as static files, pollute search/grep, and make "which is the real file" ambiguous. Real backups belong in git history, not the served directory.

### 3.6 Doc Studio is the outlier — and shows the target quality bar

Doc Studio *looks* better because `ds/studio.html` is a single 300 KB self-contained app with its own consistent internal design system, embedded via iframe. That is fine as a pattern for a large tool — the lesson is not "make everything an iframe," it's "give every tool one coherent, shared styling foundation the way Studio has internally."

## 4. Target architecture: shell vs toolbox

Two clear layers, each with an enforced contract.

**The Shell (barebones frame, owned once):**
App frame, header/top bar, app launcher, global search, authentication, notifications, theme, and the administration surface (**Settings**, which absorbs Users, Credentials, Release Notes, Integrations config as tabs). The shell should be defined in exactly one place and injected — never hand-copied.

**The Toolbox (tools sit by themselves):**
Delivery & Export, Pricing Automation, Doc Studio, Business Metrics, Automation, etc. Each tool: its own folder, its own JS split into modules, its own scoped stylesheet that consumes shared tokens/components and adds only what is unique to it. A tool never redefines the header, buttons, cards, or colour tokens.

```
The barebones shell            The toolbox (each self-contained)
────────────────────           ─────────────────────────────────
• App frame + <header>         • delivery-export/
• App launcher                 • pricing-automation/
• Global search (Ctrl+K)       • doc-studio/  (already isolated)
• Auth / user menu             • business-metrics/
• Notifications + theme        • automation/
• Settings ──┬─ General
             ├─ Users          Each tool = markup + module JS chunks
             ├─ Credentials      + one scoped CSS that only uses
             ├─ Integrations     shared tokens & components.
             ├─ Modules
             └─ Release Notes
```

## 5. The plan (phased, low-risk, high-leverage first)

The ordering is deliberate: kill duplication before splitting files, so we split *clean* code.

### Status snapshot (updated after implementation)

- **Completed:** Phase 0 and Phase 1 are done in the current repo state.
- **Verified:** the shared shell header now renders from `shared.js`, protected routes such as Delivery & Export use the shared shell, and the repo no longer serves tracked `*.bak-*` snapshots from live paths.
- **Adjusted during implementation:** shell font assets were moved local so the header no longer depends on remote Google-hosted font CSS for Material Symbols or Plus Jakarta Sans.
- **Next recommended phase:** Phase 2, starting with shared shell/component CSS extraction before any large per-tool JS moves.

### Phase 0 — Housekeeping (completed)
1. Done: moved tracked `*.bak-*` files out of live repo paths and ignored future snapshots via `/_snapshots/` and `*.bak-*` in `.gitignore`.
2. Done: standardised shell-page `<head>` usage around shared manifest / icon / stylesheet links.
3. Done: replaced remote shell font dependencies with local font assets so shared header icons and typography work in external browsers without relying on Google font CSS.

### Phase 1 — Single-source the shell header (completed)
4. Done: authored the header once in `shared.js` and rendered it into a `<div id="app-shell-header"></div>` mount on each shell page, driven by `window.OptiLensPage`.
5. Done: deleted the 11 hand-copied `<header>` blocks and removed the `normalizeHeaderIcons()` runtime patch.
6. Done: kept the launcher app catalogue and header behavior in the same shell module so they no longer drift independently.

_Result: one header, one behaviour, one place to change it. This alone makes the app "feel like one app."_

### Phase 2 — Extract a shared component & token layer (next)
7. Split `styles.css` into a small, intentional set:
   - `tokens.css` — the `:root` variables + dark theme (already exists, just isolate it).
   - `base.css` — reset, typography, layout primitives (`.band`, `.section-head`, `.module-main`).
   - `components.css` — buttons, cards, badges, tables, form controls, tabs, endpoint lists, status pills. These are the repeated patterns currently re-implemented inline.
   - `shell.css` — header, launcher, search palette, overlays, user menu.
8. Migrate the big inline `<style>` blocks (pricing-automation, release-notes, credentials, statement-template) onto shared components. Whatever is genuinely tool-specific moves to that tool's own scoped CSS file (Phase 3), not an inline block.
9. Start with the shell-facing surfaces first: header/search/launcher styles, shared buttons, shared cards, shared tables, and form controls. Do not start Phase 3 JS splitting until these shared CSS contracts exist.

_Result: a card, button, or table looks identical in every tool because it's defined once._

### Phase 3 — Make each tool a self-contained module folder (incremental, one tool at a time)
10. Adopt a per-tool folder convention and migrate tools one at a time (start with the messiest, pricing-automation):
   ```
   public/tools/pricing-automation/
     index.html          ← markup only; includes shell mount + tool root
     pricing.css         ← scoped, tool-specific only (uses shared tokens)
     main.js             ← entry
     modules/            ← split the 101 KB pricing-automation.js here
       rules.js  ladder.js  sourcing-review.js  api.js  render.js
   ```
11. Split the oversized JS. `pricing-automation.js` (~101 KB) and `delivery-export.js` (~33 KB) should become several focused ES modules imported by a thin `main.js`. Keep each file to a single responsibility.

### Phase 4 — Split the shell itself into chunks (1–2 days)
12. Break `shared.js` (~33 KB, currently header + launcher + search + auth + account + drag-reorder in one file) into:
    ```
    public/shell/
      shell.js         ← bootstrap + header render + page config
      launcher.js      ← catalogue, render, drag-reorder
      search.js        ← command palette
      auth.js          ← sign-in, account, user menu
      theme.js         ← theme toggle
      catalog.js       ← SHELL_APP_CATALOG (single source of app list)
    ```
    Load as ES modules (`<script type="module" src="/shell/shell.js">`), or concatenate at build time if you want to avoid a build step.
13. Once the shell loader is split or templated, introduce one shared asset-version source for `styles.css`, `shared.js`, and other shell-owned assets instead of hand-maintained per-page `?v=` strings.

### Phase 5 — Consolidate administration into Settings (1–2 days)
14. Rebuild `settings.html` as a tabbed shell page: **General / Users / Credentials / Integrations / Modules / Release Notes**. Move the bodies of `admin-users.html`, `credentials.html`, and `release-notes.html` in as tab panels (each becomes a small partial/module, not a top-level page).
15. Keep the old routes (`/credentials`, `/admin/users`, `/release-notes`) as redirects into the relevant Settings tab so existing links and the server permission map keep working.

## 6. Conventions to lock in (so it stays consistent)

- **One shell, injected, never copied.** No page hand-writes the header again.
- **Tokens only.** Tool CSS may use `var(--…)` and shared component classes; it may not hard-code colours, radii, shadows, or redefine buttons/cards.
- **Tool = folder.** Every tool lives in `tools/<name>/` with markup + one scoped CSS + module JS. No file over ~300–400 lines; split by responsibility.
- **No inline `<style>` in tool pages** beyond a handful of truly one-off rules.
- **A tool never reaches into another tool or into shell internals** except through the documented shell API (`window.OptiLensShell`, `window.OptiLensAuth`, `window.OptiLensPage`).

## 7. Effort & sequencing summary

| Phase | Outcome | Est. | Visual risk |
|---|---|---|---|
| 0 Housekeeping | complete | done | none |
| 1 Single-source header | complete | done | low |
| 2 Component + token layer | next priority | 2–3 days | medium |
| 3 Tool module folders | manageable, split code | incremental | low per tool |
| 4 Split the shell | maintainable shell | 1–2 days | low |
| 5 Settings tabs (Users/Creds/Notes) | cleaner IA | 1–2 days | low |

**What is next:** Phase 2. The highest-leverage remaining work is to extract the shared CSS/component layer before splitting large tool JS files or reorganising folders. That keeps the next change set focused on visual consistency and avoids mixing styling cleanup with module-structure churn.

## 8. Suggested first pull request

Completed: Phase 0 + Phase 1 together removed `.bak` clutter, normalised shell-page assets, replaced all 11 hand-copied headers with a single `shared.js`-rendered header driven by `window.OptiLensPage`, and moved shell font assets local.

Suggested next pull request: Phase 2, scoped to extracting `tokens.css`, `base.css`, `components.css`, and `shell.css`, then moving the largest inline tool styles onto those shared components without changing route structure or tool JS ownership yet.
