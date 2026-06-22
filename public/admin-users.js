const adminState = {
  roles: [],
  modules: [],
  users: []
};

initUsers();

function initUsers() {
  document.querySelector("#userForm")?.addEventListener("submit", createPlatformUser);
  document.querySelector("#roleForm")?.addEventListener("submit", createPlatformRole);
  loadUsers();
}

async function loadUsers() {
  const message = document.querySelector("#userListMessage");
  try {
    const data = await apiJson("/api/admin/users");
    adminState.roles = data.roles || [];
    adminState.modules = data.modules || [];
    adminState.users = data.users || [];
    renderCreateUserRoles();
    renderNewRoleModuleAccess();
    renderUsers();
    renderRoleList();
    message.textContent = adminState.users.length ? "" : "No users have been created yet.";
    message.classList.remove("error");
  } catch (error) {
    message.textContent = error.status === 401
      ? "Sign in with an administrator account to manage users."
      : error.message;
    message.classList.toggle("error", error.status !== 401);
    window.OptiLensAuth?.requireSignIn();
  }
}

function renderCreateUserRoles() {
  const target = document.querySelector("#roleChoices");
  if (!target) return;

  target.innerHTML = adminState.roles.map((role) => `
    <label class="checkbox-row">
      <input type="checkbox" name="roles" value="${escapeHtml(role.code)}" ${role.code === "viewer" ? "checked" : ""}>
      <span>${escapeHtml(role.name)}</span>
    </label>
  `).join("");
}

function renderNewRoleModuleAccess() {
  const target = document.querySelector("#newRoleModuleAccess");
  if (!target) return;
  target.innerHTML = renderModuleAccessControls({});
}

function renderUsers() {
  const target = document.querySelector("#userList");
  if (!target) return;

  target.innerHTML = adminState.users.map((user) => `
    <article class="user-row">
      <div>
        <h3>${escapeHtml(user.displayName)} <span class="badge ${user.isActive ? "open" : "disabled"}">${user.isActive ? "active" : "disabled"}</span></h3>
        <p>${escapeHtml(user.username)}${user.email ? ` · ${escapeHtml(user.email)}` : ""}</p>
        <p>Last login: ${escapeHtml(formatDate(user.lastLoginAt) || "never")}</p>
        <div class="role-pills">
          ${(user.roles || []).map((role) => `<span class="role-pill">${escapeHtml(roleLabel(role))}</span>`).join("") || `<span class="role-pill">no roles</span>`}
        </div>
        <div class="user-role-choices">
          ${renderUserRoleChoices(user)}
        </div>
      </div>
      <div class="user-row-actions">
        <button class="text-button" type="button" data-save-roles="${escapeHtml(user.userId)}">Save Roles</button>
        <button class="text-button" type="button" data-reset="${escapeHtml(user.userId)}">Reset Password</button>
        <button class="text-button" type="button" data-toggle="${escapeHtml(user.userId)}" data-active="${user.isActive ? "1" : "0"}">${user.isActive ? "Disable" : "Enable"}</button>
      </div>
    </article>
  `).join("");

  target.querySelectorAll("[data-toggle]").forEach((button) => {
    button.addEventListener("click", async () => {
      const userId = button.dataset.toggle;
      const isActive = button.dataset.active !== "1";
      await updatePlatformUser(userId, { isActive });
    });
  });

  target.querySelectorAll("[data-reset]").forEach((button) => {
    button.addEventListener("click", async () => {
      const userId = button.dataset.reset;
      const user = adminState.users.find((item) => item.userId === userId);
      const newPassword = prompt(`Enter new temporary password for ${user.username}:`);
      if (newPassword) {
        await updatePlatformUser(userId, { password: newPassword });
        alert(`Password for ${user.username} has been reset.`);
      }
    });
  });

  target.querySelectorAll("[data-save-roles]").forEach((button) => {
    button.addEventListener("click", async () => {
      const userId = button.dataset.saveRoles;
      const row = button.closest(".user-row");
      await updatePlatformUser(userId, { roles: collectCheckedValues(row, "userRoles") });
    });
  });
}

function renderUserRoleChoices(user) {
  const assigned = new Set(user.roles || []);
  return adminState.roles.map((role) => `
    <label class="checkbox-row compact">
      <input type="checkbox" name="userRoles" value="${escapeHtml(role.code)}" ${assigned.has(role.code) ? "checked" : ""}>
      <span>${escapeHtml(role.name)}</span>
    </label>
  `).join("");
}

