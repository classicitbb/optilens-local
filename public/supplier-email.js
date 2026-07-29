(() => {
  const $ = (id) => document.getElementById(id);
  const state = { supplier: null, message: null, workspace: null, mappings: null };
  const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const dateLabel = (value) => value ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(value)) : "Unknown date";
  const shortDate = (value) => value ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value)) : "";
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
  const ageLabel = (value) => value ? `${Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86400000))} days old` : "Received date unavailable";

  async function json(url, options = {}) {
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", ...options });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }

  function sizeMailboxColumns(workspace) {
    const container = document.querySelector(".mailbox-workspace");
    if (!container) return;
    const supplierNames = [{ supplier_name: "All suppliers" }, ...(workspace.suppliers || [])].map((item) => String(item.supplier_name || ""));
    const subjects = (workspace.messages || []).map((item) => String(item.subject || ""));
    const longestSupplier = Math.max(12, ...supplierNames.map((value) => value.length));
    const longestSubject = Math.max(24, ...subjects.map((value) => value.length));
    const supplierWidth = Math.min(260, Math.max(150, Math.round(longestSupplier * 6.5 + 55)));
    const messageWidth = Math.min(480, Math.max(280, Math.round(longestSubject * 5.4 + 95)));
    container.style.setProperty("--supplier-pane-width", `${supplierWidth}px`);
    container.style.setProperty("--message-pane-width", `${messageWidth}px`);
  }

  function renderKpis(workspace) {
    const summary = workspace.summary || {};
    $("mailboxKpis").innerHTML = [
      ["Messages", summary.messages || 0],
      ["Parsed records", summary.records || 0],
      ["Awaiting approval", (workspace.records || []).filter((row) => row.action_status === "WAITING_APPROVAL").length],
      ["Exceptions", summary.exceptions || 0]
    ].map(([label, value]) => `<div class="supplier-kpi"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join("");
  }

  function renderSuppliers(workspace) {
    const suppliers = [{ supplier_code: null, supplier_name: "All suppliers", message_count: workspace.summary?.messages || 0 }, ...(workspace.suppliers || [])];
    $("supplierCount").textContent = suppliers.length;
    $("supplierList").innerHTML = suppliers.map((supplier) => {
      const active = (state.supplier || null) === (supplier.supplier_code || null);
      return `<button class="mailbox-list-item supplier-list-item${active ? " active" : ""}" type="button" data-supplier="${esc(supplier.supplier_code || "")}"><span class="list-avatar">${esc((supplier.supplier_name || "All").slice(0, 1).toUpperCase())}</span><span class="list-copy"><strong>${esc(supplier.supplier_name)}</strong><small>${esc(supplier.message_count || 0)} messages</small></span></button>`;
    }).join("") || `<p class="empty-state">No supplier emails captured yet.</p>`;
    document.querySelectorAll("[data-supplier]").forEach((button) => button.addEventListener("click", () => { state.supplier = button.dataset.supplier || null; state.message = null; loadWorkspace(); }));
  }

  function renderMessages(workspace) {
    const messages = workspace.messages || [];
    $("messageCount").textContent = messages.length;
    $("messageList").innerHTML = messages.map((message) => {
      const active = message.mailbox_message_id === state.message;
      const status = message.processing_state === "NOT_PROCESSED" ? "Captured" : String(message.processing_state || "").replaceAll("_", " ");
      return `<button class="mailbox-list-item message-list-item${active ? " active" : ""}" type="button" data-message="${esc(message.mailbox_message_id)}"><span class="message-date">${esc(shortDate(message.received_at))}</span><span class="list-copy"><strong>${esc(message.subject || "(no subject)")}</strong><small>${esc(message.supplier_name || message.sender_address || "Supplier")} · ${esc(status)}</small></span><span class="message-dot ${message.is_read ? "read" : "unread"}" title="${message.is_read ? "Read" : "Unread"}"></span></button>`;
    }).join("") || `<p class="empty-state">No messages match this supplier.</p>`;
    document.querySelectorAll("[data-message]").forEach((button) => button.addEventListener("click", () => { state.message = button.dataset.message; loadWorkspace(); }));
  }

  function actionButtons(row) {
    if (row.action_status !== "WAITING_APPROVAL") return esc(row.action_status || row.parse_state || "—");
    return `<span class="record-actions"><button class="mini-button approve" type="button" data-action="${esc(row.action_id)}" data-decision="approve">Approve</button><button class="mini-button reject" type="button" data-action="${esc(row.action_id)}" data-decision="reject">Reject</button></span>`;
  }

  function renderRecords(workspace) {
    const records = workspace.records || [];
    $("recordCount").textContent = records.length;
    $("recordsHeading").textContent = state.message ? "Records for selected email" : state.supplier ? "Active supplier records" : "Active records";
    $("recordsBody").innerHTML = records.map((row) => `<tr class="${ageBand(row.received_at)}" title="${esc(ageLabel(row.received_at))}"><td><strong>${esc(row.supplier_reference)}</strong><small>${esc(row.record_kind || row.rule_code || "")}</small></td><td>${esc(row.patient_id || "—")}</td><td>${esc(row.customer_id || "—")}</td><td>${esc(row.customer_name || "—")}</td><td>${esc(row.customer_account || "—")}</td><td>${esc(dateLabel(row.received_at))}</td><td>${esc(row.supplier_status || "—")}</td><td>${esc(row.internal_order_id || "Not found")}</td><td>${esc(row.current_status_description || row.current_status_id || "—")}</td><td>${esc(row.target_status_description || row.target_status_item_id || "Mapping pending")}</td><td>${actionButtons(row)}</td></tr>`).join("") || `<tr><td colspan="11"><p class="empty-state">No parsed and matched records are available for this selection.</p></td></tr>`;
    document.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", async () => {
      button.disabled = true;
      try { await json(`/api/operations/actions/${encodeURIComponent(button.dataset.action)}/${button.dataset.decision}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ note: "Reviewed in Supplier Email workspace" }) }); await loadWorkspace(); await loadSupportPanels(); } catch (error) { alert(error.message); button.disabled = false; }
    }));
  }

  async function loadWorkspace() {
    try {
      const params = new URLSearchParams();
      if (state.supplier) params.set("supplier", state.supplier);
      if (state.message) params.set("message", state.message);
      const workspace = await json(`/api/operations/mailbox/workspace?${params}`);
      state.workspace = workspace;
      sizeMailboxColumns(workspace);
      $("archiveMessage").disabled = !state.message;
      $("mailboxStatus").textContent = `${workspace.summary?.messages || 0} captured messages · ${workspace.summary?.records || 0} active parsed records`;
      renderKpis(workspace); renderSuppliers(workspace); renderMessages(workspace); renderRecords(workspace);
    } catch (error) { $("mailboxStatus").textContent = error.message; $("supplierList").innerHTML = `<p class="empty-state">${esc(error.message)}</p>`; $("messageList").replaceChildren(); $("recordsBody").innerHTML = `<tr><td colspan="11">${esc(error.message)}</td></tr>`; }
  }

  async function renderMappings() {
    const data = await json("/api/operations/status-mappings");
    state.mappings = data;
    $("statusMappings").innerHTML = (data.mappings || []).map((mapping) => `<div class="mapping-row"><div><strong>${esc(mapping.supplier_code)} · ${esc(mapping.supplier_status_label)}</strong><small>${esc(mapping.rule_code)} · ${esc(mapping.mapping_state)}</small></div><select data-mapping-select="${esc(mapping.mapping_id)}"><option value="">Select CurrentStatusID</option>${(data.statusItems || []).filter((item) => !item.inactive).map((item) => `<option value="${esc(item.status_item_id)}"${Number(item.status_item_id) === Number(mapping.target_status_item_id) ? " selected" : ""}>${esc(item.status_item_id)} · ${esc(item.status_item_name)}</option>`).join("")}</select><button class="mini-button approve" type="button" data-confirm-mapping="${esc(mapping.mapping_id)}">Confirm</button></div>`).join("") || `<p class="empty-state">No supplier statuses have been parsed yet.</p>`;
    document.querySelectorAll("[data-confirm-mapping]").forEach((button) => button.addEventListener("click", async () => { const select = document.querySelector(`[data-mapping-select="${CSS.escape(button.dataset.confirmMapping)}"]`); if (!select.value) return; button.disabled = true; try { await json("/api/operations/status-mappings/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mappingId: button.dataset.confirmMapping, targetStatusItemId: select.value }) }); await renderMappings(); } catch (error) { alert(error.message); button.disabled = false; } }));
  }

  async function loadSupportPanels() {
    const [events, actions, rules, exceptions, capability] = await Promise.all([json("/api/operations/events?limit=50"), json("/api/operations/actions?limit=50"), json("/api/operations/supplier-rules"), json("/api/operations/exceptions?limit=50"), json("/api/operations/source-write-capability")]);
    $("events").textContent = JSON.stringify(events.events || [], null, 2);
    $("actions").innerHTML = (actions.actions || []).map((action) => `<div class="action-card"><strong>${esc(action.action_type)}</strong><span>Order: ${esc(action.target_reference)} · ${esc(action.status)}</span></div>`).join("") || `<p class="empty-state">No actions awaiting approval.</p>`;
    $("rules").innerHTML = (rules.rules || []).map((rule) => `<div class="rule-card"><strong>${esc(rule.supplier_name)} · ${esc(rule.rule_code)}</strong><span>${esc(rule.subject_pattern)} · ${esc(rule.mapping_state)} · ${rule.is_enabled ? "Enabled" : "Disabled"}</span></div>`).join("") || `<p class="empty-state">No supplier rules configured.</p>`;
    $("exceptions").innerHTML = (exceptions.exceptions || []).map((item) => `<div class="exception-card"><strong>${esc(item.exception_type)}</strong><span>${esc(item.message)}</span></div>`).join("") || `<p class="empty-state">No open exceptions.</p>`;
    $("writeCapability").textContent = capability.writable ? "Writer ready · approval gated" : capability.detail || "Write-back gated";
    await renderMappings();
  }

  document.querySelectorAll(".automation-subnav a[data-panel]").forEach((tab) => tab.addEventListener("click", (event) => { event.preventDefault(); document.querySelectorAll(".automation-subnav a").forEach((item) => item.classList.toggle("active", item === tab)); document.querySelectorAll("[data-content-panel]").forEach((panel) => panel.classList.toggle("active", panel.id === tab.dataset.panel)); history.replaceState(null, "", `#${tab.dataset.panel}`); }));
  $("syncMailbox").addEventListener("click", async () => { const button = $("syncMailbox"); button.disabled = true; $("mailboxStatus").textContent = "Scanning the actual Inbox…"; try { await json("/api/operations/mailbox/sync", { method: "POST" }); await loadWorkspace(); await loadSupportPanels(); } catch (error) { $("mailboxStatus").textContent = error.message; } finally { button.disabled = false; } });
  $("refreshWorkspace").addEventListener("click", () => Promise.all([loadWorkspace(), loadSupportPanels()]));
  $("archiveMessage").addEventListener("click", async () => {
    if (!state.message) return;
    const button = $("archiveMessage");
    button.disabled = true;
    try {
      await json(`/api/operations/mailbox/messages/${encodeURIComponent(state.message)}/archive`, { method: "POST" });
      state.message = null;
      await loadWorkspace();
    } catch (error) { alert(error.message); button.disabled = false; }
  });
  $("fixtureForm").addEventListener("submit", async (event) => { event.preventDefault(); $("fixtureStatus").textContent = "Processing…"; const form = new FormData(event.currentTarget); try { const result = await json("/api/operations/events/simulate-supplier-file", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: form.get("filename"), content: form.get("content"), contentType: "text/csv" }) }); $("fixtureStatus").textContent = result.duplicate ? "Duplicate fixture returned." : "Fixture ingested and recorded."; await loadWorkspace(); await loadSupportPanels(); } catch (error) { $("fixtureStatus").textContent = error.message; } });
  Promise.all([loadWorkspace(), loadSupportPanels()]).catch((error) => { $("mailboxStatus").textContent = error.message; });
})();
