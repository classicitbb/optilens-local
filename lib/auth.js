const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const sql = require("mssql");
const { recordAuditEvent } = require("./audit");
const { getAppPool } = require("./db");

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
  },
  {
    code: "doc-studio",
    name: "Doc Studio",
    readPermissions: ["docstudio.read"],
    fullPermissions: ["docstudio.write"]
  }
];

const ADMIN_PERMISSIONS = [
  "platform.admin",
  "users.manage",
  "credentials.manage",
  "dashboard.write",
  ...MODULE_ACCESS.flatMap((module) => module.readPermissions.concat(module.fullPermissions))
];

const SYSTEM_ROLE_CODES = new Set(["admin", "viewer"]);

const DEFAULT_ROLE_ACCESS = {
  admin: {},
  viewer: {
    "delivery-export": "read",
    "pricing-automation": "read"
  },
  dispatcher: {
    "delivery-export": "full"
  },
  export_shipping: {
    "delivery-export": "full"
  },
  pricing_manager: {
    "pricing-automation": "full"
  }
};

async function getBootstrapState() {
  try {
    const pool = await getAppPool();
    const result = await pool.request().query(`
      SELECT
        (SELECT COUNT(*) FROM core.users) AS user_count,
        (SELECT COUNT(*) FROM core.user_credentials) AS credential_count;
    `);
    const row = result.recordset[0] || {};
    return {
      needsMigration: false,
      needsBootstrap: Number(row.credential_count || 0) === 0,
      credentialCount: Number(row.credential_count || 0),
      userCount: Number(row.user_count || 0)
    };
  } catch {
    return {
      needsMigration: true,
      needsBootstrap: false,
      credentialCount: 0,
      userCount: 0
    };
  }
}

async function bootstrapAdmin(payload) {
  const state = await getBootstrapState();
  if (state.needsMigration) {
    const error = new Error("Authentication tables are missing or unavailable. Run migrations first.");
    error.statusCode = 503;
    throw error;
  }
  if (!state.needsBootstrap) {
    const error = new Error("Bootstrap is already complete.");
    error.statusCode = 409;
    throw error;
  }

  const username = normalizeUsername(payload.username || "admin");
  const displayName = normalizeText(payload.displayName || "Administrator", 200);
  const email = normalizeEmail(payload.email);
  const passwordHash = hashPassword(requirePassword(payload.password));
  const userId = crypto.randomUUID();

  const pool = await getAppPool();
  await ensureRoleSeeds(pool);
  await pool.request()
    .input("user_id", sql.UniqueIdentifier, userId)
    .input("username", sql.NVarChar(160), username)
    .input("display_name", sql.NVarChar(200), displayName)
    .input("email", sql.NVarChar(260), email)
    .input("password_hash", sql.NVarChar(512), passwordHash)
    .query(`
      DECLARE @tenant_id uniqueidentifier;
      SELECT @tenant_id = tenant_id FROM core.tenants WHERE tenant_code = N'default';
      IF @tenant_id IS NULL
      BEGIN
        INSERT INTO core.tenants (tenant_code, tenant_name)
        VALUES (N'default', N'OptiLens Local');
        SELECT @tenant_id = tenant_id FROM core.tenants WHERE tenant_code = N'default';
      END;

      INSERT INTO core.users (user_id, tenant_id, username, display_name, email, is_active, updated_at)
      VALUES (@user_id, @tenant_id, @username, @display_name, @email, 1, SYSUTCDATETIME());

      INSERT INTO core.user_credentials (user_id, password_hash, must_change_password)
      VALUES (@user_id, @password_hash, 0);

      INSERT INTO core.user_roles (user_id, role_id)
      SELECT @user_id, role_id
      FROM core.roles
      WHERE role_code = N'admin';
    `);

  await auditAuthChange("users.bootstrap_admin", userId, null, { username, roles: ["admin"] });
  return getUserAccess(userId);
}

