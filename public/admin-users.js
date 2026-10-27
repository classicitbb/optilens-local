// Users and Access console. One list + detail layout per tab; every change saves
// through the existing /api/admin/users and /api/admin/roles endpoints.
const adminState = {
  roles: [],
  modules: [],
  users: [],
  tab: "users",
  selectedUser: null,   // userId, "new" or null
  selectedRole: null,   // role code, "new" or null
  query: "",
  roleFilter: "all",
  stateFilter: "all"
};

const $ = (selector, root = document) => root.querySelector(selector);

initUsers();

function initUsers() {
  document.querySelectorAll(".ua-tab").forEach((tab) => {
    tab.addEventListener("click", () => setTab(tab.dataset.tab));
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const tabs = [...document.querySelectorAll(".ua-tab")];
      const next = tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
      next.focus();
      setTab(next.dataset.tab);
    });
  });
  $("#userSearch").addEventListener("input", (event) => {
    adminState.query = event.target.value.trim().toLowerCase();
    renderUserRows();
  });
  $("#userRoleFilter").addEventListener("change", (event) => { adminState.roleFilter = event.target.value; renderUserRows(); });
  $("#userStateFilter").addEventListener("change", (event) => { adminState.stateFilter = event.target.value; renderUserRows(); });
  $("#newUserButton").addEventListener("click", () => { adminState.selectedUser = "new"; renderUsersTab(); $("#nuUsername")?.focus(); });
  $("#newRoleButton").addEventListener("click", () => { adminState.selectedRole = "new"; renderRolesTab(); $("#nrName")?.focus(); });
  loadUsers();
}

function setTab(tab) {
  adminState.tab = tab;
  document.querySelectorAll(".ua-tab").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.tab === tab)));
  document.querySelectorAll(".ua-panel").forEach((panel) => { panel.hidden = panel.id !== `panel-${tab}`; });
  renderAll();
}

async function loadUsers() {
  try {
    const data = await apiJson("/api/admin/users");
    adminState.roles = data.roles || [];
    adminState.modules = data.modules || [];
    adminState.users = data.users || [];
    renderAll();
  } catch (error) {
    setStatus(error.status === 401 ? "Sign in with an administrator account to manage users." : error.message, error.status !== 401);
    window.OptiLensAuth?.requireSignIn();
  }
}

