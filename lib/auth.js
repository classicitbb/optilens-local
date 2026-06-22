const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { recordAuditEvent } = require("./audit");

const PASSWORD_ITERATIONS = 210000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = "sha256";
const PASSWORD_PREFIX = "pbkdf2-sha256";

const USERS_FILE = path.join(__dirname, "..", "data", "users.json");

const MODULE_ACCESS = [
  {
    code: "delivery-export",
    name: "Delivery and Export",
    readPermissions: ["delivery.read"],
    fullPermissions: ["delivery.write"]
  },
  {
    code: "pricing-automation",
    name: "Pricing Automation",
    readPermissions: ["pricing.read"],
    fullPermissions: ["pricing.write"]
  },
  {
    code: "integrations",
    name: "Integrations",
    readPermissions: ["integrations.read"],
    fullPermissions: ["integrations.manage"]
  },
  {
    code: "automation",
    name: "Automation",
    readPermissions: ["automation.read"],
    fullPermissions: ["automation.manage"]
  }
];

const ADMIN_PERMISSIONS = [
  "platform.admin",
  "users.manage",
  "credentials.manage",
  "dashboard.write",
  ...MODULE_ACCESS.flatMap((module) => module.readPermissions.concat(module.fullPermissions))
];

const LEGACY_VIEWER_MODULE_ACCESS = {
  "delivery-export": "read",
  "pricing-automation": "read"
};

function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      return { users: [] };
    }
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch (error) {
    return { users: [] };
  }
}