async function authenticateUser(usernameValue, password) {
  const username = normalizeUsername(usernameValue);
  if (!username || !password) {
    const error = new Error("Username and password are required.");
    error.statusCode = 400;
    throw error;
  }

  const pool = await getAppPool();
  const result = await pool.request()
    .input("username", sql.NVarChar(160), username)
    .query(`
      SELECT
        u.user_id,
        u.is_active,
        c.password_hash,
        c.failed_login_count,
        c.locked_until
      FROM core.users u
      INNER JOIN core.user_credentials c
        ON c.user_id = u.user_id
      WHERE u.username = @username;
    `);
  const user = result.recordset[0];

  if (!user || !user.is_active) {
    await delayFailedLogin();
    throwInvalidLogin();
  }

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    const error = new Error("Account is temporarily locked. Try again later.");
    error.statusCode = 423;
    throw error;
  }

  if (!verifyPassword(password, user.password_hash)) {
    const failedLoginCount = Number(user.failed_login_count || 0) + 1;
    await pool.request()
      .input("user_id", sql.UniqueIdentifier, user.user_id)
      .input("failed_login_count", sql.Int, failedLoginCount)
      .input("locked_until", sql.DateTime2, failedLoginCount >= 5 ? new Date(Date.now() + 15 * 60000) : null)
      .query(`
        UPDATE core.user_credentials
        SET failed_login_count = @failed_login_count,
            locked_until = @locked_until
        WHERE user_id = @user_id;
      `);
    await delayFailedLogin();
    throwInvalidLogin();
  }

  await pool.request()
    .input("user_id", sql.UniqueIdentifier, user.user_id)
    .query(`
      UPDATE core.user_credentials
      SET failed_login_count = 0,
          locked_until = NULL,
          last_login_at = SYSUTCDATETIME()
      WHERE user_id = @user_id;
    `);

  return getUserAccess(user.user_id);
}

async function getUserAccess(userId) {
  const pool = await getAppPool();
  const userResult = await pool.request()
    .input("user_id", sql.UniqueIdentifier, userId)
    .query(`
      SELECT u.user_id, u.username, u.display_name, u.email, u.is_active
      FROM core.users u
      WHERE u.user_id = @user_id;
    `);
  const user = userResult.recordset[0];
  if (!user || !user.is_active) {
    const error = new Error("User is inactive or no longer exists.");
    error.statusCode = 401;
    throw error;
  }

  const roles = await rolesForUser(pool, user.user_id);
  const roleCodes = roles.map((role) => role.code);
  const moduleAccess = roleCodes.includes("admin") ? {} : await moduleAccessForRoles(pool, roleCodes);
  const permissions = roleCodes.includes("admin")
    ? ADMIN_PERMISSIONS
    : permissionsForModuleAccess(moduleAccess);

  return {
    userId: user.user_id,
    username: user.username,
    displayName: user.display_name,
    email: user.email,
    roles: roleCodes,
    roleNames: roles.map((role) => role.name),
    permissions: [...new Set(permissions)],
    moduleAccess,
    accessibleModules: MODULE_ACCESS
      .filter((module) => roleCodes.includes("admin") || moduleAccess[module.code])
      .map((module) => ({
        code: module.code,
        name: module.name,
        level: roleCodes.includes("admin") ? "full" : moduleAccess[module.code]
      }))
  };
}

