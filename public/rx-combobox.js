// Dropdowns matching the CV website rx-order form (.combo / .cblist / .cbopt).
// Two entry points:
//   RxCombo.combo(input, options)  type-to-search choice over a dynamic list
//   RxCombo.select(select, options) replaces a native <select> popup with the
//                                   same list; the <select> stays the source of
//                                   truth and fires real input/change events.
// Lists are portaled into a fixed layer on <body> so card overflow never clips them.
(function (root) {
  const openLists = new Set();
  let portal = null;

  function portalRoot() {
    if (!portal) {
      portal = document.createElement("div");
      portal.id = "rxComboPortal";
      document.body.append(portal);
    }
    return portal;
  }

  function closeAll(except) {
    for (const entry of [...openLists]) if (entry !== except) entry.close();
  }

  function createList(field) {
    const list = document.createElement("div");
    list.className = "cblist";
    list.setAttribute("role", "listbox");
    list.id = `${field.id || field.dataset.path || "combo"}-listbox`.replace(/[^\w-]/g, "-");
    field.setAttribute("aria-controls", list.id);
    field.setAttribute("aria-expanded", "false");
    field.setAttribute("aria-autocomplete", field.tagName === "INPUT" ? "list" : "none");
    return list;
  }

  function position(anchor, list) {
    const rect = anchor.getBoundingClientRect();
    list.style.left = `${rect.left}px`;
    list.style.top = `${rect.bottom + 4}px`;
    list.style.width = `${rect.width}px`;
  }

  function renderOptions(list, labels, { selected, active, empty, heading }) {
    const group = heading ? [Object.assign(document.createElement("div"), { className: "cbgrp", textContent: heading })] : [];
    list.replaceChildren(...group, ...(labels.length ? labels.map((label, index) => {
      const option = document.createElement("div");
      option.className = `cbopt${label === selected ? " sel" : ""}${index === active ? " act" : ""}`;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(label === selected));
      option.dataset.index = String(index);
      option.textContent = label;
      return option;
    }) : [Object.assign(document.createElement("div"), { className: "cbnone", textContent: empty })]));
    list.querySelectorAll(".cbopt")[active]?.scrollIntoView?.({ block: "nearest" });
  }

  // Every typed word must appear in the label, in any order, so "28 flat" and
  // "flat top 28" both find "Bifocal · Flat Top 28". `synonyms` expands
  // shorthand ("ft" also matches "flat top"); letters and digits typed
  // together are split, so "ft28" reads as "ft 28".
  const tokens = (value) => String(value || "").toLowerCase().split(/[^a-z0-9.+-]+/).filter(Boolean);
  const splitMixed = (token) => token.replace(/([a-z])(\d)|(\d)([a-z])/g, "$1$3 $2$4").split(" ");
  function matcher(synonyms = {}) {
    return (label, query) => {
      const text = ` ${tokens(label).flatMap(splitMixed).join(" ")} `;
      const has = (word) => [word, ...(synonyms[word] || [])].some((form) => text.includes(` ${form}`));
      return tokens(query).every((token) => has(token) || (!synonyms[token] && splitMixed(token).every(has)));
    };
  }

  // Exact label first, then labels that start with the query, then the rest,
  // keeping catalogue order within each group ("src" puts SRCoated first).
  function rank(labels, query) {
    const q = query.toLowerCase();
    const score = (label) => (label.toLowerCase() === q ? 0 : label.toLowerCase().startsWith(q) ? 1 : 2);
    return labels.map((label, index) => ({ label, index, score: score(label) }))
      .sort((left, right) => left.score - right.score || left.index - right.index)
      .map((entry) => entry.label);
  }

  // Type-to-search input. `items()` returns the current labels; a pick sets the
  // input value and fires input + change. Enter picks and calls onAdvance.
  function combo(input, { items, allItems, conflictNote = "Other choices · picking clears conflicts", onAdvance = () => {}, empty = "No matches", synonyms }) {
    const matches = matcher(synonyms);
    const wrap = document.createElement("div");
    wrap.className = "combo";
    input.parentNode.insertBefore(wrap, input);
    wrap.append(input);
    input.classList.add("cbx", "cb-field");
    input.setAttribute("role", "combobox");
    // Name the combobox from its visible label, not the placeholder.
    const labelText = input.labels?.[0]?.firstChild?.textContent?.trim();
    if (labelText && !input.hasAttribute("aria-label")) input.setAttribute("aria-label", labelText);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "cbtog";
    toggle.tabIndex = -1;
    toggle.setAttribute("aria-label", "Show choices");
    toggle.textContent = "▾";
    wrap.append(toggle);
    const list = createList(input);
    let active = -1;
    let typed = false;
    let committed = input.value;

    // Until the user types, a filled field still lists every choice, so
    // changing your mind never means clearing the field first.
    // When nothing compatible matches what was typed, offer every catalogue
    // value under a note, so correcting a wrong guess never dead-ends.
    let widened = false;
    const visible = () => {
      const query = typed ? input.value.trim() : "";
      const labels = items();
      widened = false;
      if (!query) return labels;
      const found = rank(labels.filter((label) => matches(label, query)), query);
      if (found.length || !allItems) return found;
      const wider = rank(allItems().filter((label) => matches(label, query)), query);
      widened = wider.length > 0;
      return wider;
    };
    const entry = {
      close() {
        list.classList.remove("on");
        list.remove();
        input.setAttribute("aria-expanded", "false");
        openLists.delete(entry);
      },
      refresh() { if (list.classList.contains("on")) render(); },
      reposition() { if (list.classList.contains("on")) position(wrap, list); },
      setCommitted(value) { committed = value; }
    };
    function render() {
      const labels = visible();
      if (active >= labels.length) active = labels.length - 1;
      renderOptions(list, labels, { selected: input.value, active, empty, heading: widened ? conflictNote : "" });
    }
    function open() {
      if (input.disabled || input.readOnly) return;
      closeAll(entry);
      portalRoot().append(list);
      position(wrap, list);
      list.classList.add("on");
      input.setAttribute("aria-expanded", "true");
      openLists.add(entry);
      render();
    }
    // Restores the last real choice and lets the page re-check it.
    function revert() {
      input.value = committed;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    function commit(value) {
      input.value = value;
      committed = value;
      typed = false;
      active = -1;
      entry.close();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    input.addEventListener("focus", () => { typed = false; input.select(); open(); });
    input.addEventListener("click", open);
    input.addEventListener("input", (event) => {
      if (!event.isTrusted) return;
      typed = true;
      active = 0;
      open();
    });
    input.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) return;
      event.stopPropagation();
      const labels = visible();
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (!list.classList.contains("on")) open();
        if (!labels.length) return;
        active = Math.min((active < 0 ? -1 : active) + 1, labels.length - 1);
        render();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (!labels.length) return;
        active = Math.max(active - 1, 0);
        render();
      } else if (event.key === "Enter") {
        event.preventDefault();
        const pick = active >= 0 ? labels[active] : labels.length === 1 ? labels[0] : null;
        if (pick) {
          commit(pick);
          onAdvance(input);
        } else if (!typed && input.value) {
          entry.close();
          onAdvance(input);
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        revert();
        typed = false;
        entry.close();
      }
    });
    // Leaving the field keeps only real choices: an exact (case-insensitive)
    // match commits, an emptied field clears, anything else reverts.
    input.addEventListener("blur", () => setTimeout(() => {
      if (document.activeElement === input) return;
      entry.close();
      if (!typed) return;
      typed = false;
      const text = input.value.trim();
      const exact = (allItems ? allItems() : items()).find((label) => label.toLowerCase() === text.toLowerCase());
      if (exact) commit(exact);
      else if (!text) commit("");
      else revert();
    }, 120));
    toggle.addEventListener("mousedown", (event) => event.preventDefault());
    toggle.addEventListener("click", () => { input.focus(); open(); });
    list.addEventListener("mousedown", (event) => {
      const option = event.target.closest(".cbopt");
      if (!option) return;
      event.preventDefault();
      commit(visible()[Number(option.dataset.index)]);
    });
    return entry;
  }

  // Native <select> with the combo list as its popup. Closed, Enter is left to
  // the page (it moves to the next field); Space or arrows open the list.
  function select(field, { onAdvance = () => {} } = {}) {
    field.classList.add("cb-select", "cb-field");
    const list = createList(field);
    let active = -1;
    const options = () => [...field.options].filter((option) => !option.disabled);
    const entry = {
      close() {
        list.classList.remove("on");
        list.remove();
        field.setAttribute("aria-expanded", "false");
        openLists.delete(entry);
      },
      refresh() { if (list.classList.contains("on")) render(); },
      reposition() { if (list.classList.contains("on")) position(field, list); }
    };
    function render() {
      const visible = options();
      renderOptions(list, visible.map((option) => option.text), { selected: field.selectedOptions[0]?.text, active, empty: "No options" });
    }
    function open() {
      if (field.disabled) return;
      closeAll(entry);
      active = options().findIndex((option) => option.index === field.selectedIndex);
      portalRoot().append(list);
      position(field, list);
      list.classList.add("on");
      field.setAttribute("aria-expanded", "true");
      openLists.add(entry);
      render();
    }
    function commit(index) {
      const option = options()[index];
      entry.close();
      if (!option || option.index === field.selectedIndex) return;
      field.selectedIndex = option.index;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
    }
    field.addEventListener("mousedown", (event) => {
      event.preventDefault();
      field.focus();
      list.classList.contains("on") ? entry.close() : open();
    });
    // Typeahead like a native select: typed letters jump to the first option
    // starting with them, open or closed.
    let typeahead = "";
    let typeaheadTimer = null;
    function jumpTo(key) {
      clearTimeout(typeaheadTimer);
      typeahead += key.toLowerCase();
      typeaheadTimer = setTimeout(() => { typeahead = ""; }, 700);
      const index = options().findIndex((option) => option.text.toLowerCase().startsWith(typeahead));
      if (index < 0) return;
      if (list.classList.contains("on")) { active = index; render(); }
      else commit(index);
    }
    field.addEventListener("keydown", (event) => {
      const isOpen = list.classList.contains("on");
      if (event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        jumpTo(event.key);
        return;
      }
      if (!isOpen) {
        if (![" ", "ArrowDown", "ArrowUp"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        open();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Enter", " ", "Escape", "Tab"].includes(event.key)) return;
      if (event.key === "Tab") return entry.close();
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "ArrowDown") { active = Math.min(active + 1, options().length - 1); render(); }
      else if (event.key === "ArrowUp") { active = Math.max(active - 1, 0); render(); }
      else if (event.key === "Enter") { commit(active); onAdvance(field); }
      else if (event.key === " ") commit(active);
      else entry.close();
    });
    field.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== field) entry.close(); }, 120));
    list.addEventListener("mousedown", (event) => {
      const option = event.target.closest(".cbopt");
      if (!option) return;
      event.preventDefault();
      commit(Number(option.dataset.index));
    });
    return entry;
  }

  document.addEventListener("mousedown", (event) => {
    if (event.target.closest?.(".cblist, .combo, .cb-select")) return;
    closeAll();
  });
  window.addEventListener("scroll", (event) => {
    if (event.target?.closest?.(".cblist")) return;
    closeAll();
  }, true);
  window.addEventListener("resize", () => closeAll());

  root.RxCombo = { combo, select, closeAll };
})(window);
