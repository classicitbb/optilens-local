const adminState = {
  roles: [],
  modules: [],
  users: []
};

initUsers();

function initUsers() {
  document.querySelector("#userForm")?.addEventListener("submit", createPlatformUser);
  loadUsers();
}

async function loadUsers() {
  const message = document.querySelector("#userListMessage");
  try {
    const data = await apiJson("/api/admin/users");
    adminState.roles = data.roles || [];
    adminState.modules = data.modules || [];
    adminState.users = data.users || [];
    renderRoles();
    renderModuleAccessChoices();
    renderUsers();
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

function renderRoles() {
  const target = document.querySelector("#roleChoices");
  if (!target) return;

  target.innerHTML = adminState.roles.map((role) => `
    <label class="checkbox-row">
      <input type="checkbox" name="roles" value="${escapeHtml(role.code)}" ${role.code === "viewer" ? "checked" : ""}>
      <span>${escapeHtml(role.name)}</span>
    </label>
  `).join("");
}

function renderModuleAccessChoices() {
  const target = document.querySelector("#moduleAccessChoices");
  if (!target) return;

  target.innerHTML = adminState.modules.map((module) => `
    <label class="module-access-row">
      <span>${escapeHtml(module.name)}</span>
      <select name="moduleAccess" data-module="${escapeHtml(module.code)}">
        <option value="">Off</option>
        <option value="read">Read only</option>
        <option value="full">Full access</option>
      </select>
    </label>
  `).join("");
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
          ${(user.roles || []).map((role) => `<span class="role-pill">${escapeHtml(role)}</span>`).join("") || `<span class="role-pill">no roles</span>`}
        </div>
        <div class="user-module-access">
          ${renderUserModuleAccess(user)}
        </div>
      </div>
      <div class="user-row-actions">
        <button class="text-button" type="button" data-save-access="${escapeHtml(user.userId)}">Save Access</button>
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
      const user = adminState.users.find(u => u.userId === userId);
      const newPassword = prompt(`Enter new temporary password for ${user.username}:`);
      if (newPassword) {
        await updatePlatformUser(userId, { password: newPassword });
        alert(`Password for ${user.username} has been reset.`);
      }
    });
  });

  target.querySelectorAll("[data-save-access]").forEach((button) => {
    button.addEventListener("click", async () => {
      const userId = button.dataset.saveAccess;
      const row = button.closest(".user-row");
      const moduleAccess = collectModuleAccess(row);
      await updatePlatformUser(userId, { moduleAccess });
    });
  });
}

function renderUserModuleAccess(user) {
  if ((user.roles || []).includes("admin")) {
    return `<p class="module-access-note">Administrator role grants full access.</p>`;
  }

  const access = user.moduleAccess || {};
  return adminState.modules.map((module) => `
    <label class="module-access-row compact">
      <span>${escapeHtml(module.name)}</span>
      <select data-module="${escapeHtml(module.code)}">
        <option value="" ${access[module.code] ? "" : "selected"}>Off</option>
        <option value="read" ${access[module.code] === "read" ? "selected" : ""}>Read only</option>
        <option value="full" ${access[module.code] === "full" ? "selected" : ""}>Full access</option>
      </select>
    </label>
  `).join("");
}

function collectModuleAccess(root = document) {
  const moduleAccess = {};
  root.querySelectorAll("select[data-module]").forEach((select) => {
    const level = select.value;
    if (level) {
      moduleAccess[select.dataset.module] = level;
    }
  });
  return moduleAccess;
}

async function createPlatformUser(event) {
  event.preventDefault();
  const message = document.querySelector("#userFormMessage");
  const roles = [...document.querySelectorAll("input[name='roles']:checked")].map((input) => input.value);
  const moduleAccess = collectModuleAccess(document.querySelector("#userForm"));

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
        roles,
        moduleAccess
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

async function updatePlatformUser(userId, body) {
  const message = document.querySelector("#userListMessage");
  try {
    await apiJson(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: "PATCH",
      body
    });
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