async function listUsers() {
  const pool = await getAppPool();
  await ensureRoleSeeds(pool);

  const result = await pool.request().query(`
    SELECT
      u.user_id,
      u.username,
      u.display_name,
      u.email,
      u.is_active,
      u.created_at,
      u.updated_at,
      c.last_login_at
    FROM core.users u
    LEFT JOIN core.user_credentials c
      ON c.user_id = u.user_id
    WHERE u.username <> N'local-dashboard'
    ORDER BY u.display_name, u.username;

    SELECT
      r.role_code,
      r.role_name,
      m.module_code,
      rma.access_level
    FROM core.roles r
    LEFT JOIN core.role_module_access rma
      ON rma.role_id = r.role_id
    LEFT JOIN core.modules m
      ON m.module_id = rma.module_id
    ORDER BY r.role_name, m.module_name;

    SELECT u.user_id, r.role_code
    FROM core.user_roles ur
    INNER JOIN core.users u
      ON u.user_id = ur.user_id
    INNER JOIN core.roles r
      ON r.role_id = ur.role_id;
  `);

  const roleRows = result.recordsets[1] || [];
  const userRoleRows = result.recordsets[2] || [];
  const roleMap = roleMapFromRows(roleRows);

  const users = (result.recordsets[0] || []).map((row) => {
    const roles = userRoleRows
      .filter((item) => sameGuid(item.user_id, row.user_id))
      .map((item) => item.role_code);
    return {
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      isActive: row.is_active,
      createdAt: toIso(row.created_at),
      updatedAt: toIso(row.updated_at),
      lastLoginAt: toIso(row.last_login_at),
      roles,
      moduleAccess: combineModuleAccess(roles.map((roleCode) => roleMap.get(roleCode)?.moduleAccess))
    };
  });

  return {
    users,
    roles: [...roleMap.values()].map(publicRole),
    modules: MODULE_ACCESS.map((module) => ({ code: module.code, name: module.name }))
  };
}

