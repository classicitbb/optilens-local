const { getAppPool } = require("./db");
const { recordAuditEvent } = require("./audit");

async function listPricingRules() {
  const pool = await getAppPool();
  const result = await pool.request().query(`
    SELECT
      pricing_rule_id,
      rule_code,
      rule_name,
      customer_account,
      product_code,
      base_price,
      markup_percent,
      fixed_adjustment,
      min_price,
      max_price,
      rounding_increment,
      priority,
      is_active,
      effective_from,
      effective_to,
      created_at,
      updated_at
    FROM pricing.price_rules
    ORDER BY is_active DESC, priority ASC, rule_name ASC
  `);

  return result.recordset;
}

async function createPricingRule(payload, actorUserId = null) {
  const data = normalizeRulePayload(payload);
  if (!data.ruleName) {
    const error = new Error("Rule name is required.");
    error.statusCode = 400;
    throw error;
  }

  const pool = await getAppPool();
  const result = await pool.request()
    .input("rule_code", data.ruleCode)
    .input("rule_name", data.ruleName)
    .input("customer_account", data.customerAccount)
    .input("product_code", data.productCode)
    .input("base_price", data.basePrice)
    .input("markup_percent", data.markupPercent)
    .input("fixed_adjustment", data.fixedAdjustment)
    .input("min_price", data.minPrice)
    .input("max_price", data.maxPrice)
    .input("rounding_increment", data.roundingIncrement)
    .input("priority", data.priority)
    .query(`
      INSERT INTO pricing.price_rules (
        rule_code,
        rule_name,
        customer_account,
        product_code,
        base_price,
        markup_percent,
        fixed_adjustment,
        min_price,
        max_price,
        rounding_increment,
        priority
      )
      OUTPUT inserted.*
      VALUES (
        @rule_code,
        @rule_name,
        @customer_account,
        @product_code,
        @base_price,
        @markup_percent,
        @fixed_adjustment,
        @min_price,
        @max_price,
        @rounding_increment,
        @priority
      )
    `);

  const rule = result.recordset[0];
  await recordAuditEvent({
    moduleCode: "pricing-automation",
    actorUserId,
    eventType: "pricing.rule_created",
    entityType: "pricing.price_rules",
    entityId: String(rule.pricing_rule_id),
    eventData: {
      ruleCode: rule.rule_code,
      ruleName: rule.rule_name,
      customerAccount: rule.customer_account,
      productCode: rule.product_code
    }
  });

  return rule;
}

async function calculatePrice(payload, actorUserId = null) {
  const request = normalizeCalculationPayload(payload);
  const rules = await findCandidateRules(request);
  const selectedRule = rules[0] || null;
  const inputPrice = request.inputPrice ?? selectedRule?.base_price ?? 0;
  const markupPercent = request.overrideMarkupPercent ?? selectedRule?.markup_percent ?? 0;
  const fixedAdjustment = request.overrideFixedAdjustment ?? selectedRule?.fixed_adjustment ?? 0;
  const minPrice = selectedRule?.min_price;
  const maxPrice = selectedRule?.max_price;
  const roundingIncrement = selectedRule?.rounding_increment ?? 0.01;
  const calculatedPrice = applyPriceRule({
    inputPrice,
    markupPercent,
    fixedAdjustment,
    minPrice,
    maxPrice,
    roundingIncrement
  });

  const pool = await getAppPool();
  const result = await pool.request()
    .input("pricing_rule_id", selectedRule?.pricing_rule_id || null)
    .input("customer_account", request.customerAccount)
    .input("product_code", request.productCode)
    .input("source_reference", request.sourceReference)
    .input("input_price", inputPrice)
    .input("calculated_price", calculatedPrice)
    .input("explanation_json", JSON.stringify({
      ruleCode: selectedRule?.rule_code || null,
      inputPrice,
      markupPercent,
      fixedAdjustment,
      minPrice,
      maxPrice,
      roundingIncrement
    }))
    .query(`
      INSERT INTO pricing.price_calculations (
        pricing_rule_id,
        customer_account,
        product_code,
        source_reference,
        input_price,
        calculated_price,
        explanation_json
      )
      OUTPUT inserted.*
      VALUES (
        @pricing_rule_id,
        @customer_account,
        @product_code,
        @source_reference,
        @input_price,
        @calculated_price,
        @explanation_json
      )
    `);

  const calculation = result.recordset[0];
  await recordAuditEvent({
    moduleCode: "pricing-automation",
    actorUserId,
    eventType: "pricing.calculated",
    entityType: "pricing.price_calculations",
    entityId: String(calculation.price_calculation_id),
    eventData: {
      ruleId: selectedRule?.pricing_rule_id || null,
      customerAccount: request.customerAccount,
      productCode: request.productCode,
      inputPrice,
      calculatedPrice
    }
  });

  return {
    calculation,
    selectedRule,
    candidates: rules
  };
}