function setStatus(text, isError = false) {
  const el = $("#uaStatus");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

function renderAll() {
  renderSummary();
  renderRoleFilter();
  if (adminState.tab === "users") renderUsersTab();
  if (adminState.tab === "roles") renderRolesTab();
  if (adminState.tab === "matrix") renderMatrix();
}

function renderSummary() {
  const active = adminState.users.filter((user) => user.isActive).length;
  $("#uaSummary").innerHTML = `
    <span class="ua-chip"><strong>${active}</strong> active users</span>
    <span class="ua-chip"><strong>${adminState.roles.length}</strong> roles</span>
    <span class="ua-chip"><strong>${adminState.modules.length}</strong> modules</span>`;
}

function renderRoleFilter() {
  const select = $("#userRoleFilter");
  const current = adminState.roleFilter;
  select.innerHTML = `<option value="all">All roles</option>`
    + adminState.roles.map((role) => `<option value="${escapeHtml(role.code)}">${escapeHtml(role.name)}</option>`).join("");
  select.value = adminState.roles.some((role) => role.code === current) ? current : "all";
  adminState.roleFilter = select.value;
}

/* ───────── Users ───────── */

function renderUsersTab() {
  renderUserRows();
  renderUserDetail();
}

function filteredUsers() {
  return adminState.users.filter((user) => {
    if (adminState.stateFilter === "active" && !user.isActive) return false;
    if (adminState.stateFilter === "disabled" && user.isActive) return false;
    if (adminState.roleFilter !== "all" && !(user.roles || []).includes(adminState.roleFilter)) return false;
    if (!adminState.query) return true;
    return [user.displayName, user.username, user.email].some((value) => String(value || "").toLowerCase().includes(adminState.query));
  });
}

function renderUserRows() {
  const users = filteredUsers();
  const body = $("#userRows");
  body.innerHTML = users.map((user) => `
    <tr data-id="${escapeHtml(user.userId)}" tabindex="0" aria-selected="${adminState.selectedUser === user.userId}">
      <td><div class="ua-name">${escapeHtml(user.displayName)}</div><div class="ua-sub">${escapeHtml(user.username)}${user.email ? ` · ${escapeHtml(user.email)}` : ""}</div></td>
      <td>${roleTags(user.roles)}</td>
      <td class="ua-sub">${escapeHtml(formatDate(user.lastLoginAt) || "Never")}</td>
      <td><span class="ua-state ${user.isActive ? "" : "off"}">${user.isActive ? "Active" : "Disabled"}</span></td>
    </tr>`).join("");
  const empty = $("#userEmpty");
  empty.hidden = users.length > 0;
  empty.textContent = adminState.users.length ? "No users match these filters." : "No users have been created yet.";
  body.querySelectorAll("tr[data-id]").forEach((row) => {
    const open = () => { adminState.selectedUser = row.dataset.id; renderUsersTab(); };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  });
}

function roleTags(roles) {
  if (!roles || !roles.length) return `<span class="ua-tag none">No roles</span>`;
  return `<div class="ua-tags">${roles.map((code) => `<span class="ua-tag ${code === "admin" ? "admin" : ""}">${escapeHtml(roleLabel(code))}</span>`).join("")}</div>`;
}

function renderUserDetail() {
  const target = $("#userDetail");
  if (adminState.selectedUser === "new") return renderNewUser(target);
  const user = adminState.users.find((item) => item.userId === adminState.selectedUser);
  if (!user) {
    target.innerHTML = `<div class="ua-detail-empty"><p>Select a user to edit their profile, roles and password, or create a new account.</p></div>`;
    return;
  }
  target.innerHTML = `
    <div class="ua-detail-head">
      <div><h2>${escapeHtml(user.displayName)}</h2><div class="ua-sub">${escapeHtml(user.username)}</div></div>
      <span class="ua-state ${user.isActive ? "" : "off"}">${user.isActive ? "Active" : "Disabled"}</span>
    </div>
    <form class="ua-detail-body" id="userEditForm" autocomplete="off">
      <div class="ua-fields">
        <label>Display name<input name="displayName" value="${escapeHtml(user.displayName)}" required></label>
        <label>Email<input name="email" type="email" value="${escapeHtml(user.email || "")}"></label>
      </div>
      <div>
        <h3 class="ua-section-title">Roles</h3>
        <div class="ua-checks">${roleCheckboxes(user.roles || [])}</div>
      </div>
      <div>
        <h3 class="ua-section-title">Effective access</h3>
        ${effectiveAccess(user)}
      </div>
      <div class="ua-actions">
        <button class="button primary" type="submit">Save changes</button>
        <span class="spacer"></span>
        <button class="ua-link-btn" type="button" id="toggleUser">${user.isActive ? "Disable account" : "Enable account"}</button>
      </div>
      <div>
        <h3 class="ua-section-title">Reset password</h3>
        <div class="ua-actions">
          <input type="password" id="resetPassword" autocomplete="new-password" placeholder="New temporary password" aria-label="New temporary password">
          <button class="button secondary" type="button" id="resetButton">Reset</button>
        </div>
        <p class="ua-sub">The user must choose a new password at next sign-in.</p>
      </div>
    </form>`;

  $("#userEditForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    saveUser(user.userId, {
      displayName: form.elements.displayName.value.trim(),
      email: form.elements.email.value.trim(),
      roles: checkedValues(form, "roles")
    }, "User saved.");
  });
  $("#toggleUser").addEventListener("click", () => {
    if (user.isActive && !confirm(`Disable ${user.displayName}? They will be signed out and unable to sign in.`)) return;
    saveUser(user.userId, { isActive: !user.isActive }, user.isActive ? "Account disabled." : "Account enabled.");
  });
  $("#resetButton").addEventListener("click", () => {
    const password = $("#resetPassword").value;
    if (!password) { setStatus("Enter a temporary password first.", true); return; }
    saveUser(user.userId, { password }, `Password reset for ${user.username}.`);
  });
}

