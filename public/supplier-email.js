(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    supplier: null,
    message: null,
    workspace: null,
    mappings: null,
    recordSearch: "",
    sort: { key: null, direction: null },
    filters: {
      patient_id: "",
      customer_name: "",
      customer_account: "",
      supplier_status: "",
    },
  };
  const esc = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const dateLabel = (value) =>
    value
      ? new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(new Date(value))
      : "Unknown date";
  const shortDate = (value) =>
    value
      ? new Intl.DateTimeFormat(undefined, {
          month: "short",
          day: "numeric",
        }).format(new Date(value))
      : "";
  const ageBand = (value) => {
    const received = value ? new Date(value).getTime() : NaN;
    if (!Number.isFinite(received)) return "age-unknown";
    const days = Math.max(0, (Date.now() - received) / 86400000);
    if (days < 5) return "age-0-5";
    if (days < 7) return "age-5-7";
    if (days < 11) return "age-7-11";
    if (days < 14) return "age-11-14";
    if (days < 17) return "age-14-17";
    if (days < 28) return "age-17-28";
    return "age-28-plus";
  };
  const ageLabel = (value) =>
    value
      ? `${Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86400000))} days old`
      : "Received date unavailable";
  const shippedRowClass = (row) => (row.is_shipped ? " shipped-row" : "");
  const textValue = (value) => String(value ?? "").trim();
  const sourceLabel = (row) =>
    textValue(row.record_kind) || textValue(row.rule_code) || "—";
  const recordSearchText = (row) =>
    [
      row.supplier_reference,
      row.patient_id,
      row.customer_name,
      row.customer_account,
      row.supplier_status,
      row.current_status_description || row.current_status_id,
      row.target_status_description || row.target_status_item_id,
    ]
      .map((value) => textValue(value).toLocaleLowerCase())
      .join(" ");
  const recordCollator = new Intl.Collator(undefined, {
    numeric: true,
    sensitivity: "base",
  });
  async function json(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
    });
    const body = await response.json();
    if (!response.ok)
      throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }
  function sizeMailboxColumns(workspace) {
    const container = document.querySelector(".mailbox-workspace");
    if (!container) return;
    const supplierNames = [
      { supplier_name: "All suppliers" },
      ...(workspace.suppliers || []),
    ].map((item) => String(item.supplier_name || ""));
    const subjects = (workspace.messages || []).map((item) =>
      String(item.subject || ""),
    );
    const longestSupplier = Math.max(
      12,
      ...supplierNames.map((value) => value.length),
    );
    const longestSubject = Math.max(
      24,
      ...subjects.map((value) => value.length),
    );
    const supplierWidth = Math.min(
      260,
      Math.max(150, Math.round(longestSupplier * 6.5 + 55)),
    );
    const messageWidth = Math.min(
      480,
      Math.max(280, Math.round(longestSubject * 5.4 + 95)),
    );
    container.style.setProperty("--supplier-pane-width", `${supplierWidth}px`);
    container.style.setProperty("--message-pane-width", `${messageWidth}px`);
  }
  function renderKpis(workspace) {
    const summary = workspace.summary || {};
    $("mailboxKpis").innerHTML = [
      ["Messages", summary.messages || 0],
      ["Parsed records", summary.records || 0],
      [
        "Awaiting approval",
        (workspace.records || []).filter(
          (row) => row.action_status === "WAITING_APPROVAL",
        ).length,
      ],
      ["Exceptions", summary.exceptions || 0],
    ]
      .map(
        ([label, value]) =>
          `<span class="supplier-kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong></span>`,
      )
      .join("");
  }
  function renderSuppliers(workspace) {
    const suppliers = [
      {
        supplier_code: null,
        supplier_name: "All suppliers",
        message_count: workspace.summary?.messages || 0,
      },
      ...(workspace.suppliers || []),
    ];
    $("supplierCount").textContent = suppliers.length;
    $("supplierList").innerHTML =
      suppliers
        .map((supplier) => {
          const active =
            (state.supplier || null) === (supplier.supplier_code || null);
          return `<button class="mailbox-list-item supplier-list-item${active ? " active" : ""}" type="button" data-supplier="${esc(supplier.supplier_code || "")}"><span class="list-avatar">${esc((supplier.supplier_name || "All").slice(0, 1).toUpperCase())}</span><span class="list-copy"><strong>${esc(supplier.supplier_name)}</strong><small>${esc(supplier.message_count || 0)} messages</small></span></button>`;
        })
        .join("") ||
      `<p class="empty-state">No supplier emails captured yet.</p>`;
    document.querySelectorAll("[data-supplier]").forEach((button) =>
      button.addEventListener("click", () => {
        state.supplier = button.dataset.supplier || null;
        state.message = null;
        loadWorkspace();
      }),
    );
  }
  function renderMessages(workspace) {
    const messages = workspace.messages || [];
    $("messageCount").textContent = messages.length;
    $("messageList").innerHTML =
      messages
        .map((message) => {
          const active = message.mailbox_message_id === state.message;
          const status =
            message.processing_state === "NOT_PROCESSED"
              ? "Captured"
              : String(message.processing_state || "").replaceAll("_", " ");
          return `<button class="mailbox-list-item message-list-item${active ? " active" : ""}" type="button" data-message="${esc(message.mailbox_message_id)}"><span class="message-date">${esc(shortDate(message.received_at))}</span><span class="list-copy"><strong>${esc(message.subject || "(no subject)")}</strong><small>${esc(message.supplier_name || message.sender_address || "Supplier")} · ${esc(status)}</small></span><span class="message-dot ${message.is_read ? "read" : "unread"}" title="${message.is_read ? "Read" : "Unread"}"></span></button>`;
        })
        .join("") ||
      `<p class="empty-state">No messages match this supplier.</p>`;
    document.querySelectorAll("[data-message]").forEach((button) =>
      button.addEventListener("click", () => {
        state.message = button.dataset.message;
        loadWorkspace();
      }),
    );
  }
  function actionButtons(row) {
    if (row.action_status !== "WAITING_APPROVAL")
      return esc(row.action_status || row.parse_state || "—");
    return `<span class="record-actions"><button class="mini-button approve" type="button" data-action="${esc(row.action_id)}" data-decision="approve">Approve</button><button class="mini-button reject" type="button" data-action="${esc(row.action_id)}" data-decision="reject">Reject</button></span>`;
  }
  function filteredRecords(workspace) {
    const query = state.recordSearch.trim().toLocaleLowerCase();
    const records = (workspace.records || []).filter((row) => {
      if (query && !recordSearchText(row).includes(query)) return false;
      if (
        state.filters.patient_id &&
        !textValue(row.patient_id)
          .toLocaleLowerCase()
          .includes(state.filters.patient_id.toLocaleLowerCase())
      )
        return false;
      if (
        state.filters.customer_name &&
        !textValue(row.customer_name)
          .toLocaleLowerCase()
          .includes(state.filters.customer_name.toLocaleLowerCase())
      )
        return false;
      if (
        state.filters.customer_account &&
        !textValue(row.customer_account)
          .toLocaleLowerCase()
          .includes(state.filters.customer_account.toLocaleLowerCase())
      )
        return false;
      return (
        !state.filters.supplier_status ||
        textValue(row.supplier_status) === state.filters.supplier_status
      );
    });
    if (!state.sort.key) return records;
    return [...records].sort((left, right) => {
      const comparison = recordCollator.compare(
        textValue(left[state.sort.key]),
        textValue(right[state.sort.key]),
      );
      return state.sort.direction === "desc" ? -comparison : comparison;
    });
  }
  function syncRecordControls(allRecords) {
    const statusSelect = $("filterSupplierStatusInput");
    const statuses = [
      ...new Set(
        allRecords.map((row) => textValue(row.supplier_status)).filter(Boolean),
      ),
    ].sort(recordCollator.compare);
    statusSelect.innerHTML = `<option value="">All updates</option>${statuses.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join("")}`;
    statusSelect.value = state.filters.supplier_status;
    const inputs = {
      patient_id: "filterPatientIdInput",
      customer_name: "filterCustomerNameInput",
      customer_account: "filterCustomerAccountInput",
    };
    Object.entries(inputs).forEach(([key, id]) => {
      const input = $(id);
      if (document.activeElement !== input) input.value = state.filters[key];
    });
    document.querySelectorAll("[data-sort]").forEach((button) => {
      const active = button.dataset.sort === state.sort.key;
      button.classList.toggle("active", active);
      button.querySelector("span").textContent = active
        ? state.sort.direction === "desc"
          ? "▼"
          : "▲"
        : "↕";
      const label = button.textContent.replace(/[↕▲▼]/g, "").trim();
      button.setAttribute(
        "aria-label",
        `${active && state.sort.direction === "asc" ? "Sort descending by" : "Sort ascending by"} ${label}`,
      );
    });
    document
      .querySelectorAll("[data-filter-toggle]")
      .forEach((button) =>
        button.classList.toggle(
          "active",
          Boolean(state.filters[button.dataset.filterToggle]),
        ),
      );
  }
  function renderRecords(workspace) {
    const allRecords = workspace.records || [];
    const records = filteredRecords(workspace);
    $("recordCount").textContent =
      records.length === allRecords.length
        ? records.length
        : `${records.length}/${allRecords.length}`;
    $("recordsHeading").textContent = state.message
      ? "Records for selected email"
      : state.supplier
        ? "Active supplier records"
        : "Active records";
    syncRecordControls(allRecords);
    $("recordsBody").innerHTML =
      records
        .map(
          (row) =>
            `<tr class="${ageBand(row.received_at)}${shippedRowClass(row)}" title="${esc(ageLabel(row.received_at))}"><td><strong>${esc(row.supplier_reference)}</strong>${row.tray_number ? `<small>Tray ${esc(row.tray_number)}</small>` : ""}</td><td>${esc(sourceLabel(row))}</td><td>${esc(row.patient_id || "—")}</td><td>${esc(row.customer_name || "—")}</td><td>${esc(row.customer_account || "—")}</td><td>${esc(dateLabel(row.received_at))}</td><td>${esc(row.supplier_status || "—")}</td><td class="live-order-divider">${esc(row.internal_order_id || "Not found")}</td><td>${esc(row.current_status_description || row.current_status_id || "—")}</td><td>${esc(row.target_status_description || row.target_status_item_id || "Mapping pending")}</td><td>${actionButtons(row)}</td></tr>`,
        )
        .join("") ||
      `<tr><td colspan="11"><p class="empty-state">No parsed records are available for this selection.</p></td></tr>`;
    document.querySelectorAll("[data-action]").forEach((button) =>
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await json(
            `/api/operations/actions/${encodeURIComponent(button.dataset.action)}/${button.dataset.decision}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                note: "Reviewed in OS Lab Status Update Inbox",
              }),
            },
          );
          await loadWorkspace();
          await loadSupportPanels();
        } catch (error) {
          alert(error.message);
          button.disabled = false;
        }
      }),
    );
  }
  async function loadWorkspace() {
    try {
      const params = new URLSearchParams();
      if (state.supplier) params.set("supplier", state.supplier);
      if (state.message) params.set("message", state.message);
      const workspace = await json(
        `/api/operations/mailbox/workspace?${params}`,
      );
      state.workspace = workspace;
      sizeMailboxColumns(workspace);
      $("archiveMessage").disabled = !state.message;
      $("mailboxStatus").textContent =
        `${workspace.summary?.messages || 0} captured messages · ${workspace.summary?.records || 0} active parsed records`;
      renderKpis(workspace);
      renderSuppliers(workspace);
      renderMessages(workspace);
      renderRecords(workspace);
    } catch (error) {
      $("mailboxStatus").textContent = error.message;
      $("supplierList").innerHTML =
        `<p class="empty-state">${esc(error.message)}</p>`;
      $("messageList").replaceChildren();
      $("recordsBody").innerHTML =
        `<tr><td colspan="11">${esc(error.message)}</td></tr>`;
    }
  }
  async function renderMappings() {
    const data = await json("/api/operations/status-mappings");
    state.mappings = data;
    $("statusMappings").innerHTML =
      (data.mappings || [])
        .map(
          (mapping) =>
            `<div class="mapping-row"><div><strong>${esc(mapping.supplier_code)} · ${esc(mapping.supplier_status_label)}</strong><small>${esc(mapping.rule_code)} · ${esc(mapping.mapping_state)}</small></div><select data-mapping-select="${esc(mapping.mapping_id)}"><option value="">Select CurrentStatusID</option>${(
              data.statusItems || []
            )
              .filter((item) => !item.inactive)
              .map(
                (item) =>
                  `<option value="${esc(item.status_item_id)}"${Number(item.status_item_id) === Number(mapping.target_status_item_id) ? " selected" : ""}>${esc(item.status_item_id)} · ${esc(item.status_item_name)}</option>`,
              )
              .join(
                "",
              )}</select><button class="mini-button approve" type="button" data-confirm-mapping="${esc(mapping.mapping_id)}">Confirm</button></div>`,
        )
        .join("") ||
      `<p class="empty-state">No supplier statuses have been parsed yet.</p>`;
    document.querySelectorAll("[data-confirm-mapping]").forEach((button) =>
      button.addEventListener("click", async () => {
        const select = document.querySelector(
          `[data-mapping-select="${CSS.escape(button.dataset.confirmMapping)}"]`,
        );
        if (!select.value) return;
        button.disabled = true;
        try {
          await json("/api/operations/status-mappings/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mappingId: button.dataset.confirmMapping,
              targetStatusItemId: select.value,
            }),
          });
          await renderMappings();
        } catch (error) {
          alert(error.message);
          button.disabled = false;
        }
      }),
    );
  }
  async function loadSupportPanels() {
    const [events, actions, rules, exceptions, capability] = await Promise.all([
      json("/api/operations/events?limit=50"),
      json("/api/operations/actions?limit=50"),
      json("/api/operations/supplier-rules"),
      json("/api/operations/exceptions?limit=50"),
      json("/api/operations/source-write-capability"),
    ]);
    $("events").textContent = JSON.stringify(events.events || [], null, 2);
    $("actions").innerHTML =
      (actions.actions || [])
        .map(
          (action) =>
            `<div class="action-card"><strong>${esc(action.action_type)}</strong><span>Order: ${esc(action.target_reference)} · ${esc(action.status)}</span></div>`,
        )
        .join("") || `<p class="empty-state">No actions awaiting approval.</p>`;
    $("rules").innerHTML =
      (rules.rules || [])
        .map(
          (rule) =>
            `<div class="rule-card"><strong>${esc(rule.supplier_name)} · ${esc(rule.rule_code)}</strong><span>${esc(rule.subject_pattern)} · ${esc(rule.mapping_state)} · ${rule.is_enabled ? "Enabled" : "Disabled"}</span></div>`,
        )
        .join("") || `<p class="empty-state">No supplier rules configured.</p>`;
    $("exceptions").innerHTML =
      (exceptions.exceptions || [])
        .map(
          (item) =>
            `<div class="exception-card"><strong>${esc(item.exception_type)}</strong><span>${esc(item.message)}</span></div>`,
        )
        .join("") || `<p class="empty-state">No open exceptions.</p>`;
    $("writeCapability").textContent = capability.writable
      ? "Writer ready · approval gated"
      : capability.detail || "Write-back gated";
    await renderMappings();
  }
  function closeFilterMenus(except = null) {
    document.querySelectorAll("[data-filter-menu]").forEach((menu) => {
      const keepOpen = menu.dataset.filterMenu === except;
      menu.hidden = !keepOpen;
      const toggle = document.querySelector(
        `[data-filter-toggle="${menu.dataset.filterMenu}"]`,
      );
      if (toggle) toggle.setAttribute("aria-expanded", String(keepOpen));
    });
  }
  function showPanel(panelId) {
    document
      .querySelectorAll("[data-content-panel]")
      .forEach((panel) =>
        panel.classList.toggle("active", panel.id === panelId),
      );
    history.replaceState(
      null,
      "",
      panelId === "mailbox" ? location.pathname : `#${panelId}`,
    );
  }
  $("settingsMenuButton").addEventListener("click", () => {
    const menu = $("settingsMenu");
    const isOpen = !menu.hidden;
    menu.hidden = isOpen;
    $("settingsMenuButton").setAttribute("aria-expanded", String(!isOpen));
  });
  document.querySelectorAll("[data-panel]").forEach((button) =>
    button.addEventListener("click", () => {
      $("settingsMenu").hidden = true;
      $("settingsMenuButton").setAttribute("aria-expanded", "false");
      showPanel(button.dataset.panel);
    }),
  );
  document.querySelectorAll("[data-sort]").forEach((button) =>
    button.addEventListener("click", () => {
      const key = button.dataset.sort;
      state.sort =
        state.sort.key === key && state.sort.direction === "asc"
          ? { key, direction: "desc" }
          : { key, direction: "asc" };
      if (state.workspace) renderRecords(state.workspace);
    }),
  );
  document.querySelectorAll("[data-filter-toggle]").forEach((button) =>
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const key = button.dataset.filterToggle;
      const isOpen = !document.querySelector(`[data-filter-menu="${key}"]`)
        .hidden;
      closeFilterMenus(isOpen ? null : key);
    }),
  );
  [
    ["filterPatientIdInput", "patient_id"],
    ["filterCustomerNameInput", "customer_name"],
    ["filterCustomerAccountInput", "customer_account"],
  ].forEach(([id, key]) =>
    $(id).addEventListener("input", (event) => {
      state.filters[key] = event.target.value;
      if (state.workspace) renderRecords(state.workspace);
    }),
  );
  $("filterSupplierStatusInput").addEventListener("change", (event) => {
    state.filters.supplier_status = event.target.value;
    if (state.workspace) renderRecords(state.workspace);
  });
  document.querySelectorAll("[data-clear-filter]").forEach((button) =>
    button.addEventListener("click", () => {
      state.filters[button.dataset.clearFilter] = "";
      if (state.workspace) renderRecords(state.workspace);
    }),
  );
  $("recordSearch").addEventListener("input", (event) => {
    state.recordSearch = event.target.value;
    if (state.workspace) renderRecords(state.workspace);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".filterable-column")) closeFilterMenus();
    if (!event.target.closest(".mailbox-settings")) {
      $("settingsMenu").hidden = true;
      $("settingsMenuButton").setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeFilterMenus();
      $("settingsMenu").hidden = true;
      $("settingsMenuButton").setAttribute("aria-expanded", "false");
    }
  });
  $("syncMailbox").addEventListener("click", async () => {
    const button = $("syncMailbox");
    button.disabled = true;
    $("mailboxStatus").textContent = "Scanning the actual Inbox…";
    try {
      await json("/api/operations/mailbox/sync", { method: "POST" });
      await loadWorkspace();
      await loadSupportPanels();
    } catch (error) {
      $("mailboxStatus").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $("refreshWorkspace").addEventListener("click", () =>
    Promise.all([loadWorkspace(), loadSupportPanels()]),
  );
  $("archiveMessage").addEventListener("click", async () => {
    if (!state.message) return;
    const button = $("archiveMessage");
    button.disabled = true;
    try {
      await json(
        `/api/operations/mailbox/messages/${encodeURIComponent(state.message)}/archive`,
        { method: "POST" },
      );
      state.message = null;
      await loadWorkspace();
    } catch (error) {
      alert(error.message);
      button.disabled = false;
    }
  });
  $("fixtureForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("fixtureStatus").textContent = "Processing…";
    const form = new FormData(event.currentTarget);
    try {
      const result = await json(
        "/api/operations/events/simulate-supplier-file",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filename: form.get("filename"),
            content: form.get("content"),
            contentType: "text/csv",
          }),
        },
      );
      $("fixtureStatus").textContent = result.duplicate
        ? "Duplicate fixture returned."
        : "Fixture ingested and recorded.";
      await loadWorkspace();
      await loadSupportPanels();
    } catch (error) {
      $("fixtureStatus").textContent = error.message;
    }
  });
  Promise.all([loadWorkspace(), loadSupportPanels()]).catch((error) => {
    $("mailboxStatus").textContent = error.message;
  });
})();
