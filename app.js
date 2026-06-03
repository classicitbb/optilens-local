const defaults = {
  orders: [
    { id: "OL-1048", patient: "Maya Chen", frame: "Ray-Ban RX7215", lens: "Progressive", status: "In lab", due: "2026-06-03" },
    { id: "OL-1049", patient: "Jordan Lee", frame: "Oakley OX8156", lens: "Single vision", status: "Ready", due: "2026-06-03" },
    { id: "OL-1050", patient: "Priya Singh", frame: "Kate Spade Ember", lens: "Computer", status: "Waiting", due: "2026-06-05" },
    { id: "OL-1051", patient: "Daniel Brooks", frame: "Silhouette TMA", lens: "Progressive", status: "In lab", due: "2026-06-06" }
  ],
  patients: [
    { name: "Maya Chen", phone: "(902) 555-0194", lastExam: "2026-05-18", insurance: "Blue Cross" },
    { name: "Jordan Lee", phone: "(902) 555-0142", lastExam: "2026-05-28", insurance: "Canada Life" },
    { name: "Priya Singh", phone: "(902) 555-0107", lastExam: "2026-04-21", insurance: "Manulife" },
    { name: "Daniel Brooks", phone: "(902) 555-0188", lastExam: "2026-03-30", insurance: "Sun Life" }
  ],
  inventory: [
    { sku: "FR-RB-7215-BLK", name: "Ray-Ban RX7215 Black", type: "Frames", qty: 3, reorder: 5 },
    { sku: "LN-PRO-167", name: "1.67 Progressive AR", type: "Lenses", qty: 12, reorder: 8 },
    { sku: "FR-OA-8156-GRY", name: "Oakley OX8156 Grey", type: "Frames", qty: 2, reorder: 4 },
    { sku: "CL-DAILY-SPH", name: "Daily Sphere Trial Set", type: "Contacts", qty: 18, reorder: 10 }
  ]
};

const storageKey = "optilens-app-state";
let state = loadState();
let activeFilter = "all";

const els = {
  search: document.querySelector("#globalSearch"),
  navItems: document.querySelectorAll(".nav-item"),
  viewLinks: document.querySelectorAll("[data-view-link]"),
  views: document.querySelectorAll(".view"),
  openOrdersCount: document.querySelector("#openOrdersCount"),
  readyOrdersCount: document.querySelector("#readyOrdersCount"),
  lowStockCount: document.querySelector("#lowStockCount"),
  dueTodayCount: document.querySelector("#dueTodayCount"),
  dashboardOrders: document.querySelector("#dashboardOrders"),
  ordersTable: document.querySelector("#ordersTable"),
  lowInventoryList: document.querySelector("#lowInventoryList"),
  patientsGrid: document.querySelector("#patientsGrid"),
  inventoryGrid: document.querySelector("#inventoryGrid"),
  orderDialog: document.querySelector("#orderDialog"),
  orderForm: document.querySelector("#orderForm"),
  newOrderBtn: document.querySelector("#newOrderBtn"),
  resetDataBtn: document.querySelector("#resetDataBtn"),
  segments: document.querySelectorAll(".segment")
};

