const { getAppPool } = require("./db");

async function getSetting(key) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("key", key)
    .query("SELECT setting_value FROM core.app_settings WHERE setting_key = @key");
  return result.recordset[0] ? result.recordset[0].setting_value : null;
}

async function setSetting(key, value, updatedBy = null) {
  const pool = await getAppPool();
  await pool.request()
    .input("key", key)
    .input("value", value === null || value === undefined ? null : String(value))
    .input("updatedBy", updatedBy)
    .query(`
      MERGE core.app_settings AS target
      USING (SELECT @key AS setting_key) AS source
        ON target.setting_key = source.setting_key
      WHEN MATCHED THEN
        UPDATE SET setting_value = @value, updated_at = SYSUTCDATETIME(), updated_by = @updatedBy
      WHEN NOT MATCHED THEN
        INSERT (setting_key, setting_value, updated_by)
        VALUES (@key, @value, @updatedBy);
    `);
}

module.exports = { getSetting, setSetting };