async function createUser(payload, actorUserId) {
  const username = normalizeUsername(payload.username);
  const displayName = normalizeText(payload.displayName, 200);
  const email = normalizeEmail(payload.email);
  const passwordHash = hashPassword(requirePassword(payload.password));
  const roles = normalizeRoles(payload.roles);

  if (!username || !displayName) {
    const error = new Error("Username and display name are required.");
    error.statusCode = 400;
    throw error;
  }

  const pool = await getAppPool();
  await ensureRoleSeeds(pool);
  await validateAssignedRoles(pool, roles);

  const userId = crypto.randomUUID();
  try {
    await pool.request()
      .input("user_id", sql.UniqueIdentifier, userId)
      .input("username", sql.NVarChar(160), username)
      .input("display_name", sql.NVarChar(200), displayName)
      .input("email", sql.NVarChar(260), email)
      .input("password_hash", sql.NVarChar(512), passwordHash)
      .query(`
        DECLARE @tenant_id uniqueidentifier;
        SELECT @tenant_id = tenant_id FROM core.tenants WHERE tenant_code = N'default';
        IF @tenant_id IS NULL
        BEGIN
          INSERT INTO core.tenants (tenant_code, tenant_name)
          VALUES (N'default', N'OptiLens Local');
          SELECT @tenant_id = tenant_id FROM core.tenants WHERE tenant_code = N'default';
        END;

        INSERT INTO core.users (user_id, tenant_id, username, display_name, email, is_active, updated_at)
        VALUES (@user_id, @tenant_id, @username, @display_name, @email, 1, SYSUTCDATETIME());

        INSERT INTO core.user_credentials (user_id, password_hash, must_change_password)
        VALUES (@user_id, @password_hash, 1);
      `);
  } catch (error) {
    if (String(error.message || "").includes("UQ_core_users_username")) {
      const conflict = new Error("Username already exists.");
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }

  await replaceUserRoles(pool, userId, roles.length ? roles : ["viewer"]);
  await auditAuthChange("users.created", userId, actorUserId, { username, roles: roles.length ? roles : ["viewer"] });
  return getUserAccess(userId);
}

async function updateUser(userId, payload, actorUserId) {
  const pool = await getAppPool();
  const existing = await pool.request()
    .input("user_id", sql.UniqueIdentifier, userId)
    .query(`SELECT user_id FROM core.users WHERE user_id = @user_id;`);
  if (!existing.recordset.length) {
    const error = new Error("User not found.");
    error.statusCode = 404;
    throw error;
  }

  if (payload.displayName !== undefined || payload.email !== undefined || payload.isActive !== undefined) {
    await pool.request()
      .input("user_id", sql.UniqueIdentifier, userId)
      .input("display_name", sql.NVarChar(200), payload.displayName === undefined ? null : normalizeText(payload.displayName, 200))
      .input("email", sql.NVarChar(260), payload.email === undefined ? null : normalizeEmail(payload.email))
      .input("is_active", sql.Bit, payload.isActive === undefined ? null : Boolean(payload.isActive))
      .query(`
        UPDATE core.users
        SET display_name = COALESCE(@display_name, display_name),
            email = CASE WHEN @email IS NULL THEN email ELSE @email END,
            is_active = COALESCE(@is_active, is_active),
            updated_at = SYSUTCDATETIME()
        WHERE user_id = @user_id;
      `);
  }

  if (payload.roles !== undefined) {
    const roles = normalizeRoles(payload.roles);
    await validateAssignedRoles(pool, roles);
    await replaceUserRoles(pool, userId, roles.length ? roles : ["viewer"]);
  }

  if (payload.password) {
    await pool.request()
      .input("user_id", sql.UniqueIdentifier, userId)
      .input("password_hash", sql.NVarChar(512), hashPassword(requirePassword(payload.password)))
      .query(`
        UPDATE core.user_credentials
        SET password_hash = @password_hash,
            must_change_password = 1,
            failed_login_count = 0,
            locked_until = NULL,
            password_changed_at = SYSUTCDATETIME()
        WHERE user_id = @user_id;
      `);
  }

  await auditAuthChange("users.updated", userId, actorUserId, {
    changedFields: Object.keys(payload || {}).filter((key) => key !== "password"),
    passwordChanged: Boolean(payload.password)
  });
  return getUserAccess(userId);
}

async function createRole(payload, actorUserId) {
  const pool = await getAppPool();
  const code = normalizeRoleCode(payload.code || payload.name);
  const name = normalizeText(payload.name, 200);
  const moduleAccess = normalizeModuleAccess(payload.moduleAccess, [], { applyLegacyDefault: false });

  if (!code || !name) {
    const error = new Error("Role code and name are required.");
    error.statusCode = 400;
    throw error;
  }

  try {
    await pool.request()
      .input("role_code", sql.NVarChar(100), code)
      .input("role_name", sql.NVarChar(200), name)
      .query(`
        INSERT INTO core.roles (role_code, role_name)
        VALUES (@role_code, @role_name);
      `);
  } catch (error) {
    if (String(error.message || "").includes("UQ_core_roles_code")) {
      const conflict = new Error("Role already exists.");
      conflict.statusCode = 409;
      throw conflict;
    }
    throw error;
  }

  await replaceRoleModuleAccess(pool, code, moduleAccess, actorUserId);
  await auditAuthChange("roles.created", code, actorUserId, { code, name, moduleAccess });
  return getRole(pool, code);
}

async function updateRole(roleCode, payload, actorUserId) {
  const pool = await getAppPool();
  const code = normalizeRoleCode(roleCode);
  const role = await getRole(pool, code);
  if (!role) {
    const error = new Error("Role not found.");
    error.statusCode = 404;
    throw error;
  }
  if (code === "admin" && payload.moduleAccess !== undefined) {
    const error = new Error("Administrator access cannot be limited.");
    error.statusCode = 400;
    throw error;
  }

  if (payload.name !== undefined && code !== "admin") {
    await pool.request()
      .input("role_code", sql.NVarChar(100), code)
      .input("role_name", sql.NVarChar(200), normalizeText(payload.name, 200) || role.name)
      .query(`
        UPDATE core.roles
        SET role_name = @role_name
        WHERE role_code = @role_code;
      `);
  }

  if (payload.moduleAccess !== undefined && code !== "admin") {
    await replaceRoleModuleAccess(pool, code, normalizeModuleAccess(payload.moduleAccess, [], { applyLegacyDefault: false }), actorUserId);
  }

  await auditAuthChange("roles.updated", code, actorUserId, {
    changedFields: Object.keys(payload || {})
  });
  return getRole(pool, code);
}

async function deleteRole(roleCode, actorUserId) {
  const pool = await getAppPool();
  const code = normalizeRoleCode(roleCode);
  const role = await getRole(pool, code);
  if (!role) {
    const error = new Error("Role not found.");
    error.statusCode = 404;
    throw error;
  }
  if (role.isSystem) {
    const error = new Error("Built-in roles cannot be deleted.");
    error.statusCode = 400;
    throw error;
  }

  const assigned = await pool.request()
    .input("role_code", sql.NVarChar(100), code)
    .query(`
      SELECT COUNT(*) AS assigned_count
      FROM core.user_roles ur
      INNER JOIN core.roles r
        ON r.role_id = ur.role_id
      WHERE r.role_code = @role_code;
    `);
  if (Number(assigned.recordset[0]?.assigned_count || 0) > 0) {
    const error = new Error("Remove this role from users before deleting it.");
    error.statusCode = 409;
    throw error;
  }

  await pool.request()
    .input("role_code", sql.NVarChar(100), code)
    .query(`
      DECLARE @role_id uniqueidentifier;
      SELECT @role_id = role_id FROM core.roles WHERE role_code = @role_code;
      DELETE FROM core.role_module_access WHERE role_id = @role_id;
      DELETE FROM core.role_permissions WHERE role_id = @role_id;
      DELETE FROM core.roles WHERE role_id = @role_id;
    `);
  await auditAuthChange("roles.deleted", code, actorUserId, { code, name: role.name });
  return { ok: true };
}

async function changePassword(userId, oldPassword, newPassword) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("user_id", sql.UniqueIdentifier, userId)
    .query(`
      SELECT password_hash
      FROM core.user_credentials
      WHERE user_id = @user_id;
    `);
  const credential = result.recordset[0];
  if (!credential) {
    const error = new Error("User not found.");
    error.statusCode = 404;
    throw error;
  }
  if (!verifyPassword(oldPassword, credential.password_hash)) {
    const error = new Error("Incorrect current password.");
    error.statusCode = 401;
    throw error;
  }

  await pool.request()
    .input("user_id", sql.UniqueIdentifier, userId)
    .input("password_hash", sql.NVarChar(512), hashPassword(requirePassword(newPassword)))
    .query(`
      UPDATE core.user_credentials
      SET password_hash = @password_hash,
          must_change_password = 0,
          password_changed_at = SYSUTCDATETIME()
      WHERE user_id = @user_id;
    `);
  await auditAuthChange("users.password_changed", userId, userId, { selfService: true });
}