function loadState() {
  const stored = localStorage.getItem(storageKey);
  if (!stored) return structuredClone(defaults);

  try {
    return JSON.parse(stored);
  } catch {
    return structuredClone(defaults);
  }
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function matchesSearch(item) {
  const term = els.search.value.trim().toLowerCase();
  if (!term) return true;
  return Object.values(item).some(value => String(value).toLowerCase().includes(term));
}

function statusClass(status) {
  if (status === "Ready") return "ready";
  if (status === "Waiting") return "waiting";
  return "";
}

function render() {
  const searchedOrders = state.orders.filter(matchesSearch);
  const lowStock = state.inventory.filter(item => item.qty <= item.reorder);

  els.openOrdersCount.textContent = state.orders.filter(order => order.status !== "Ready").length;
  els.readyOrdersCount.textContent = state.orders.filter(order => order.status === "Ready").length;
  els.lowStockCount.textContent = lowStock.length;
  els.dueTodayCount.textContent = state.orders.filter(order => order.due === todayIso()).length;

  els.dashboardOrders.innerHTML = searchedOrders.slice(0, 5).map(orderRow).join("");

  const filteredOrders = searchedOrders.filter(order => activeFilter === "all" || order.status === activeFilter);
  els.ordersTable.innerHTML = filteredOrders.map(orderRowDetailed).join("") || emptyRow("No orders match the current filters.", 6);

  els.lowInventoryList.innerHTML = lowStock.map(item => `
    <div class="list-item">
      <div>
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(item.sku)} · Reorder at ${item.reorder}</span>
      </div>
      <span class="stock low">${item.qty} left</span>
    </div>
  `).join("") || `<div class="list-item"><strong>Stock levels are healthy</strong><span>No reorder alerts</span></div>`;

  els.patientsGrid.innerHTML = state.patients.filter(matchesSearch).map(patient => `
    <article class="patient-card">
      <h2>${escapeHtml(patient.name)}</h2>
      <div class="card-meta">
        <span>${escapeHtml(patient.phone)}</span>
        <span>Last exam: ${escapeHtml(patient.lastExam)}</span>
        <span>Insurance: ${escapeHtml(patient.insurance)}</span>
      </div>
    </article>
  `).join("");

  els.inventoryGrid.innerHTML = state.inventory.filter(matchesSearch).map(item => `
    <article class="inventory-card">
      <h2>${escapeHtml(item.name)}</h2>
      <div class="card-meta">
        <span>${escapeHtml(item.type)} · ${escapeHtml(item.sku)}</span>
        <span class="stock ${item.qty <= item.reorder ? "low" : ""}">${item.qty} in stock</span>
      </div>
    </article>
  `).join("");
}

function orderRow(order) {
  return `
    <tr>
      <td>${escapeHtml(order.id)}</td>
      <td>${escapeHtml(order.patient)}</td>
      <td><span class="badge ${statusClass(order.status)}">${escapeHtml(order.status)}</span></td>
      <td>${escapeHtml(order.due)}</td>
    </tr>
  `;
}

function orderRowDetailed(order) {
  return `
    <tr>
      <td>${escapeHtml(order.id)}</td>
      <td>${escapeHtml(order.patient)}</td>
      <td>${escapeHtml(order.frame)}</td>
      <td>${escapeHtml(order.lens)}</td>
      <td><span class="badge ${statusClass(order.status)}">${escapeHtml(order.status)}</span></td>
      <td>${escapeHtml(order.due)}</td>
    </tr>
  `;
}

function emptyRow(message, colspan) {
  return `<tr><td colspan="${colspan}">${escapeHtml(message)}</td></tr>`;
}

function setView(viewId) {
  els.navItems.forEach(item => item.classList.toggle("active", item.dataset.view === viewId));
  els.views.forEach(view => view.classList.toggle("active", view.id === viewId));
}

function createOrder(formData) {
  const nextNumber = Math.max(...state.orders.map(order => Number(order.id.replace("OL-", "")))) + 1;
  const patient = formData.get("patient").trim();
  state.orders.unshift({
    id: `OL-${nextNumber}`,
    patient,
    frame: formData.get("frame").trim(),
    lens: formData.get("lens"),
    status: "Waiting",
    due: formData.get("due")
  });

  if (!state.patients.some(record => record.name.toLowerCase() === patient.toLowerCase())) {
    state.patients.unshift({
      name: patient,
      phone: "Not on file",
      lastExam: todayIso(),
      insurance: "Not on file"
    });
  }

  saveState();
  render();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

els.navItems.forEach(item => {
  item.addEventListener("click", () => setView(item.dataset.view));
});

els.viewLinks.forEach(link => {
  link.addEventListener("click", () => setView(link.dataset.viewLink));
});

els.segments.forEach(segment => {
  segment.addEventListener("click", () => {
    activeFilter = segment.dataset.filter;
    els.segments.forEach(item => item.classList.toggle("active", item === segment));
    render();
  });
});

els.search.addEventListener("input", render);

els.newOrderBtn.addEventListener("click", () => {
  els.orderForm.elements.due.value = todayIso();
  els.orderDialog.showModal();
});

els.orderForm.addEventListener("submit", event => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  createOrder(new FormData(els.orderForm));
  els.orderForm.reset();
  els.orderDialog.close();
  setView("orders");
});

els.resetDataBtn.addEventListener("click", () => {
  state = structuredClone(defaults);
  saveState();
  render();
});

render();