function writeUsers(data) {
  const dir = path.dirname(USERS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

async function getBootstrapState() {
  const data = readUsers();
  return {
    needsMigration: false,
    needsBootstrap: data.users.length === 0,
    credentialCount: data.users.length
  };
}

async function bootstrapAdmin(payload) {
  const state = await getBootstrapState();

  if (!state.needsBootstrap) {
    const error = new Error("Bootstrap is already complete.");
    error.statusCode = 409;
    throw error;
  }

  const username = normalizeUsername(payload.username || "admin");
  const displayName = normalizeText(payload.displayName || "Administrator", 200);
  const email = normalizeEmail(payload.email);
  const passwordHash = hashPassword(requirePassword(payload.password));
  
  const data = readUsers();
  const userId = crypto.randomUUID();

  const user = {
    userId,
    username,
    displayName,
    email,
    isActive: true,
    roles: ["admin"],
    moduleAccess: {},
    passwordHash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    mustChangePassword: false
  };

  data.users.push(user);
  writeUsers(data);
  await auditUserChange("users.bootstrap_admin", userId, null, {
    username,
    roles: user.roles
  });

  return getUserAccess(userId);
}

async function authenticateUser(usernameValue, password) {
  const username = normalizeUsername(usernameValue);
  if (!username || !password) {
    const error = new Error("Username and password are required.");
    error.statusCode = 400;
    throw error;
  }

  const data = readUsers();
  const user = data.users.find(u => u.username === username);

  if (!user || !user.isActive) {
    await delayFailedLogin();
    throwInvalidLogin();
  }

  if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
    const error = new Error("Account is temporarily locked. Try again later.");
    error.statusCode = 423;
    throw error;
  }

  if (!verifyPassword(password, user.passwordHash)) {
    user.failedLoginCount = (user.failedLoginCount || 0) + 1;
    if (user.failedLoginCount >= 5) {
      user.lockedUntil = new Date(Date.now() + 15 * 60000).toISOString();
    }
    writeUsers(data);
    await delayFailedLogin();
    throwInvalidLogin();
  }

  user.failedLoginCount = 0;
  user.lockedUntil = null;
  user.lastLoginAt = new Date().toISOString();
  writeUsers(data);

  return getUserAccess(user.userId);
}

async function getUserAccess(userId) {
  const data = readUsers();
  const user = data.users.find(u => u.userId === userId);

  if (!user || !user.isActive) {
    const error = new Error("User is inactive or no longer exists.");
    error.statusCode = 401;
    throw error;
  }

  const roles = normalizeRoles(user.roles || ["viewer"]);
  const moduleAccess = normalizeModuleAccess(user.moduleAccess, roles);
  const permissions = [];
  if (roles.includes("admin")) {
    permissions.push(...ADMIN_PERMISSIONS);
  } else {
    permissions.push(...permissionsForModuleAccess(moduleAccess));
  }

  return {
    userId: user.userId,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    roles,
    roleNames: roles,
    permissions: [...new Set(permissions)],
    moduleAccess,
    accessibleModules: MODULE_ACCESS
      .filter((module) => roles.includes("admin") || moduleAccess[module.code])
      .map((module) => ({
        code: module.code,
        name: module.name,
        level: roles.includes("admin") ? "full" : moduleAccess[module.code]
      }))
  };
}

async function listUsers() {
  const data = readUsers();
  
  const users = data.users.map(u => ({
    userId: u.userId,
    username: u.username,
    displayName: u.displayName,
    email: u.email,
    isActive: u.isActive,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
    lastLoginAt: u.lastLoginAt,
    roles: normalizeRoles(u.roles || []),
    moduleAccess: normalizeModuleAccess(u.moduleAccess, u.roles || [])
  }));

  const roles = [
    { code: "admin", name: "Administrator" },
    { code: "viewer", name: "Viewer" }
  ];

  return { users, roles, modules: MODULE_ACCESS.map((module) => ({ code: module.code, name: module.name })) };
}

async function createUser(payload, actorUserId) {
  const username = normalizeUsername(payload.username);
  const displayName = normalizeText(payload.displayName, 200);
  const email = normalizeEmail(payload.email);
  const passwordHash = hashPassword(requirePassword(payload.password));
  const roles = normalizeRoles(payload.roles);
  const moduleAccess = normalizeModuleAccess(payload.moduleAccess, roles, { applyLegacyDefault: false });

  if (!username || !displayName) {
    const error = new Error("Username and display name are required.");
    error.statusCode = 400;
    throw error;
  }

  const data = readUsers();
  if (data.users.find(u => u.username === username)) {
    const error = new Error("Username already exists.");
    error.statusCode = 409;
    throw error;
  }

  const userId = crypto.randomUUID();
  const user = {
    userId,
    username,
    displayName,
    email,
    isActive: true,
    roles: roles.length ? roles : ["viewer"],
    moduleAccess: roles.includes("admin") ? {} : moduleAccess,
    passwordHash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
    mustChangePassword: true
  };

  data.users.push(user);
  writeUsers(data);
  await auditUserChange("users.created", userId, actorUserId, {
    username,
    roles: user.roles,
    moduleAccess: user.moduleAccess
  });

  return getUserAccess(userId);
}

async function updateUser(userId, payload, actorUserId) {
  const data = readUsers();
  const user = data.users.find(u => u.userId === userId);
  
  if (!user) {
    const error = new Error("User not found.");
    error.statusCode = 404;
    throw error;
  }

  if (payload.displayName !== undefined) user.displayName = normalizeText(payload.displayName, 200);
  if (payload.email !== undefined) user.email = normalizeEmail(payload.email);
  if (payload.isActive !== undefined) user.isActive = Boolean(payload.isActive);
  if (payload.roles !== undefined) user.roles = normalizeRoles(payload.roles);
  if (payload.moduleAccess !== undefined) {
    user.moduleAccess = user.roles.includes("admin")
      ? {}
      : normalizeModuleAccess(payload.moduleAccess, user.roles, { applyLegacyDefault: false });
  } else if (user.roles.includes("admin")) {
    user.moduleAccess = {};
  }
  
  if (payload.password) {
    user.passwordHash = hashPassword(requirePassword(payload.password));
    user.mustChangePassword = true;
  }

  user.updatedAt = new Date().toISOString();
  writeUsers(data);
  await auditUserChange("users.updated", userId, actorUserId, {
    changedFields: Object.keys(payload || {}).filter((key) => key !== "password"),
    passwordChanged: Boolean(payload.password),
    roles: user.roles,
    moduleAccess: user.moduleAccess || {}
  });

  return getUserAccess(userId);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST);
  return `${PASSWORD_PREFIX}$${PASSWORD_ITERATIONS}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password, storedHash) {
  const stored = String(storedHash || "");

  // Plain-text store (dev users): anything not in the pbkdf2-sha256$... format
  // is treated as a literal password and compared directly. Intended for the
  // in-house dev login only — production credentials should stay pbkdf2-hashed.
  if (!stored.startsWith(`${PASSWORD_PREFIX}$`)) {
    const a = Buffer.from(String(password || ""));
    const b = Buffer.from(stored);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== PASSWORD_PREFIX) return false;

  const iterations = Number(parts[1]);
  const salt = Buffer.from(parts[2], "base64");
  const expected = Buffer.from(parts[3], "base64");
  const actual = crypto.pbkdf2Sync(password, salt, iterations, expected.length, PASSWORD_DIGEST);

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function requirePassword(password) {
  const value = String(password || "");
  if (value.length < 5) { // Relaxed to 5 for "optilens" or dev purposes
    const error = new Error("Password must be at least 5 characters.");
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._@-]/g, "")
    .slice(0, 160);
}

function normalizeText(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeEmail(value) {
  const email = normalizeText(value, 260);
  return email || null;
}

function normalizeRoles(roles) {
  return Array.isArray(roles)
    ? [...new Set(roles.map((role) => normalizeUsername(role)).filter(Boolean))]
    : [];
}

function normalizeModuleAccess(moduleAccess, roles = [], options = {}) {
  const roleCodes = normalizeRoles(roles);
  if (roleCodes.includes("admin")) return {};

  const shouldDefault = options.applyLegacyDefault !== false;
  const source = moduleAccess && typeof moduleAccess === "object" && !Array.isArray(moduleAccess)
    ? moduleAccess
    : shouldDefault
    ? LEGACY_VIEWER_MODULE_ACCESS
    : {};
  const allowedModules = new Set(MODULE_ACCESS.map((module) => module.code));
  const normalized = {};

  for (const [moduleCode, level] of Object.entries(source)) {
    const code = normalizeModuleCode(moduleCode);
    const accessLevel = normalizeAccessLevel(level);
    if (allowedModules.has(code) && accessLevel) {
      normalized[code] = accessLevel;
    }
  }

  return normalized;
}

function normalizeModuleCode(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 100);
}

function normalizeAccessLevel(value) {
  const level = String(value || "").trim().toLowerCase();
  return ["read", "full"].includes(level) ? level : "";
}

function permissionsForModuleAccess(moduleAccess) {
  const permissions = [];
  for (const module of MODULE_ACCESS) {
    const level = moduleAccess[module.code];
    if (!level) continue;
    permissions.push(...module.readPermissions);
    if (level === "full") {
      permissions.push(...module.fullPermissions);
    }
  }
  return permissions;
}

function throwInvalidLogin() {
  const error = new Error("Invalid username or password.");
  error.statusCode = 401;
  throw error;
}

function delayFailedLogin() {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

async function changePassword(userId, oldPassword, newPassword) {
  const data = readUsers();
  const user = data.users.find(u => u.userId === userId);
  
  if (!user || !user.isActive) {
    const error = new Error("User not found.");
    error.statusCode = 404;
    throw error;
  }

  if (!verifyPassword(oldPassword, user.passwordHash)) {
    const error = new Error("Incorrect current password.");
    error.statusCode = 401;
    throw error;
  }

  user.passwordHash = hashPassword(requirePassword(newPassword));
  user.mustChangePassword = false;
  user.updatedAt = new Date().toISOString();
  writeUsers(data);
  await auditUserChange("users.password_changed", userId, userId, {
    selfService: true
  });
}

async function auditUserChange(eventType, userId, actorUserId, eventData) {
  try {
    await recordAuditEvent({
      actorUserId,
      eventType,
      entityType: "core.users",
      entityId: userId,
      eventData
    });
  } catch {
    // User management remains available if the app DB audit sink is offline.
  }
}

module.exports = {
  authenticateUser,
  bootstrapAdmin,
  changePassword,
  createUser,
  getBootstrapState,
  getUserAccess,
  listUsers,
  MODULE_ACCESS,
  updateUser
};