async function importJsonUsersToDatabase(actorUserId = null) {
  if (!fs.existsSync(USERS_FILE)) {
    return { importedUsers: 0, importedRoles: 0, skipped: true };
  }

  const raw = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  const pool = await getAppPool();
  await ensureRoleSeeds(pool);

  let importedRoles = 0;
  for (const role of Array.isArray(raw.roles) ? raw.roles : []) {
    const code = normalizeRoleCode(role.code);
    const name = normalizeText(role.name || code, 200);
    if (!code || !name) continue;
    await pool.request()
      .input("role_code", sql.NVarChar(100), code)
      .input("role_name", sql.NVarChar(200), name)
      .query(`
        MERGE core.roles AS target
        USING (SELECT @role_code AS role_code, @role_name AS role_name) AS source
        ON target.role_code = source.role_code
        WHEN MATCHED THEN
          UPDATE SET role_name = source.role_name
        WHEN NOT MATCHED THEN
          INSERT (role_code, role_name)
          VALUES (source.role_code, source.role_name);
      `);
    if (code !== "admin") {
      await replaceRoleModuleAccess(pool, code, normalizeModuleAccess(role.moduleAccess, [], { applyLegacyDefault: false }), actorUserId);
    }
    importedRoles += 1;
  }

  let importedUsers = 0;
  for (const user of Array.isArray(raw.users) ? raw.users : []) {
    const username = normalizeUsername(user.username);
    if (!username || !user.passwordHash) continue;
    const userId = isGuid(user.userId) ? user.userId : crypto.randomUUID();
    await pool.request()
      .input("user_id", sql.UniqueIdentifier, userId)
      .input("username", sql.NVarChar(160), username)
      .input("display_name", sql.NVarChar(200), normalizeText(user.displayName || username, 200))
      .input("email", sql.NVarChar(260), normalizeEmail(user.email))
      .input("is_active", sql.Bit, user.isActive !== false)
      .input("password_hash", sql.NVarChar(512), user.passwordHash)
      .input("must_change_password", sql.Bit, Boolean(user.mustChangePassword))
      .query(`
        DECLARE @tenant_id uniqueidentifier;
        SELECT @tenant_id = tenant_id FROM core.tenants WHERE tenant_code = N'default';
        IF @tenant_id IS NULL
        BEGIN
          INSERT INTO core.tenants (tenant_code, tenant_name)
          VALUES (N'default', N'OptiLens Local');
          SELECT @tenant_id = tenant_id FROM core.tenants WHERE tenant_code = N'default';
        END;

        MERGE core.users AS target
        USING (
          SELECT @username AS username,
                 @user_id AS user_id,
                 @tenant_id AS tenant_id,
                 @display_name AS display_name,
                 @email AS email,
                 @is_active AS is_active
        ) AS source
        ON target.username = source.username
        WHEN MATCHED THEN
          UPDATE SET display_name = source.display_name,
                     email = source.email,
                     is_active = source.is_active,
                     updated_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (user_id, tenant_id, username, display_name, email, is_active, updated_at)
          VALUES (source.user_id, source.tenant_id, source.username, source.display_name, source.email, source.is_active, SYSUTCDATETIME());

        DECLARE @actual_user_id uniqueidentifier;
        SELECT @actual_user_id = user_id FROM core.users WHERE username = @username;

        MERGE core.user_credentials AS target
        USING (
          SELECT @actual_user_id AS user_id,
                 @password_hash AS password_hash,
                 @must_change_password AS must_change_password
        ) AS source
        ON target.user_id = source.user_id
        WHEN MATCHED THEN
          UPDATE SET password_hash = source.password_hash,
                     must_change_password = source.must_change_password,
                     failed_login_count = 0,
                     locked_until = NULL,
                     password_changed_at = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT (user_id, password_hash, must_change_password)
          VALUES (source.user_id, source.password_hash, source.must_change_password);
      `);

    const userRow = await pool.request()
      .input("username", sql.NVarChar(160), username)
      .query(`SELECT user_id FROM core.users WHERE username = @username;`);
    const roles = normalizeRoles(user.roles || []);
    await validateAssignedRoles(pool, roles);
    await replaceUserRoles(pool, userRow.recordset[0].user_id, roles.length ? roles : ["viewer"]);
    importedUsers += 1;
  }

  await auditAuthChange("users.imported_json", null, actorUserId, { importedUsers, importedRoles });
  return { importedUsers, importedRoles, skipped: false };
}

