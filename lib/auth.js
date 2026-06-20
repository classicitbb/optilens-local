const crypto = require("node:crypto");
const { getAppPool } = require("./db");
const { recordAuditEvent } = require("./audit");

const PASSWORD_ITERATIONS = 210000;
const PASSWORD_KEY_LENGTH = 32;
const PASSWORD_DIGEST = "sha256";
const PASSWORD_PREFIX = "pbkdf2-sha256";

async function getBootstrapState() {
  const pool = await getAppPool();
  const result = await pool.request().query(`
    SELECT COUNT(*) AS credential_count
    FROM core.user_credentials;
  `);

  return {
    needsBootstrap: Number(result.recordset[0]?.credential_count || 0) === 0
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
  const pool = await getAppPool();

  const result = await pool.request()
    .input("username", username)
    .input("display_name", displayName)
    .input("email", email)
    .input("password_hash", passwordHash)
    .query(`
      DECLARE @tenant_id uniqueidentifier;
      DECLARE @user_id uniqueidentifier;
      DECLARE @admin_role_id uniqueidentifier;

      SELECT @tenant_id = tenant_id
      FROM core.tenants
      WHERE tenant_code = N'default';

      IF @tenant_id IS NULL
      BEGIN
        INSERT INTO core.tenants (tenant_code, tenant_name)
        VALUES (N'default', N'OptiLens Local');
        SELECT @tenant_id = tenant_id FROM core.tenants WHERE tenant_code = N'default';
      END;

      SELECT @user_id = user_id
      FROM core.users
      WHERE username = @username;

      IF @user_id IS NULL
      BEGIN
        INSERT INTO core.users (tenant_id, username, display_name, email, is_active)
        OUTPUT inserted.user_id
        VALUES (@tenant_id, @username, @display_name, @email, 1);
      END
      ELSE
      BEGIN
        UPDATE core.users
        SET display_name = @display_name,
            email = @email,
            is_active = 1,
            updated_at = SYSUTCDATETIME()
        WHERE user_id = @user_id;

        SELECT @user_id AS user_id;
      END;
    `);

  const userId = result.recordset[0].user_id;
  await setUserPassword(userId, passwordHash, false);
  await assignRoles(userId, ["admin"]);

  await recordAuditEvent({
    moduleCode: "core",
    actorUserId: userId,
    eventType: "auth.bootstrap_admin_created",
    entityType: "core.users",
    entityId: String(userId),
    eventData: { username }
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

  const pool = await getAppPool();
  const result = await pool.request()
    .input("username", username)
    .query(`
      SELECT
        u.user_id,
        u.username,
        u.display_name,
        u.email,
        u.is_active,
        c.password_hash,
        c.failed_login_count,
        c.locked_until
      FROM core.users u
      INNER JOIN core.user_credentials c
        ON c.user_id = u.user_id
      WHERE u.username = @username;
    `);

  const row = result.recordset[0];
  if (!row || !row.is_active) {
    await delayFailedLogin();
    throwInvalidLogin();
  }

  if (row.locked_until && new Date(row.locked_until).getTime() > Date.now()) {
    const error = new Error("Account is temporarily locked. Try again later.");
    error.statusCode = 423;
    throw error;
  }

  if (!verifyPassword(password, row.password_hash)) {
    await recordFailedLogin(row.user_id, row.failed_login_count);
    await delayFailedLogin();
    throwInvalidLogin();
  }

  await pool.request()
    .input("user_id", row.user_id)
    .query(`
      UPDATE core.user_credentials
      SET failed_login_count = 0,
          locked_until = NULL,
          last_login_at = SYSUTCDATETIME()
      WHERE user_id = @user_id;
    `);

  return getUserAccess(row.user_id);
}

async function getUserAccess(userId) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("user_id", userId)
    .query(`
      SELECT
        u.user_id,
        u.username,
        u.display_name,
        u.email,
        u.is_active
      FROM core.users u
      WHERE u.user_id = @user_id;

      SELECT r.role_code, r.role_name
      FROM core.user_roles ur
      INNER JOIN core.roles r
        ON r.role_id = ur.role_id
      WHERE ur.user_id = @user_id
      ORDER BY r.role_name;

      SELECT DISTINCT p.permission_code
      FROM core.user_roles ur
      INNER JOIN core.role_permissions rp
        ON rp.role_id = ur.role_id
      INNER JOIN core.permissions p
        ON p.permission_id = rp.permission_id
      WHERE ur.user_id = @user_id
      ORDER BY p.permission_code;
    `);

  const user = result.recordsets[0][0];
  if (!user || !user.is_active) {
    const error = new Error("User is inactive or no longer exists.");
    error.statusCode = 401;
    throw error;
  }

  return {
    userId: user.user_id,
    username: user.username,
    displayName: user.display_name,
    email: user.email,
    roles: result.recordsets[1].map((row) => row.role_code),
    roleNames: result.recordsets[1].map((row) => row.role_name),
    permissions: result.recordsets[2].map((row) => row.permission_code)
  };
}

async function listUsers() {
  const pool = await getAppPool();
  const result = await pool.request().query(`
    SELECT
      u.user_id,
      u.username,
      u.display_name,
      u.email,
      u.is_active,
      u.created_at,
      u.updated_at,
      c.last_login_at,
      STRING_AGG(r.role_code, N',') WITHIN GROUP (ORDER BY r.role_code) AS roles
    FROM core.users u
    LEFT JOIN core.user_credentials c
      ON c.user_id = u.user_id
    LEFT JOIN core.user_roles ur
      ON ur.user_id = u.user_id
    LEFT JOIN core.roles r
      ON r.role_id = ur.role_id
    WHERE u.username <> N'local-dashboard'
    GROUP BY
      u.user_id,
      u.username,
      u.display_name,
      u.email,
      u.is_active,
      u.created_at,
      u.updated_at,
      c.last_login_at
    ORDER BY u.display_name, u.username;

    SELECT role_code, role_name
    FROM core.roles
    ORDER BY role_name;
  `);

  return {
    users: result.recordsets[0].map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      email: row.email,
      isActive: Boolean(row.is_active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastLoginAt: row.last_login_at,
      roles: row.roles ? row.roles.split(",").filter(Boolean) : []
    })),
    roles: result.recordsets[1].map((row) => ({
      code: row.role_code,
      name: row.role_name
    }))
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
  const result = await pool.request()
    .input("username", username)
    .input("display_name", displayName)
    .input("email", email)
    .query(`
      DECLARE @tenant_id uniqueidentifier;
      SELECT @tenant_id = tenant_id
      FROM core.tenants
      WHERE tenant_code = N'default';

      INSERT INTO core.users (tenant_id, username, display_name, email, is_active)
      OUTPUT inserted.user_id
      VALUES (@tenant_id, @username, @display_name, @email, 1);
    `);

  const userId = result.recordset[0].user_id;
  await setUserPassword(userId, passwordHash, true);
  await assignRoles(userId, roles.length ? roles : ["viewer"]);

  await recordAuditEvent({
    moduleCode: "core",
    actorUserId,
    eventType: "auth.user_created",
    entityType: "core.users",
    entityId: String(userId),
    eventData: { username, roles: roles.length ? roles : ["viewer"] }
  });

  return getUserAccess(userId);
}

async function updateUser(userId, payload, actorUserId) {
  const displayName = payload.displayName === undefined ? undefined : normalizeText(payload.displayName, 200);
  const email = payload.email === undefined ? undefined : normalizeEmail(payload.email);
  const isActive = payload.isActive === undefined ? undefined : Boolean(payload.isActive);
  const roles = payload.roles === undefined ? undefined : normalizeRoles(payload.roles);
  const pool = await getAppPool();

  await pool.request()
    .input("user_id", userId)
    .input("display_name", displayName || null)
    .input("email", email || null)
    .input("is_active", isActive === undefined ? null : isActive)
    .query(`
      UPDATE core.users
      SET display_name = COALESCE(@display_name, display_name),
          email = CASE WHEN @email IS NULL THEN email ELSE @email END,
          is_active = COALESCE(@is_active, is_active),
          updated_at = SYSUTCDATETIME()
      WHERE user_id = @user_id
        AND username <> N'local-dashboard';
    `);

  if (payload.password) {
    await setUserPassword(userId, hashPassword(requirePassword(payload.password)), true);
  }

  if (roles) {
    await assignRoles(userId, roles.length ? roles : ["viewer"]);
  }

  await recordAuditEvent({
    moduleCode: "core",
    actorUserId,
    eventType: "auth.user_updated",
    entityType: "core.users",
    entityId: String(userId),
    eventData: {
      changedDisplayName: displayName !== undefined,
      changedEmail: email !== undefined,
      changedActive: isActive !== undefined,
      changedPassword: Boolean(payload.password),
      roles
    }
  });

  return getUserAccess(userId);
}

async function setUserPassword(userId, passwordHash, mustChangePassword) {
  const pool = await getAppPool();
  await pool.request()
    .input("user_id", userId)
    .input("password_hash", passwordHash)
    .input("must_change_password", Boolean(mustChangePassword))
    .query(`
      MERGE core.user_credentials AS target
      USING (SELECT @user_id AS user_id) AS source
      ON target.user_id = source.user_id
      WHEN MATCHED THEN
        UPDATE SET password_hash = @password_hash,
                   must_change_password = @must_change_password,
                   failed_login_count = 0,
                   locked_until = NULL,
                   password_changed_at = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (user_id, password_hash, must_change_password)
        VALUES (@user_id, @password_hash, @must_change_password);
    `);
}

async function assignRoles(userId, roles) {
  const pool = await getAppPool();
  const cleanRoles = normalizeRoles(roles);

  await pool.request()
    .input("user_id", userId)
    .query(`
      DELETE FROM core.user_roles
      WHERE user_id = @user_id;
    `);

  for (const role of cleanRoles) {
    await pool.request()
      .input("user_id", userId)
      .input("role_code", role)
      .query(`
        INSERT INTO core.user_roles (user_id, role_id)
        SELECT @user_id, role_id
        FROM core.roles
        WHERE role_code = @role_code;
      `);
  }
}

async function recordFailedLogin(userId, failedLoginCount) {
  const nextCount = Number(failedLoginCount || 0) + 1;
  const lockMinutes = nextCount >= 5 ? 15 : 0;
  const pool = await getAppPool();

  await pool.request()
    .input("user_id", userId)
    .input("lock_minutes", lockMinutes)
    .query(`
      UPDATE core.user_credentials
      SET failed_login_count = failed_login_count + 1,
          locked_until = CASE
            WHEN @lock_minutes > 0 THEN DATEADD(minute, @lock_minutes, SYSUTCDATETIME())
            ELSE locked_until
          END
      WHERE user_id = @user_id;
    `);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, PASSWORD_ITERATIONS, PASSWORD_KEY_LENGTH, PASSWORD_DIGEST);
  return `${PASSWORD_PREFIX}$${PASSWORD_ITERATIONS}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || "").split("$");
  if (parts.length !== 4 || parts[0] !== PASSWORD_PREFIX) return false;

  const iterations = Number(parts[1]);
  const salt = Buffer.from(parts[2], "base64");
  const expected = Buffer.from(parts[3], "base64");
  const actual = crypto.pbkdf2Sync(password, salt, iterations, expected.length, PASSWORD_DIGEST);

  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function requirePassword(password) {
  const value = String(password || "");
  if (value.length < 10) {
    const error = new Error("Password must be at least 10 characters.");
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

function throwInvalidLogin() {
  const error = new Error("Invalid username or password.");
  error.statusCode = 401;
  throw error;
}

function delayFailedLogin() {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

module.exports = {
  authenticateUser,
  bootstrapAdmin,
  createUser,
  getBootstrapState,
  getUserAccess,
  listUsers,
  updateUser
};