function renderNewUser(target) {
  target.innerHTML = `
    <div class="ua-detail-head"><h2>New user</h2>
      <button class="ua-link-btn" type="button" id="cancelNew">Cancel</button></div>
    <form class="ua-detail-body" id="userCreateForm" autocomplete="off">
      <div class="ua-fields">
        <label>Username<input id="nuUsername" name="username" autocomplete="off" required></label>
        <label>Display name<input name="displayName" autocomplete="name" required></label>
        <label>Email<input name="email" type="email" autocomplete="email"></label>
        <label>Temporary password<input name="password" type="password" autocomplete="new-password" required></label>
      </div>
      <div>
        <h3 class="ua-section-title">Roles</h3>
        <div class="ua-checks">${roleCheckboxes(["viewer"])}</div>
      </div>
      <div class="ua-actions"><button class="button primary" type="submit">Create user</button></div>
    </form>`;
  $("#cancelNew").addEventListener("click", () => { adminState.selectedUser = null; renderUsersTab(); });
  $("#userCreateForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      await apiJson("/api/admin/users", {
        method: "POST",
        body: {
          username: form.elements.username.value.trim(),
          displayName: form.elements.displayName.value.trim(),
          email: form.elements.email.value.trim(),
          password: form.elements.password.value,
          roles: checkedValues(form, "roles")
        }
      });
      adminState.selectedUser = null;
      setStatus("User created.");
      await loadUsers();
    } catch (error) {
      setStatus(error.message, true);
    }
  });
}

function roleCheckboxes(assigned) {
  const set = new Set(assigned);
  return adminState.roles.map((role) => `
    <label class="ua-check">
      <input type="checkbox" name="roles" value="${escapeHtml(role.code)}" ${set.has(role.code) ? "checked" : ""}>
      <span>${escapeHtml(role.name)}<small>${escapeHtml(roleBlurb(role))}</small></span>
    </label>`).join("");
}

function roleBlurb(role) {
  if (role.code === "admin") return "Full access to everything";
  const count = Object.keys(role.moduleAccess || {}).length;
  return count ? `${count} module${count === 1 ? "" : "s"}` : "No modules yet";
}

function effectiveAccess(user) {
  if ((user.roles || []).includes("admin")) return `<p class="ua-sub">Administrator: full access to every module, plus user, credential and platform settings.</p>`;
  const entries = adminState.modules.filter((module) => user.moduleAccess?.[module.code]);
  if (!entries.length) return `<p class="ua-sub">No modules. Assign a role that grants module access.</p>`;
  return `<ul class="ua-access">${entries.map((module) => {
    const level = user.moduleAccess[module.code];
    return `<li><span>${escapeHtml(module.name)}</span><span class="ua-level ${level}">${levelLabel(module, level)}</span></li>`;
  }).join("")}</ul>`;
}

async function saveUser(userId, body, message) {
  try {
    await apiJson(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "PATCH", body });
    setStatus(message);
    await loadUsers();
  } catch (error) {
    setStatus(error.message, true);
  }
}

/* ───────── Roles ───────── */