async function ensureRoleSeeds(pool) {
  await pool.request().query(`
    MERGE core.roles AS target
    USING (VALUES
      (N'admin', N'Administrator'),
      (N'viewer', N'Viewer'),
      (N'dispatcher', N'Dispatcher'),
      (N'export_shipping', N'Export and Shipping'),
      (N'pricing_manager', N'Pricing Manager')
    ) AS source (role_code, role_name)
    ON target.role_code = source.role_code
    WHEN MATCHED THEN
      UPDATE SET role_name = source.role_name
    WHEN NOT MATCHED THEN
      INSERT (role_code, role_name)
      VALUES (source.role_code, source.role_name);
  `);

  for (const [roleCode, moduleAccess] of Object.entries(DEFAULT_ROLE_ACCESS)) {
    if (roleCode === "admin") continue;
    const existing = await pool.request()
      .input("role_code", sql.NVarChar(100), roleCode)
      .query(`
        SELECT COUNT(*) AS access_count
        FROM core.role_module_access rma
        INNER JOIN core.roles r
          ON r.role_id = rma.role_id
        WHERE r.role_code = @role_code;
      `);
    if (Number(existing.recordset[0]?.access_count || 0) === 0) {
      await replaceRoleModuleAccess(pool, roleCode, moduleAccess, null);
    }
  }
}