function renderRoleList() {
  const target = document.querySelector("#roleList");
  const message = document.querySelector("#roleListMessage");
  if (!target) return;

  message.textContent = adminState.roles.length ? "" : "No roles are configured.";
  target.innerHTML = adminState.roles.map((role) => `
    <article class="role-editor" data-role="${escapeHtml(role.code)}">
      <div class="role-editor-head">
        <div>
          <h3>${escapeHtml(role.name)} <span class="role-pill">${escapeHtml(role.code)}</span></h3>
          <p>${role.isSystem ? "Built-in role" : "Custom role"}</p>
        </div>
        <div class="user-row-actions">
          ${role.code === "admin" ? "" : `<button class="text-button" type="button" data-save-role="${escapeHtml(role.code)}">Save Role</button>`}
          ${role.isSystem ? "" : `<button class="text-button danger" type="button" data-delete-role="${escapeHtml(role.code)}">Delete</button>`}
        </div>
      </div>
      ${role.code === "admin"
        ? `<p class="module-access-note">Administrator always grants full platform access.</p>`
        : `<label>Role name
            <input data-role-name value="${escapeHtml(role.name)}">
          </label>
          <div class="module-access-grid">${renderModuleAccessControls(role.moduleAccess || {})}</div>`}
    </article>
  `).join("");

  target.querySelectorAll("[data-save-role]").forEach((button) => {
    button.addEventListener("click", async () => {
      const roleCode = button.dataset.saveRole;
      const editor = button.closest(".role-editor");
      await updatePlatformRole(roleCode, {
        name: editor.querySelector("[data-role-name]")?.value.trim(),
        moduleAccess: collectModuleAccess(editor)
      });
    });
  });

  target.querySelectorAll("[data-delete-role]").forEach((button) => {
    button.addEventListener("click", async () => {
      const roleCode = button.dataset.deleteRole;
      if (!confirm(`Delete role ${roleCode}?`)) return;
      await deletePlatformRole(roleCode);
    });
  });
}

function renderModuleAccessControls(access) {
  return adminState.modules.map((module) => `
    <label class="module-access-row">
      <span>${escapeHtml(module.name)}</span>
      <select data-module="${escapeHtml(module.code)}">
        <option value="" ${access[module.code] ? "" : "selected"}>Off</option>
        <option value="read" ${access[module.code] === "read" ? "selected" : ""}>Read only</option>
        <option value="full" ${access[module.code] === "full" ? "selected" : ""}>Full access</option>
      </select>
    </label>
  `).join("");
}

function collectCheckedValues(root, name) {
  return [...root.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}

function collectModuleAccess(root = document) {
  const moduleAccess = {};
  root.querySelectorAll("select[data-module]").forEach((select) => {
    if (select.value) {
      moduleAccess[select.dataset.module] = select.value;
    }
  });
  return moduleAccess;
}

async function createPlatformUser(event) {
  event.preventDefault();
  const message = document.querySelector("#userFormMessage");
  const roles = collectCheckedValues(document.querySelector("#userForm"), "roles");

  message.textContent = "Creating user...";
  message.classList.remove("error");

  try {
    await apiJson("/api/admin/users", {
      method: "POST",
      body: {
        username: document.querySelector("#newUsername").value.trim(),
        displayName: document.querySelector("#newDisplayName").value.trim(),
        email: document.querySelector("#newEmail").value.trim(),
        password: document.querySelector("#newPassword").value,
        roles
      }
    });
    event.target.reset();
    message.textContent = "User created.";
    await loadUsers();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
}

async function createPlatformRole(event) {
  event.preventDefault();
  const message = document.querySelector("#roleFormMessage");
  message.textContent = "Creating role...";
  message.classList.remove("error");

  try {
    await apiJson("/api/admin/roles", {
      method: "POST",
      body: {
        name: document.querySelector("#newRoleName").value.trim(),
        code: document.querySelector("#newRoleCode").value.trim(),
        moduleAccess: collectModuleAccess(document.querySelector("#roleForm"))
      }
    });
    event.target.reset();
    message.textContent = "Role created.";
    await loadUsers();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
}

async function updatePlatformUser(userId, body) {
  const message = document.querySelector("#userListMessage");
  try {
    await apiJson(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body
    });
    message.textContent = "User saved.";
    message.classList.remove("error");
    await loadUsers();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
}

async function updatePlatformRole(roleCode, body) {
  const message = document.querySelector("#roleListMessage");
  try {
    await apiJson(`/api/admin/roles/${encodeURIComponent(roleCode)}`, {
      method: "PATCH",
      body
    });
    message.textContent = "Role saved.";
    message.classList.remove("error");
    await loadUsers();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
}

async function deletePlatformRole(roleCode) {
  const message = document.querySelector("#roleListMessage");
  try {
    await apiJson(`/api/admin/roles/${encodeURIComponent(roleCode)}`, {
      method: "DELETE"
    });
    message.textContent = "Role deleted.";
    message.classList.remove("error");
    await loadUsers();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
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