function renderRolesTab() {
  const list = $("#roleRows");
  list.innerHTML = adminState.roles.map((role) => {
    const members = adminState.users.filter((user) => (user.roles || []).includes(role.code)).length;
    return `
      <li data-code="${escapeHtml(role.code)}" tabindex="0" aria-selected="${adminState.selectedRole === role.code}">
        <div><div class="ua-name">${escapeHtml(role.name)}</div>
          <div class="ua-sub">${escapeHtml(role.code)} · ${role.isSystem ? "Built-in" : "Custom"} · ${escapeHtml(roleBlurb(role))}</div></div>
        <span class="ua-chip"><strong>${members}</strong> ${members === 1 ? "user" : "users"}</span>
      </li>`;
  }).join("");
  list.querySelectorAll("li[data-code]").forEach((item) => {
    const open = () => { adminState.selectedRole = item.dataset.code; renderRolesTab(); };
    item.addEventListener("click", open);
    item.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  });
  renderRoleDetail();
}

function renderRoleDetail() {
  const target = $("#roleDetail");
  const isNew = adminState.selectedRole === "new";
  const role = isNew ? { code: "", name: "", moduleAccess: {}, isSystem: false } : adminState.roles.find((item) => item.code === adminState.selectedRole);
  if (!role) {
    target.innerHTML = `<div class="ua-detail-empty"><p>Select a role to choose which modules it can open, or create a new role.</p></div>`;
    return;
  }
  const isAdmin = role.code === "admin";
  const members = adminState.users.filter((user) => (user.roles || []).includes(role.code));
  target.innerHTML = `
    <div class="ua-detail-head">
      <div><h2>${isNew ? "New role" : escapeHtml(role.name)}</h2>${isNew ? "" : `<div class="ua-sub">${escapeHtml(role.code)} · ${role.isSystem ? "Built-in" : "Custom"}</div>`}</div>
      ${isNew ? `<button class="ua-link-btn" type="button" id="cancelRole">Cancel</button>` : ""}
    </div>
    <form class="ua-detail-body" id="roleForm" autocomplete="off">
      ${isAdmin ? `<p class="ua-sub">Administrator always grants full platform access and cannot be limited.</p>` : `
      <div class="ua-fields">
        <label>Role name<input name="name" id="nrName" value="${escapeHtml(role.name)}" required></label>
        ${isNew ? `<label>Role code<input name="code" placeholder="auto from name, e.g. shipping"></label>` : ""}
      </div>
      <div>
        <div class="ua-actions"><h3 class="ua-section-title">Module access</h3><span class="spacer"></span>
          <button type="button" class="ua-link-btn" data-bulk="">Clear all</button>
          <button type="button" class="ua-link-btn" data-bulk="read">All read</button></div>
        <div class="ua-modules">${moduleControls(role.moduleAccess || {})}</div>
        <p class="ua-sub">Read lets people open and view a module. Full also lets them make changes in it.</p>
      </div>
      <div class="ua-actions">
        <button class="button primary" type="submit">${isNew ? "Create role" : "Save role"}</button>
        <span class="spacer"></span>
        ${!isNew && !role.isSystem ? `<button class="ua-link-btn danger" type="button" id="deleteRole">Delete role</button>` : ""}
      </div>`}
      ${!isNew ? `<div><h3 class="ua-section-title">Members (${members.length})</h3>
        ${members.length ? `<div class="ua-tags">${members.map((user) => `<span class="ua-tag">${escapeHtml(user.displayName)}</span>`).join("")}</div>` : `<p class="ua-sub">Nobody has this role yet.</p>`}</div>` : ""}
    </form>`;

  $("#cancelRole")?.addEventListener("click", () => { adminState.selectedRole = null; renderRolesTab(); });
  target.querySelectorAll("[data-bulk]").forEach((button) => button.addEventListener("click", () => {
    target.querySelectorAll(".ua-seg").forEach((group) => {
      const value = button.dataset.bulk;
      const radio = group.querySelector(`input[value="${value}"]`) || group.querySelector('input[value=""]');
      if (radio) radio.checked = true;
    });
  }));
  $("#deleteRole")?.addEventListener("click", async () => {
    if (members.length && !confirm(`${members.length} user(s) have this role and will lose its access. Delete ${role.name}?`)) return;
    if (!members.length && !confirm(`Delete role ${role.name}?`)) return;
    try {
      await apiJson(`/api/admin/roles/${encodeURIComponent(role.code)}`, { method: "DELETE" });
      adminState.selectedRole = null;
      setStatus("Role deleted.");
      await loadUsers();
    } catch (error) {
      setStatus(error.message, true);
    }
  });
  $("#roleForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isAdmin) return;
    const form = event.currentTarget;
    const moduleAccess = collectModuleAccess(form);
    try {
      if (isNew) {
        const created = await apiJson("/api/admin/roles", {
          method: "POST",
          body: { name: form.elements.name.value.trim(), code: form.elements.code.value.trim(), moduleAccess }
        });
        adminState.selectedRole = created?.role?.code || null;
        setStatus("Role created.");
      } else {
        await apiJson(`/api/admin/roles/${encodeURIComponent(role.code)}`, {
          method: "PATCH",
          body: { name: form.elements.name.value.trim(), moduleAccess }
        });
        setStatus("Role saved.");
      }
      await loadUsers();
    } catch (error) {
      setStatus(error.message, true);
    }
  });
}