async function rolesForUser(pool, userId) {
  const result = await pool.request()
    .input("user_id", sql.UniqueIdentifier, userId)
    .query(`
      SELECT r.role_code, r.role_name
      FROM core.user_roles ur
      INNER JOIN core.roles r
        ON r.role_id = ur.role_id
      WHERE ur.user_id = @user_id
      ORDER BY r.role_name;
    `);
  return result.recordset.map((row) => ({
    code: row.role_code,
    name: row.role_name
  }));
}

async function moduleAccessForRoles(pool, roleCodes) {
  if (!roleCodes.length) return {};
  const request = pool.request();
  const placeholders = roleCodes.map((roleCode, index) => {
    request.input(`role_${index}`, sql.NVarChar(100), roleCode);
    return `@role_${index}`;
  });
  const result = await request.query(`
    SELECT r.role_code, m.module_code, rma.access_level
    FROM core.roles r
    INNER JOIN core.role_module_access rma
      ON rma.role_id = r.role_id
    INNER JOIN core.modules m
      ON m.module_id = rma.module_id
    WHERE r.role_code IN (${placeholders.join(",")});
  `);
  const access = {};
  for (const row of result.recordset) {
    const level = normalizeAccessLevel(row.access_level);
    if (!level) continue;
    if (access[row.module_code] === "full" || level === "full") {
      access[row.module_code] = "full";
    } else {
      access[row.module_code] = "read";
    }
  }
  return access;
}

function roleMapFromRows(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.role_code)) {
      map.set(row.role_code, {
        code: row.role_code,
        name: row.role_name,
        moduleAccess: {},
        isSystem: SYSTEM_ROLE_CODES.has(row.role_code)
      });
    }
    if (row.module_code && row.access_level) {
      map.get(row.role_code).moduleAccess[row.module_code] = row.access_level;
    }
  }
  for (const [roleCode, access] of Object.entries(DEFAULT_ROLE_ACCESS)) {
    if (map.has(roleCode) && !Object.keys(map.get(roleCode).moduleAccess).length) {
      map.get(roleCode).moduleAccess = { ...access };
    }
  }
  return map;
}

async function getRole(pool, roleCode) {
  const result = await pool.request()
    .input("role_code", sql.NVarChar(100), roleCode)
    .query(`
      SELECT r.role_code, r.role_name, m.module_code, rma.access_level
      FROM core.roles r
      LEFT JOIN core.role_module_access rma
        ON rma.role_id = r.role_id
      LEFT JOIN core.modules m
        ON m.module_id = rma.module_id
      WHERE r.role_code = @role_code;
    `);
  if (!result.recordset.length) return null;
  const map = roleMapFromRows(result.recordset);
  return publicRole(map.get(roleCode));
}

async function replaceUserRoles(pool, userId, roles) {
  await pool.request()
    .input("user_id", sql.UniqueIdentifier, userId)
    .query(`DELETE FROM core.user_roles WHERE user_id = @user_id;`);

  for (const roleCode of roles) {
    await pool.request()
      .input("user_id", sql.UniqueIdentifier, userId)
      .input("role_code", sql.NVarChar(100), roleCode)
      .query(`
        INSERT INTO core.user_roles (user_id, role_id)
        SELECT @user_id, role_id
        FROM core.roles
        WHERE role_code = @role_code;
      `);
  }
}

