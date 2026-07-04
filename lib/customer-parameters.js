const { getAppPool } = require("./db");

function normalizeAccount(account) {
  return String(account || "").trim();
}

async function getCustomerParameters(customerAccount) {
  const account = normalizeAccount(customerAccount);
  if (!account) return null;

  const pool = await getAppPool();
  const result = await pool.request()
    .input("customer_account", account)
    .query(`
      SELECT TOP (1)
        customer_commercial_param_id AS customerCommercialParamId,
        customer_account AS customerAccount,
        port_of_discharge AS portOfDischarge,
        delivery_terms AS deliveryTerms,
        bank_name AS bankName,
        bank_account_name AS bankAccountName,
        bank_account_number AS bankAccountNumber,
        bank_swift_bic AS bankSwiftBic,
        bank_routing_number AS bankRoutingNumber,
        bank_branch_address AS bankBranchAddress,
        notes,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM delivery.customer_commercial_params
      WHERE customer_account = @customer_account
    `);

  return result.recordset[0] || null;
}

async function upsertCustomerParameters(customerAccount, fields = {}, actorUserId = null) {
  const account = normalizeAccount(customerAccount);
  if (!account) {
    const error = new Error("A customer account is required to save customer parameters.");
    error.statusCode = 400;
    throw error;
  }

  const pool = await getAppPool();
  const existing = await pool.request()
    .input("customer_account", account)
    .query(`
      SELECT TOP (1) customer_commercial_param_id
      FROM delivery.customer_commercial_params
      WHERE customer_account = @customer_account
    `);

  const request = pool.request()
    .input("customer_account", account)
    .input("port_of_discharge", nullableText(fields.portOfDischarge))
    .input("delivery_terms", nullableText(fields.deliveryTerms))
    .input("bank_name", nullableText(fields.bankName))
    .input("bank_account_name", nullableText(fields.bankAccountName))
    .input("bank_account_number", nullableText(fields.bankAccountNumber))
    .input("bank_swift_bic", nullableText(fields.bankSwiftBic))
    .input("bank_routing_number", nullableText(fields.bankRoutingNumber))
    .input("bank_branch_address", nullableText(fields.bankBranchAddress))
    .input("notes", nullableText(fields.notes))
    .input("actor_user_id", actorUserId);

  if (existing.recordset.length) {
    await request
      .input("customer_commercial_param_id", existing.recordset[0].customer_commercial_param_id)
      .query(`
        UPDATE delivery.customer_commercial_params
        SET port_of_discharge = @port_of_discharge,
            delivery_terms = @delivery_terms,
            bank_name = @bank_name,
            bank_account_name = @bank_account_name,
            bank_account_number = @bank_account_number,
            bank_swift_bic = @bank_swift_bic,
            bank_routing_number = @bank_routing_number,
            bank_branch_address = @bank_branch_address,
            notes = @notes,
            updated_by_user_id = @actor_user_id,
            updated_at = SYSUTCDATETIME()
        WHERE customer_commercial_param_id = @customer_commercial_param_id
      `);
  } else {
    await request.query(`
      INSERT INTO delivery.customer_commercial_params (
        customer_account, port_of_discharge, delivery_terms,
        bank_name, bank_account_name, bank_account_number,
        bank_swift_bic, bank_routing_number, bank_branch_address,
        notes, updated_by_user_id, updated_at
      )
      VALUES (
        @customer_account, @port_of_discharge, @delivery_terms,
        @bank_name, @bank_account_name, @bank_account_number,
        @bank_swift_bic, @bank_routing_number, @bank_branch_address,
        @notes, @actor_user_id, SYSUTCDATETIME()
      )
    `);
  }

  return getCustomerParameters(account);
}

function nullableText(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

module.exports = { getCustomerParameters, upsertCustomerParameters };