async function listPriceCalculations() {
  const pool = await getAppPool();
  const result = await pool.request().query(`
    SELECT TOP (100)
      c.price_calculation_id,
      c.pricing_rule_id,
      r.rule_name,
      c.customer_account,
      c.product_code,
      c.source_reference,
      c.input_price,
      c.calculated_price,
      c.explanation_json,
      c.created_at
    FROM pricing.price_calculations c
    LEFT JOIN pricing.price_rules r
      ON r.pricing_rule_id = c.pricing_rule_id
    ORDER BY c.created_at DESC, c.price_calculation_id DESC
  `);

  return result.recordset;
}

async function findCandidateRules(request) {
  const pool = await getAppPool();
  const result = await pool.request()
    .input("customer_account", request.customerAccount)
    .input("product_code", request.productCode)
    .query(`
      SELECT TOP (10)
        pricing_rule_id,
        rule_code,
        rule_name,
        customer_account,
        product_code,
        base_price,
        markup_percent,
        fixed_adjustment,
        min_price,
        max_price,
        rounding_increment,
        priority
      FROM pricing.price_rules
      WHERE is_active = 1
        AND (effective_from IS NULL OR effective_from <= SYSUTCDATETIME())
        AND (effective_to IS NULL OR effective_to >= SYSUTCDATETIME())
        AND (customer_account IS NULL OR customer_account = @customer_account)
        AND (product_code IS NULL OR product_code = @product_code)
      ORDER BY
        CASE WHEN customer_account = @customer_account THEN 0 ELSE 1 END,
        CASE WHEN product_code = @product_code THEN 0 ELSE 1 END,
        priority ASC,
        created_at DESC
    `);

  return result.recordset;
}

function applyPriceRule({ inputPrice, markupPercent, fixedAdjustment, minPrice, maxPrice, roundingIncrement }) {
  let value = Number(inputPrice || 0);
  value += value * (Number(markupPercent || 0) / 100);
  value += Number(fixedAdjustment || 0);

  if (minPrice !== null && minPrice !== undefined) value = Math.max(value, Number(minPrice));
  if (maxPrice !== null && maxPrice !== undefined) value = Math.min(value, Number(maxPrice));

  const increment = Number(roundingIncrement || 0.01);
  if (increment > 0) {
    value = Math.round(value / increment) * increment;
  }

  return Number(value.toFixed(2));
}

function normalizeRulePayload(payload) {
  const ruleName = valueOrNull(payload.ruleName, 200);
  const baseRuleCode = valueOrNull(payload.ruleCode, 120);
  return {
    ruleCode: baseRuleCode || `${slugify(ruleName || "rule")}-${Date.now().toString(36)}`.slice(0, 120),
    ruleName,
    customerAccount: valueOrNull(payload.customerAccount, 120),
    productCode: valueOrNull(payload.productCode, 120),
    basePrice: decimalOrNull(payload.basePrice),
    markupPercent: decimalOrDefault(payload.markupPercent, 0),
    fixedAdjustment: decimalOrDefault(payload.fixedAdjustment, 0),
    minPrice: decimalOrNull(payload.minPrice),
    maxPrice: decimalOrNull(payload.maxPrice),
    roundingIncrement: decimalOrDefault(payload.roundingIncrement, 0.01),
    priority: integerOrDefault(payload.priority, 100)
  };
}

function normalizeCalculationPayload(payload) {
  return {
    customerAccount: valueOrNull(payload.customerAccount, 120),
    productCode: valueOrNull(payload.productCode, 120),
    sourceReference: valueOrNull(payload.sourceReference, 200),
    inputPrice: decimalOrNull(payload.inputPrice),
    overrideMarkupPercent: decimalOrNull(payload.overrideMarkupPercent),
    overrideFixedAdjustment: decimalOrNull(payload.overrideFixedAdjustment)
  };
}

function decimalOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function decimalOrDefault(value, fallback) {
  const number = decimalOrNull(value);
  return number === null ? fallback : number;
}

function integerOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function valueOrNull(value, maxLength) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : null;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120) || `rule-${Date.now()}`;
}

module.exports = {
  calculatePrice,
  createPricingRule,
  listPriceCalculations,
  listPricingRules
};