async function replaceRoleModuleAccess(pool, roleCode, moduleAccess, actorUserId) {
  await pool.request()
    .input("role_code", sql.NVarChar(100), roleCode)
    .query(`
      DECLARE @role_id uniqueidentifier;
      SELECT @role_id = role_id FROM core.roles WHERE role_code = @role_code;
      DELETE FROM core.role_module_access WHERE role_id = @role_id;
    `);

  for (const [moduleCode, accessLevel] of Object.entries(normalizeModuleAccess(moduleAccess, [], { applyLegacyDefault: false }))) {
    await pool.request()
      .input("role_code", sql.NVarChar(100), roleCode)
      .input("module_code", sql.NVarChar(100), moduleCode)
      .input("access_level", sql.NVarChar(20), accessLevel)
      .input("assigned_by_user_id", sql.UniqueIdentifier, isGuid(actorUserId) ? actorUserId : null)
      .query(`
        INSERT INTO core.role_module_access (role_id, module_id, access_level, assigned_by_user_id)
        SELECT r.role_id, m.module_id, @access_level, @assigned_by_user_id
        FROM core.roles r
        CROSS JOIN core.modules m
        WHERE r.role_code = @role_code
          AND m.module_code = @module_code;
      `);
  }
}

async function validateAssignedRoles(pool, roles) {
  for (const roleCode of roles) {
    const result = await pool.request()
      .input("role_code", sql.NVarChar(100), roleCode)
      .query(`SELECT COUNT(*) AS role_count FROM core.roles WHERE role_code = @role_code;`);
    if (Number(result.recordset[0]?.role_count || 0) === 0) {
      const error = new Error(`Unknown or inactive role: ${roleCode}`);
      error.statusCode = 400;
      throw error;
    }
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST);
  return `${PASSWORD_PREFIX}$${PASSWORD_ITERATIONS}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password, storedHash) {
  const stored = String(storedHash || "");
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
  if (value.length < 5) {
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
    ? [...new Set(roles.map((role) => normalizeRoleCode(role)).filter(Boolean))]
    : [];
}

function normalizeModuleAccess(moduleAccess) {
  const source = moduleAccess && typeof moduleAccess === "object" && !Array.isArray(moduleAccess)
    ? moduleAccess
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

function normalizeRoleCode(value) {
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

function combineModuleAccess(...sources) {
  const combined = {};
  for (const source of sources.flat()) {
    const normalized = normalizeModuleAccess(source);
    for (const [moduleCode, level] of Object.entries(normalized)) {
      if (combined[moduleCode] === "full" || level === "full") {
        combined[moduleCode] = "full";
      } else {
        combined[moduleCode] = "read";
      }
    }
  }
  return combined;
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

function publicRole(role) {
  return {
    code: role.code,
    name: role.name,
    moduleAccess: role.moduleAccess || {},
    isSystem: Boolean(role.isSystem),
    isActive: true
  };
}

function throwInvalidLogin() {
  const error = new Error("Invalid username or password.");
  error.statusCode = 401;
  throw error;
}

function delayFailedLogin() {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

async function auditAuthChange(eventType, entityId, actorUserId, eventData) {
  try {
    await recordAuditEvent({
      actorUserId,
      eventType,
      entityType: eventType.startsWith("roles.") ? "core.roles" : "core.users",
      entityId,
      eventData
    });
  } catch {
    // Auth changes should not fail if the audit sink is temporarily unavailable.
  }
}

function isGuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function sameGuid(a, b) {
  return String(a || "").toLowerCase() === String(b || "").toLowerCase();
}

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

module.exports = {
  authenticateUser,
  bootstrapAdmin,
  changePassword,
  createRole,
  createUser,
  deleteRole,
  getBootstrapState,
  getUserAccess,
  importJsonUsersToDatabase,
  listUsers,
  MODULE_ACCESS,
  updateRole,
  updateUser
};
