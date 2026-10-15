/**
 * annotate.js — admin-only page annotation tool for OptiLens Local.
 * Loaded by shared.js for users with platform.admin. Opened from the header pencil menu (or the A key).
 * Notes live in this browser's localStorage per page; export as markdown to hand to a developer/agent.
 */
(function () {
  "use strict";
  if (window.__optilensAnnotate) return;
  window.__optilensAnnotate = true;

  const PRIORITIES = [
    { id: "must", label: "Must change", color: "#dc2626" },
    { id: "prefer", label: "I'd prefer", color: "#d97706" },
    { id: "idea", label: "Idea", color: "#2563eb" }
  ];
  const UI = "data-annotate-ui";
  const storeKey = () => "optilens.annotate." + location.pathname;

  let notes = [];
  let active = false;
  let editing = null; // { note|null, el, selector, location }
  let hoverEl = null;
  let layer, hoverBox, popover, drawer, banner, menu, pencil, rafId = 0;

  // ── Permissions ───────────────────────────────────────────────────────────
  function isAdmin() {
    try {
      return Boolean(AUTH_STATE.user && (AUTH_STATE.user.permissions || []).includes("platform.admin"));
    } catch { return false; }
  }

  // ── Storage ───────────────────────────────────────────────────────────────
  function load() {
    try { notes = JSON.parse(localStorage.getItem(storeKey()) || "[]"); } catch { notes = []; }
    if (!Array.isArray(notes)) notes = [];
  }
  function save() {
    try { localStorage.setItem(storeKey(), JSON.stringify(notes)); } catch { /* storage may be blocked */ }
  }

  // ── Element description ───────────────────────────────────────────────────
  function ours(el) { return Boolean(el && el.closest && el.closest("[" + UI + "]")); }

  function selectorFor(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && node !== document.body && depth < 7; depth++) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) { parts.unshift("#" + node.id); break; }
      let part = node.tagName.toLowerCase();
      const classes = [...node.classList].filter((c) => /^[a-z][\w-]*$/i.test(c) && !/^(is-|has-|active|open|hidden|closing)/.test(c)).slice(0, 2);
      if (classes.length) part += "." + classes.join(".");
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((s) => s.tagName === node.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ");
  }

  function clip(text, n) {
    text = String(text || "").replace(/\s+/g, " ").trim();
    return text.length > n ? text.slice(0, n - 1) + "…" : text;
  }

  function labelOf(el) {
    const named = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.getAttribute("name");
    if (named) return clip(named, 40);
    if (el.id) {
      const lab = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lab) return clip(lab.textContent, 40);
    }
    const text = clip(el.textContent, 40);
    return text || el.tagName.toLowerCase();
  }

  function locationFor(el) {
    const crumb = document.querySelector(".top-crumb")?.textContent.trim() || document.title;
    const section = el.closest("section, .panel, .card, [role=tabpanel], form, dialog, [role=dialog]");
    const heading = section && section !== el ? section.querySelector("h1, h2, h3, h4, .panel-title, legend") : null;
    const out = [crumb];
    if (heading && !heading.contains(el)) out.push(clip(heading.textContent, 40));
    out.push(labelOf(el));
    return out.filter((v, i, a) => v && a.indexOf(v) === i).join(" → ");
  }

  function resolve(note) {
    try { return document.querySelector(note.selector); } catch { return null; }
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid.nodeType ? kid : document.createTextNode(kid));
    return el;
  }
  const priority = (id) => PRIORITIES.find((p) => p.id === id) || PRIORITIES[1];

  function injectStyles() {
    if (document.getElementById("annotateStyles")) return;
    const css = `
.annot-layer{position:fixed;inset:0;z-index:2147483000;pointer-events:none}
.annot-layer>*{pointer-events:auto}
.annot-hover{position:fixed;border:2px solid var(--blue,#1A8A9C);background:rgba(26,138,156,.08);border-radius:4px;pointer-events:none!important;display:none}
.annot-pin{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;color:#fff;font:700 11px/22px system-ui,sans-serif;text-align:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4);cursor:pointer;padding:0}
.annot-pin[hidden]{display:none}
.annot-pop,.annot-drawer{position:fixed;background:var(--surface,#fff);color:var(--ink,#0B1E35);border:1px solid var(--line,#d0d7de);border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.28);font:13px/1.4 system-ui,sans-serif}
.annot-pop{width:320px;padding:12px}
.annot-pop textarea{width:100%;min-height:76px;box-sizing:border-box;margin:8px 0;padding:8px;border:1px solid var(--line,#d0d7de);border-radius:6px;background:var(--surface,#fff);color:inherit;font:inherit;resize:vertical}
.annot-loc{font-size:11px;color:var(--muted,#64748b);word-break:break-word}
.annot-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.annot-chip{border:1px solid var(--line,#d0d7de);border-radius:999px;padding:3px 10px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:12px}
.annot-chip[aria-pressed=true]{color:#fff;border-color:transparent}
.annot-btn{border:1px solid var(--line,#d0d7de);border-radius:6px;padding:5px 12px;background:var(--surface,#fff);color:inherit;cursor:pointer;font:inherit;font-weight:600}
.annot-btn.primary{background:var(--blue,#1A8A9C);color:#fff;border-color:transparent}
.annot-btn.danger{color:#dc2626}
.annot-spacer{flex:1}
.annot-banner{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;padding:8px 14px;border-radius:999px;background:#0B1E35;color:#fff;font:600 13px system-ui,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.35)}
.annot-banner .annot-btn{padding:3px 10px;background:transparent;color:#fff;border-color:rgba(255,255,255,.4)}
.annot-drawer{top:0;right:0;bottom:0;width:min(420px,100vw);border-radius:0;display:flex;flex-direction:column}
.annot-drawer header{padding:12px 14px;border-bottom:1px solid var(--line,#d0d7de);display:flex;gap:8px;align-items:center}
.annot-drawer header strong{flex:1;font-size:14px}
.annot-list{flex:1;overflow:auto;padding:8px 14px}
.annot-list h4{margin:12px 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.annot-item{padding:8px;border:1px solid var(--line,#d0d7de);border-radius:8px;margin-bottom:6px;cursor:pointer}
.annot-item:hover{background:var(--top-hover,rgba(0,0,0,.04))}
.annot-drawer footer{padding:10px 14px;border-top:1px solid var(--line,#d0d7de)}
body.annot-active{cursor:crosshair!important}
body.annot-active *{cursor:crosshair!important}
.annot-flash{outline:3px solid #d97706!important;outline-offset:2px}`;
    const style = h("style", { id: "annotateStyles" }, css);
    document.head.append(style);
  }

  // ── Pins ──────────────────────────────────────────────────────────────────
  function renderPins() {
    if (!layer) return;
    layer.querySelectorAll(".annot-pin").forEach((p) => p.remove());
    notes.forEach((note, i) => {
      const pin = h("button", { class: "annot-pin", type: "button", "data-note": note.id, title: note.text, "aria-label": "Note " + (i + 1) + ": " + note.text, onclick: (e) => { e.stopPropagation(); openEditor(resolve(note), note); } }, String(i + 1));
      pin.style.background = priority(note.priority).color;
      layer.append(pin);
    });
    positionPins();
  }

  function positionPins() {
    rafId = 0;
    if (!layer) return;
    layer.querySelectorAll(".annot-pin").forEach((pin) => {
      const note = notes.find((n) => n.id === pin.dataset.note);
      const el = note && resolve(note);
      const r = el && el.getBoundingClientRect();
      if (!r || (!r.width && !r.height) || getComputedStyle(el).visibility === "hidden") { pin.hidden = true; return; }
      pin.hidden = false;
      pin.style.left = Math.min(Math.max(r.right, 12), innerWidth - 12) + "px";
      pin.style.top = Math.min(Math.max(r.top, 12), innerHeight - 12) + "px";
    });
  }
  const schedulePins = () => { if (!rafId) rafId = requestAnimationFrame(positionPins); };

  // ── Editor popover ────────────────────────────────────────────────────────
  function closeEditor() { popover?.remove(); popover = null; editing = null; }

  function openEditor(el, note) {
    if (!el && !note) return;
    closeEditor();
    const selector = note ? note.selector : selectorFor(el);
    const location = note ? note.location : locationFor(el);
    let chosen = note ? note.priority : "prefer";
    const ta = h("textarea", { placeholder: "What would you change?", "aria-label": "Note" }, note ? note.text : "");
    const chips = PRIORITIES.map((p) => {
      const chip = h("button", { class: "annot-chip", type: "button", "aria-pressed": String(p.id === chosen), onclick: () => { chosen = p.id; paint(); } }, p.label);
      chip.dataset.p = p.id;
      return chip;
    });
    function paint() {
      chips.forEach((c) => { const on = c.dataset.p === chosen; c.setAttribute("aria-pressed", String(on)); c.style.background = on ? priority(c.dataset.p).color : ""; });
    }
    function commit() {
      const text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      if (note) { note.text = text; note.priority = chosen; }
      else notes.push({ id: "n" + Date.now().toString(36), text, priority: chosen, selector, location, snippet: clip(el.textContent, 80), at: new Date().toISOString() });
      save(); closeEditor(); renderPins(); refreshDrawer();
    }
    popover = h("div", { class: "annot-pop", [UI]: true, role: "dialog", "aria-label": "Annotation" },
      h("div", { class: "annot-loc" }, location),
      ta,
      h("div", { class: "annot-row" }, chips),
      h("div", { class: "annot-row", style: "margin-top:10px" },
        note ? h("button", { class: "annot-btn danger", type: "button", onclick: () => { notes = notes.filter((n) => n !== note); save(); closeEditor(); renderPins(); refreshDrawer(); } }, "Delete") : null,
        h("span", { class: "annot-spacer" }),
        h("button", { class: "annot-btn", type: "button", onclick: closeEditor }, "Cancel"),
        h("button", { class: "annot-btn primary", type: "button", onclick: commit }, "Save")));
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); } });
    ensureLayer().append(popover);
    paint();
    const r = el ? el.getBoundingClientRect() : { left: 80, bottom: 80, top: 80 };
    const left = Math.min(Math.max(8, r.left), innerWidth - 336);
    let top = r.bottom + 8;
    if (top + 220 > innerHeight) top = Math.max(8, r.top - 228);
    popover.style.left = left + "px";
    popover.style.top = Math.min(top, innerHeight - 228) + "px";
    editing = { note, el };
    ta.focus();
  }

  // ── Markdown export ───────────────────────────────────────────────────────
  function toMarkdown() {
    const lines = ["# Annotation feedback — " + document.title, "",
      "- Page: " + location.pathname + location.search,
      "- Exported: " + new Date().toISOString(),
      "- Viewport: " + innerWidth + "×" + innerHeight, ""];
    PRIORITIES.forEach((p) => {
      const group = notes.map((n, i) => ({ n, i })).filter(({ n }) => n.priority === p.id);
      if (!group.length) return;
      lines.push("## " + p.label, "");
      group.forEach(({ n, i }) => {
        lines.push((i + 1) + ". **" + n.location + "** — " + n.text.replace(/\n+/g, " "));
        lines.push("   - selector: `" + n.selector + "`");
        if (n.snippet) lines.push("   - element text: \"" + n.snippet + "\"");
      });
      lines.push("");
    });
    return lines.join("\n");
  }

  async function copyMarkdown(btn) {
    const md = toMarkdown();
    try { await navigator.clipboard.writeText(md); btn.textContent = "Copied"; }
    catch {
      const ta = h("textarea", { style: "position:fixed;opacity:0" }, md);
      document.body.append(ta); ta.select();
      try { document.execCommand("copy"); btn.textContent = "Copied"; } catch { btn.textContent = "Copy failed"; }
      ta.remove();
    }
    setTimeout(() => { btn.textContent = "Copy markdown"; }, 1500);
  }

  function downloadMarkdown() {
    const slug = (location.pathname.replace(/\W+/g, "-").replace(/^-|-$/g, "") || "launch-pad");
    const a = h("a", { href: URL.createObjectURL(new Blob([toMarkdown()], { type: "text/markdown;charset=utf-8" })), download: slug + "-FEEDBACK.md", [UI]: true });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ── Review drawer ─────────────────────────────────────────────────────────
  function jumpTo(note) {
    const el = resolve(note);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("annot-flash");
    setTimeout(() => { el.classList.remove("annot-flash"); schedulePins(); }, 1400);
  }

  function refreshDrawer() { if (drawer) { closeDrawer(); openDrawer(); } }
  function closeDrawer() { drawer?.remove(); drawer = null; }

  function openDrawer() {
    closeDrawer();
    const list = h("div", { class: "annot-list" });
    if (!notes.length) list.append(h("p", { class: "annot-loc" }, "No notes on this page yet. Turn on Annotate and click anything."));
    PRIORITIES.forEach((p) => {
      const group = notes.map((n, i) => ({ n, i })).filter(({ n }) => n.priority === p.id);
      if (!group.length) return;
      const title = h("h4", {}, p.label + " (" + group.length + ")");
      title.style.color = p.color;
      list.append(title);
      group.forEach(({ n, i }) => list.append(h("div", { class: "annot-item", onclick: () => jumpTo(n) },
        h("div", { class: "annot-loc" }, (i + 1) + " · " + n.location), h("div", {}, n.text),
        h("div", { class: "annot-row", style: "margin-top:6px" },
          h("button", { class: "annot-btn", type: "button", onclick: (e) => { e.stopPropagation(); openEditor(resolve(n), n); } }, "Edit")))));
    });
    const copyBtn = h("button", { class: "annot-btn primary", type: "button", onclick: () => copyMarkdown(copyBtn) }, "Copy markdown");
    drawer = h("aside", { class: "annot-drawer", [UI]: true, "aria-label": "Review annotations" },
      h("header", {}, h("strong", {}, "Review & export · " + notes.length), h("button", { class: "annot-btn", type: "button", onclick: closeDrawer }, "Close")),
      list,
      h("footer", { class: "annot-row" }, copyBtn,
        h("button", { class: "annot-btn", type: "button", onclick: downloadMarkdown, disabled: !notes.length }, "Download .md"),
        h("span", { class: "annot-spacer" }),
        h("button", { class: "annot-btn danger", type: "button", disabled: !notes.length, onclick: () => { if (confirm("Delete all " + notes.length + " notes on this page?")) { notes = []; save(); renderPins(); refreshDrawer(); } } }, "Clear")));
    ensureLayer().append(drawer);
  }

  // ── Annotate mode ─────────────────────────────────────────────────────────
  function ensureLayer() {
    if (layer) return layer;
    injectStyles();
    layer = h("div", { class: "annot-layer", [UI]: true });
    hoverBox = h("div", { class: "annot-hover" });
    layer.append(hoverBox);
    document.body.append(layer);
    renderPins();
    return layer;
  }

  function freeze(e) {
    if (!active || ours(e.target)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }
  function onClick(e) {
    if (!active || ours(e.target)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    openEditor(e.target, null);
  }
  function onMove(e) {
    if (!active || ours(e.target) || editing) return;
    hoverEl = e.target;
    const r = hoverEl.getBoundingClientRect();
    Object.assign(hoverBox.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  }
  function onKey(e) {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === "Escape" && (editing || drawer || active)) {
      e.preventDefault();
      if (editing) closeEditor(); else if (drawer) closeDrawer(); else setActive(false);
      return;
    }
    if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "a" && isAdmin()) {
      e.preventDefault(); setActive(!active);
    }
  }

  function setActive(on) {
    if (on && !isAdmin()) return;
    active = on;
    ensureLayer();
    document.body.classList.toggle("annot-active", on);
    pencil?.setAttribute("aria-pressed", String(on));
    banner?.remove(); banner = null;
    if (hoverBox) hoverBox.style.display = "none";
    if (on) {
      banner = h("div", { class: "annot-banner", [UI]: true, role: "status" },
        "Annotate mode — click anything to leave a note · Esc to exit",
        h("button", { class: "annot-btn", type: "button", onclick: openDrawer }, "Review & export"),
        h("button", { class: "annot-btn", type: "button", onclick: () => setActive(false) }, "Done"));
      layer.append(banner);
    } else closeEditor();
  }

  // ── Header pencil menu ────────────────────────────────────────────────────
  function closeMenu() { menu?.remove(); menu = null; pencil?.setAttribute("aria-expanded", "false"); }

  function openMenu() {
    closeMenu();
    const item = (icon, label, hint, fn) => h("button", { class: "user-dropdown-item", type: "button", role: "menuitem", onclick: () => { closeMenu(); fn(); } },
      h("span", { class: "material-symbols-outlined", style: "font-size:14px" }, icon), label, hint ? h("kbd", { style: "margin-left:auto;font-size:10px;opacity:.7" }, hint) : null);
    menu = h("div", { class: "user-dropdown", role: "menu", [UI]: true },
      dashToggle ? item("dashboard_customize", dashToggle.getAttribute("aria-pressed") === "true" ? "Lock dashboard" : "Edit dashboard", "", () => { bypass = true; dashToggle.click(); bypass = false; }) : null,
      item("edit_note", active ? "Stop annotating" : "Annotate this page", "A", () => setActive(!active)),
      item("rate_review", "Review & export (" + notes.length + ")", "", openDrawer));
    pencil.parentElement.append(menu);
    pencil.setAttribute("aria-expanded", "true");
  }

  let dashToggle = null, bypass = false;

  function mountPencil() {
    if (pencil && document.contains(pencil)) return;
    dashToggle = document.getElementById("dashboardEditToggle");
    if (dashToggle) {
      pencil = dashToggle;
      pencil.addEventListener("click", (e) => {
        if (bypass || !isAdmin()) return;
        e.preventDefault(); e.stopImmediatePropagation();
        menu ? closeMenu() : openMenu();
      }, true);
    } else {
      const right = document.querySelector(".top-right");
      if (!right) return;
      pencil = h("button", { class: "top-action-btn auth-hide-signed-out", id: "annotateMenuBtn", type: "button", "aria-label": "Edit and annotate", title: "Annotate (A)", "aria-haspopup": "menu", "aria-expanded": "false", onclick: (e) => { e.stopPropagation(); menu ? closeMenu() : openMenu(); } },
        h("span", { class: "material-symbols-outlined" }, "edit"));
      right.insertBefore(pencil, right.querySelector(".top-action-btn:not(.update-check-btn)") || right.firstChild);
    }
    if (!pencil.parentElement.classList.contains("user-chip-wrap")) {
      const wrap = h("div", { class: "user-chip-wrap" });
      pencil.parentNode.insertBefore(wrap, pencil);
      wrap.append(pencil);
    }
    pencil.setAttribute("aria-haspopup", "menu");
    pencil.setAttribute("aria-expanded", "false");
  }

  // ── Wiring ────────────────────────────────────────────────────────────────
  function sync() {
    if (isAdmin()) { mountPencil(); if (pencil) pencil.hidden = false; }
    else { setActive(false); closeDrawer(); closeMenu(); if (pencil && pencil.id === "annotateMenuBtn") pencil.hidden = true; }
  }

  load();
  ["click"].forEach((t) => document.addEventListener(t, onClick, true));
  ["mousedown", "mouseup", "pointerdown", "pointerup", "submit", "dblclick", "contextmenu"].forEach((t) => document.addEventListener(t, freeze, true));
  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("click", (e) => { if (menu && !menu.parentElement.contains(e.target)) closeMenu(); });
  window.addEventListener("scroll", schedulePins, true);
  window.addEventListener("resize", schedulePins);
  new MutationObserver(schedulePins).observe(document.body, { childList: true, subtree: true });
  window.addEventListener("optilens:auth-changed", sync);
  sync();
})();