function moduleControls(access) {
  return adminState.modules.map((module) => {
    const level = access[module.code] || "";
    const name = `mod-${module.code}`;
    const options = [["", "Off"], ["read", module.hasFullLevel ? "Read" : "Allowed"]];
    if (module.hasFullLevel) options.push(["full", "Full"]);
    return `
      <div class="ua-module-row">
        <span class="ua-module-name">${escapeHtml(module.name)}</span>
        <div class="ua-seg" role="radiogroup" aria-label="${escapeHtml(module.name)} access" data-module="${escapeHtml(module.code)}">
          ${options.map(([value, label]) => `<label><input type="radio" name="${escapeHtml(name)}" value="${value}" ${level === value ? "checked" : ""}><span>${label}</span></label>`).join("")}
        </div>
      </div>`;
  }).join("");
}

function collectModuleAccess(root) {
  const moduleAccess = {};
  root.querySelectorAll(".ua-seg[data-module]").forEach((group) => {
    const checked = group.querySelector("input:checked");
    if (checked && checked.value) moduleAccess[group.dataset.module] = checked.value;
  });
  return moduleAccess;
}

/* ───────── Matrix ───────── */

function renderMatrix() {
  const table = $("#matrixTable");
  const header = `<thead><tr><th scope="col">Module</th>${adminState.roles.map((role) =>
    `<th scope="col"><button type="button" data-role="${escapeHtml(role.code)}">${escapeHtml(role.name)}</button></th>`).join("")}</tr></thead>`;
  const rows = adminState.modules.map((module) => `<tr><td>${escapeHtml(module.name)}</td>${adminState.roles.map((role) => {
    if (role.code === "admin") return `<td><span class="ua-dot admin">Full</span></td>`;
    const level = role.moduleAccess?.[module.code];
    return `<td><span class="ua-dot ${level || ""}">${level ? levelLabel(module, level) : "–"}</span></td>`;
  }).join("")}</tr>`).join("");
  table.innerHTML = `${header}<tbody>${rows}</tbody>`;
  table.querySelectorAll("[data-role]").forEach((button) => button.addEventListener("click", () => {
    adminState.selectedRole = button.dataset.role;
    setTab("roles");
  }));
}

/* ───────── Helpers ───────── */

function levelLabel(module, level) {
  if (level === "full") return "Full";
  return module.hasFullLevel ? "Read" : "Allowed";
}

function checkedValues(root, name) {
  return [...root.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}

async function apiJson(url, options = {}) {
  const fetchOptions = {
    method: options.method || "GET",
    headers: { ...(options.headers || {}) },
    cache: "no-store"
  };

  if (options.body !== undefined) {
    fetchOptions.headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchOptions);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Request failed");
    error.status = response.status;
    throw error;
  }
  return data;
}

function roleLabel(roleCode) {
  return adminState.roles.find((role) => role.code === roleCode)?.name || roleCode;
}

function formatDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
