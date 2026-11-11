/**
 * innovations-pricing-mirror.js — read-only mirror of the Innovations pricing
 * entities into Supabase `inn_*` tables (via the innovations-sync edge function).
 *
 * Phase 1 of the Innovations <-> website pricing spec. NOTHING here writes to
 * Innovations: every query is a plain SELECT run READ UNCOMMITTED on the source
 * pool. Entities are opt-in only (not in DEFAULT_ENTITY_ORDER), so the hourly
 * scheduled sync never touches them.
 *
 * One spec per entity drives three things so they cannot drift apart:
 *   - the source SELECT + row mapper (this file),
 *   - the receiver allowlist (supabase/functions/innovations-sync/index.ts),
 *   - the Supabase DDL (supabase/migrations/20261110170000_inn_pricing_mirror_tables.sql).
 * `scripts/innovations-pricing-spec.js --check` verifies this file against the
 * receiver allowlist.
 *
 * Change detection: every Innovations pricing table carries LastUpdated, so an
 * incremental run reads `LastUpdated > watermark - overlap`. The watermark only
 * advances after a COMMITTED run whose every batch was accepted. `--full` (or no
 * watermark yet) reads everything. A per-row `source_hash` (sha256 of the mapped
 * content, excluding volatile columns) is sent with each row; the database stamps
 * `source_changed_at` only when the hash really changes.
 *
 * Off rows stay as rows. The Innovations "inactive" bit is `(Flags & 2) <> 0`;
 * it is kept raw in `flags`. Lens items are mirrored for the ACTIVE PATH only
 * (item and every ancestor ON); an item that later falls off the path is re-sent
 * with on_active_path = false, never deleted. Hard deletes in Innovations are not
 * propagated (see runbook: stale rows are those with an old last_synced_at after
 * a full commit).
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = process.env.OPTILENS_PRICING_MIRROR_STATE_FILE
  || path.join(__dirname, '..', 'data', 'innovations-pricing-mirror-state.json');
// Re-read this much before the stored watermark so a row committed while the
// previous run was reading is never skipped. Upserts are idempotent.
const WATERMARK_OVERLAP_MS = Number(process.env.OPTILENS_PRICING_MIRROR_OVERLAP_MINUTES ?? 10) * 60 * 1000;
const INVOICE_LINES_FROM = /^\d{4}-\d{2}-\d{2}$/.test(process.env.OPTILENS_PRICING_MIRROR_INVOICES_FROM || '')
  ? process.env.OPTILENS_PRICING_MIRROR_INVOICES_FROM
  : '2026-01-01';
const MIRROR_BATCH_SIZE = 1000; // receiver MAX_RECORDS_PER_REQUEST

// Column types: i integer, s smallint, g bigint, m money->numeric, f float, t text, b boolean, d timestamptz
// Column tuple: [sourceColumn, targetColumn, type]  (source is prefixed with the entity alias)
const c = (src, dest, type) => [src, dest, type];

// Hierarchy key columns appear on many tables under different names. Targets are fixed.
const H = { group: 'group_num', material: 'material_num', mf: 'mf_num', lens: 'lens_type_num', option: 'option_num' };

const ON_PATH_EXPR = `CASE WHEN lo.LensOptionID IS NOT NULL AND lt.LensTypeID IS NOT NULL AND mt.MFTypeID IS NOT NULL
        AND ma.MaterialID IS NOT NULL AND mg.MaterialGroupID IS NOT NULL
        AND (ISNULL(t.Flags,0) & 2) = 0 AND (ISNULL(lo.Flags,0) & 2) = 0 AND (ISNULL(lt.Flags,0) & 2) = 0
        AND (ISNULL(mt.Flags,0) & 2) = 0 AND (ISNULL(ma.Flags,0) & 2) = 0 AND (ISNULL(mg.Flags,0) & 2) = 0
        THEN 1 ELSE 0 END`;

const LENS_ITEM_CHAIN = `dbo.LensItem t
      {J} dbo.LensOptions lo ON lo.Groupnum = t.MaterialGroup AND lo.Matlnum = t.Material AND lo.MFnum = t.MFType AND lo.Lnum = t.LensType AND lo.Num = t.[Option]
      {J} dbo.LensType lt ON lt.Groupnum = lo.Groupnum AND lt.Matlnum = lo.Matlnum AND lt.MFnum = lo.MFnum AND lt.Lnum = lo.Lnum
      {J} dbo.MFTypes mt ON mt.GroupNum = lo.Groupnum AND mt.MtrlNum = lo.Matlnum AND mt.MFNum = lo.MFnum
      {J} dbo.Materials ma ON ma.GroupNum = lo.Groupnum AND ma.MtrlNum = lo.Matlnum
      {J} dbo.MaterialGroup mg ON mg.Groupnum = lo.Groupnum`;

// pk: target name of the immutable Innovations id (the receiver conflict key).
// fromSql: string, or function(full) for entities whose join type depends on the run mode.
// lastUpdated: SQL expression for the change-detection column(s).
const SPECS = [
  { name: 'inn_price_lists', pk: 'price_list_id', from: 'dbo.PriceLists t', cols: [
    c('PriceListID', 'price_list_id', 'i'), c('PriceListPID', 'parent_price_list_id', 'i'), c('PriceListName', 'price_list_name', 't'),
    c('Code', 'code', 't'), c('PricelistGroup', 'price_list_group', 'i'), c('CurrencyID', 'currency_id', 'i'), c('IsActive', 'is_active', 'b'),
    c('ActiveStartDate', 'active_start_date', 'd'), c('ActiveEndDate', 'active_end_date', 'd'),
    c('CostPlusPricing', 'cost_plus_pricing', 'b'), c('CostPlusType', 'cost_plus_type', 's'), c('CostPlusPercent', 'cost_plus_percent', 'm'), c('CostPlusAmount', 'cost_plus_amount', 'm'),
    c('DiscountPricelist', 'discount_pricelist', 'b'), c('DiscountPercent', 'discount_percent', 'm'),
    c('EdgingCharge', 'edging_charge', 'm'), c('FlatEdgingCharge', 'flat_edging_charge', 'b'), c('EnabledDecimals', 'enabled_decimals', 'b'), c('NumDecimals', 'num_decimals', 's'),
    c('UseStockPrice', 'use_stock_price', 'b'), c('UseRxIfNoStockPrice', 'use_rx_if_no_stock_price', 'b'), c('IncludePowerRx', 'include_power_rx', 'b'), c('IncludePowerStock', 'include_power_stock', 'b'),
    c('PowerOverStd', 'power_over_std', 'b'), c('RuleBasedSelection', 'rule_based_selection', 'b'), c('RulePriority', 'rule_priority', 'i'), c('AndRule', 'and_rule', 'b'),
    c('ApplyFreightCharges', 'apply_freight_charges', 'b'), c('PriceEdgingOnFarmout', 'price_edging_on_farmout', 'b'), c('SuppressZeroFreight', 'suppress_zero_freight', 'b'),
    c('SuppressZeroLines', 'suppress_zero_lines', 'i'), c('PromptUseStockFlags', 'prompt_use_stock_flags', 'i'), c('PromptUseStockPrice', 'prompt_use_stock_price', 'b'),
    c('GenPricingError', 'gen_pricing_error', 'i'), c('InvoiceTypeID', 'invoice_type_id', 'i'),
  ] },
  { name: 'inn_rx_pos_sheets', pk: 'price_rx_pos_sheet_id', from: 'dbo.PriceRxPOSSheets t', cols: [
    c('PriceRxPOSSheetID', 'price_rx_pos_sheet_id', 'i'), c('PriceListID', 'price_list_id', 'i'), c('PriceRxPOSSheetName', 'sheet_name', 't'), c('RetailName', 'retail_name', 't'),
    c('PricesheetType', 'pricesheet_type', 's'), c('GridLayout', 'grid_layout', 's'), c('IsActive', 'is_active', 'b'), c('IsDiscount', 'is_discount', 'b'),
    c('ModifierValue', 'modifier_value', 'm'), c('Price', 'price', 'm'), c('ihPrice', 'ih_price', 'b'), c('Edged', 'edged', 'b'), c('Uncut', 'uncut', 'b'),
    c('EdgingCharge', 'edging_charge', 'm'), c('FlatEdgingCharge', 'flat_edging_charge', 'b'), c('UseEdgingPriceList', 'use_edging_price_list', 'b'),
    c('PricePOSChargeID', 'price_pos_charge_id', 'i'), c('GLAccountID', 'gl_account_id', 'i'),
  ] },
  { name: 'inn_rx_pos_members', pk: 'price_rx_pos_member_id', from: 'dbo.PriceRxPOSMembers t', cols: [
    c('PriceRxPOSMemberID', 'price_rx_pos_member_id', 'i'), c('PriceListID', 'price_list_id', 'i'), c('PriceRxPOSSheetID', 'price_rx_pos_sheet_id', 'i'),
    c('PriceLensGroupID', 'price_lens_group_id', 'i'), c('Edged', 'edged', 's'), c('Uncut', 'uncut', 's'),
  ] },
  { name: 'inn_rx_pos_items', pk: 'price_rx_pos_item_id', from: 'dbo.PriceRxPOSItems t', cols: [
    c('PriceRxPOSItemID', 'price_rx_pos_item_id', 'i'), c('PriceRxPOSSheetID', 'price_rx_pos_sheet_id', 'i'), c('PriceLensGroupID', 'price_lens_group_id', 'i'),
    c('MaterialGroupNum', 'material_group_num', 'i'), c('MaterialNum', 'material_num', 'i'), c('MFTypeNum', 'mf_type_num', 'i'), c('LensTypeNum', 'lens_type_num', 'i'), c('LensOptionNum', 'lens_option_num', 'i'),
    c('MinSphere', 'min_sphere', 's'), c('MaxSphere', 'max_sphere', 's'), c('MinCylinder', 'min_cylinder', 's'), c('MaxCylinder', 'max_cylinder', 's'),
    c('Price', 'price', 'm'), c('ihPrice', 'ih_price', 'b'), c('ModifierType', 'modifier_type', 's'), c('ModifierValue', 'modifier_value', 'm'), c('ModifierIsDiscount', 'modifier_is_discount', 'b'),
    c('POSDiopterPrice', 'pos_diopter_price', 'm'), c('POSDiopterValue', 'pos_diopter_value', 'm'), c('POSChargeID', 'pos_charge_id', 'i'), c('RetailName', 'retail_name', 't'), c('InvoiceTypeID', 'invoice_type_id', 'i'),
  ] },
  { name: 'inn_price_lens_groups', pk: 'price_lens_group_id', from: 'dbo.PriceLensGroups t', cols: [
    c('PriceLensGroupID', 'price_lens_group_id', 'i'), c('PriceLensGroupName', 'price_lens_group_name', 't'), c('Code', 'code', 't'), c('Flags', 'flags', 'i'), c('IsActive', 'is_active', 'b'),
  ] },
  { name: 'inn_stock_lenses', pk: 'price_stock_lens_id', from: 'dbo.PriceStockLenses t', cols: [
    c('PriceStockLensID', 'price_stock_lens_id', 'i'), c('PriceListID', 'price_list_id', 'i'), c('PriceLensGroupID', 'price_lens_group_id', 'i'),
    c('PriceStockLensName', 'stock_lens_name', 't'), c('RetailName', 'retail_name', 't'), c('PricesheetType', 'pricesheet_type', 's'), c('GridLayout', 'grid_layout', 's'),
    c('IsActive', 'is_active', 'b'), c('IsDiscount', 'is_discount', 'b'), c('ModifierValue', 'modifier_value', 'm'),
  ] },
  { name: 'inn_stock_lens_items', pk: 'price_stock_lens_item_id', from: 'dbo.PriceStockLensItems t', cols: [
    c('PriceStockLensItemID', 'price_stock_lens_item_id', 'i'), c('PriceStockLensID', 'price_stock_lens_id', 'i'), c('VendorID', 'vendor_id', 'i'),
    c('MaterialGroupNum', 'material_group_num', 'i'), c('MaterialNum', 'material_num', 'i'), c('MFTypeNum', 'mf_type_num', 'i'), c('LensTypeNum', 'lens_type_num', 'i'), c('LensOptionNum', 'lens_option_num', 'i'),
    c('Sphere', 'sphere', 's'), c('Cylinder', 'cylinder', 's'), c('Diameter', 'diameter', 's'),
    c('Price', 'price', 'm'), c('ihPrice', 'ih_price', 'b'), c('ModifierType', 'modifier_type', 's'), c('ModifierValue', 'modifier_value', 'm'), c('ModifierIsDiscount', 'modifier_is_discount', 'b'),
    c('RetailName', 'retail_name', 't'), c('InvoiceTypeID', 'invoice_type_id', 'i'),
  ] },
  { name: 'inn_stock_vendors', pk: 'price_stock_vendor_id', from: 'dbo.PriceStockVendors t', cols: [
    c('PriceStockVendorID', 'price_stock_vendor_id', 'i'), c('PriceStockLensID', 'price_stock_lens_id', 'i'), c('VendorID', 'vendor_id', 'i'),
  ] },
  { name: 'inn_packages', pk: 'package_id', from: 'dbo.Packages t', cols: [
    c('PackageID', 'package_id', 'i'), c('PackageName', 'package_name', 't'), c('SKU', 'sku', 't'), c('IsActive', 'is_active', 'b'), c('Priority', 'priority', 'i'),
    c('ActiveStartDate', 'active_start_date', 'd'), c('ActiveEndDate', 'active_end_date', 'd'),
    c('AndMiscInclusion', 'and_misc_inclusion', 'b'), c('AndRuleExclusion', 'and_rule_exclusion', 'b'), c('AndRuleInclusion', 'and_rule_inclusion', 'b'),
    c('PowerOverStd', 'power_over_std', 'b'), c('SuppressLines', 'suppress_lines', 'i'),
  ] },
  { name: 'inn_package_items', pk: 'package_item_id', from: 'dbo.PackageItems t', cols: [
    c('PackageItemID', 'package_item_id', 'i'), c('PackageID', 'package_id', 'i'), c('ItemType', 'item_type', 'i'), c('Exclusion', 'exclusion', 'b'),
    c('ID01', 'id01', 'i'), c('ID02', 'id02', 'i'), c('ID03', 'id03', 'i'), c('ID04', 'id04', 'i'), c('ID05', 'id05', 'i'), c('ID06', 'id06', 'i'),
  ] },
  // Not in the original list but required: price_package_members/items point at it.
  { name: 'inn_price_packages', pk: 'price_package_id', from: 'dbo.PricePackages t', cols: [
    c('PricePackageID', 'price_package_id', 'i'), c('PriceListID', 'price_list_id', 'i'), c('PricePackageName', 'price_package_name', 't'), c('RetailName', 'retail_name', 't'),
    c('Price', 'price', 'm'), c('ModifierValue', 'modifier_value', 'm'), c('IsActive', 'is_active', 'b'), c('IsDiscount', 'is_discount', 'b'),
    c('Flags', 'flags', 'i'), c('InvoiceFlags', 'invoice_flags', 'i'), c('PricesheetType', 'pricesheet_type', 's'), c('ihPrice', 'ih_price', 'b'),
  ] },
  { name: 'inn_price_package_members', pk: 'price_package_member_id', from: 'dbo.PricePackageMembers t', cols: [
    c('PricePackageMemberID', 'price_package_member_id', 'i'), c('PackageID', 'package_id', 'i'), c('PriceListID', 'price_list_id', 'i'), c('PricePackageID', 'price_package_id', 'i'),
  ] },
  { name: 'inn_price_package_items', pk: 'price_package_item_id', from: 'dbo.PricePackageItems t', cols: [
    c('PricePackageItemID', 'price_package_item_id', 'i'), c('PackageID', 'package_id', 'i'), c('PricePackageID', 'price_package_id', 'i'),
    c('Price', 'price', 'm'), c('RetailName', 'retail_name', 't'), c('ihPrice', 'ih_price', 'b'), c('ihRetailName', 'ih_retail_name', 'b'),
  ] },
  // Labs: join LabExtras.LabID = Labs.num (NOT Labs.LabID) — see docs/pricing/00-landscape.md.
  { name: 'inn_labs', pk: 'lab_num', from: 'dbo.Labs t', cols: [
    c('num', 'lab_num', 's'), c('LabID', 'lab_id', 'i'), c('Name', 'name', 't'), c('abbr', 'abbr', 't'), c('flag', 'flags', 's'), c('Flag2', 'flags2', 's'), c('POSupplierID', 'po_supplier_id', 'i'),
  ] },
  // Explicit allowlist: dbo.LabExtras also holds AWS keys, Gatekeeper JWT secrets and PIN codes. Never add those.
  { name: 'inn_lab_extras', pk: 'lab_extra_id', from: 'dbo.LabExtras t', cols: [
    c('LabExtraID', 'lab_extra_id', 'i'), c('LabID', 'lab_num', 'i'), c('PricelistID', 'price_list_id', 'i'), c('LocalLab', 'local_lab', 's'), c('Taxable', 'taxable', 'b'), c('DestinationFormat', 'destination_format', 'i'),
  ] },
  { name: 'inn_currencies', pk: 'currency_id', from: 'dbo.Currencies t', cols: [
    c('CurrencyID', 'currency_id', 'i'), c('CurrencyName', 'currency_name', 't'), c('Symbol', 'symbol', 't'), c('CurrentExchangeRate', 'current_exchange_rate', 'f'), c('DecimalPlaces', 'decimal_places', 's'),
  ] },
  { name: 'inn_material_groups', pk: 'material_group_id', from: 'dbo.MaterialGroup t', cols: [
    c('MaterialGroupID', 'material_group_id', 'i'), c('Groupnum', H.group, 's'), c('Name', 'name', 't'), c('Abbrev', 'abbrev', 't'),
    c('Flags', 'flags', 's'), c('Settings', 'settings', 's'), c('JEDefault', 'je_default', 'b'),
  ] },
  { name: 'inn_materials', pk: 'material_id', from: 'dbo.Materials t', cols: [
    c('MaterialID', 'material_id', 'i'), c('MaterialGroupID', 'material_group_id', 'i'), c('GroupNum', H.group, 's'), c('MtrlNum', H.material, 's'),
    c('Name', 'name', 't'), c('Abbrev', 'abbrev', 't'), c('RefractiveIndex', 'refractive_index', 'f'), c('Flags', 'flags', 's'), c('Settings', 'settings', 's'),
  ] },
  { name: 'inn_mf_types', pk: 'mf_type_id', from: 'dbo.MFTypes t', cols: [
    c('MFTypeID', 'mf_type_id', 'i'), c('MaterialID', 'material_id', 'i'), c('GroupNum', H.group, 's'), c('MtrlNum', H.material, 's'), c('MFNum', H.mf, 's'),
    c('Name', 'name', 't'), c('Abbrev', 'abbrev', 't'), c('Flags', 'flags', 's'), c('Settings', 'settings', 's'),
  ] },
  { name: 'inn_lens_types', pk: 'lens_type_id', from: 'dbo.LensType t', cols: [
    c('LensTypeID', 'lens_type_id', 'i'), c('MFTypeID', 'mf_type_id', 'i'), c('Groupnum', H.group, 's'), c('Matlnum', H.material, 's'), c('MFnum', H.mf, 's'), c('Lnum', H.lens, 's'),
    c('Name', 'name', 't'), c('Abbrev', 'abbrev', 't'), c('Code', 'code', 's'), c('Flags', 'flags', 's'), c('Settings', 'settings', 's'),
  ] },
  { name: 'inn_lens_options', pk: 'lens_option_id', from: 'dbo.LensOptions t', cols: [
    c('LensOptionID', 'lens_option_id', 'i'), c('LensTypeID', 'lens_type_id', 'i'),
    c('Groupnum', H.group, 's'), c('Matlnum', H.material, 's'), c('MFnum', H.mf, 's'), c('Lnum', H.lens, 's'), c('Num', H.option, 'i'),
    c('Name', 'name', 't'), c('Abbrev', 'abbrev', 't'), c('Lab', 'lab', 's'), c('Price1', 'price1', 'f'), c('Cost', 'cost', 'f'),
    c('PriceChart', 'price_chart', 's'), c('BillCode', 'bill_code', 't'), c('AddGroup', 'add_group', 's'),
    c('Flags', 'flags', 's'), c('Flags2', 'flags2', 's'), c('Settings', 'settings', 's'),
  ] },
  // Active path only. Full run: item and every ancestor ON (inner joins). Incremental run: any changed
  // item or ancestor, with on_active_path computed, so an item that dropped off the path is re-sent as false.
  { name: 'inn_lens_items', pk: 'lens_item_id',
    from: (full) => LENS_ITEM_CHAIN.replace(/\{J\}/g, full ? 'INNER JOIN' : 'LEFT JOIN'),
    where: (full) => (full
      ? `(ISNULL(t.Flags,0) & 2) = 0 AND (ISNULL(lo.Flags,0) & 2) = 0 AND (ISNULL(lt.Flags,0) & 2) = 0 AND (ISNULL(mt.Flags,0) & 2) = 0 AND (ISNULL(ma.Flags,0) & 2) = 0 AND (ISNULL(mg.Flags,0) & 2) = 0`
      : null),
    lastUpdated: ['t.LastUpdated', 'lo.LastUpdated', 'lt.LastUpdated', 'mt.LastUpdated', 'ma.LastUpdated', 'mg.LastUpdated'],
    cols: [
      c('LensItemID', 'lens_item_id', 'i'), c('LensOptionID', 'lens_option_id', 'i'),
      c('MaterialGroup', H.group, 's'), c('Material', H.material, 's'), c('MFType', H.mf, 's'), c('LensType', H.lens, 's'), c('[Option]', H.option, 'i'), c('Num', 'item_num', 'i'),
      c('Name', 'name', 't'), c('Manufacturer', 'manufacturer', 's'), c('Fin_Semi', 'fin_semi', 's'),
      c('Diameter', 'diameter', 's'), c('Base_Sphere', 'base_sphere', 's'), c('Add_Cyl', 'add_cyl', 's'),
      c('Price1', 'price1', 'm'), c('Cost', 'cost', 'm'), c('ReorderCost', 'reorder_cost', 'm'),
      c('Flags', 'flags', 's'), c('Flags2', 'flags2', 's'),
      { expr: ON_PATH_EXPR, dest: 'on_active_path', type: 'b' },
    ] },
  { name: 'inn_lens_alias', pk: 'lens_alias_id', from: 'dbo.LensAlias t', cols: [
    c('LensAliasID', 'lens_alias_id', 'i'), c('Alias', 'alias', 't'), c('LensOptionID', 'lens_option_id', 'i'),
    c('GroupNum', H.group, 's'), c('MtrlNum', H.material, 's'), c('MFNum', H.mf, 's'), c('LNum', H.lens, 's'), c('OptNum', H.option, 'i'),
  ] },
  // Customers.PriceListID plus the per-category overrides (docs: findings 2026-10-29 §1.3).
  { name: 'inn_customer_price_list', pk: 'customer_id', from: 'dbo.Customers t', cols: [
    c('CustomerID', 'customer_id', 'i'), c('AccountNumber', 'account_number', 't'), c('CustomerName', 'customer_name', 't'), c('IsActive', 'is_active', 'b'),
    c('PriceListID', 'price_list_id', 'i'), c('RxEdgedPricelistID', 'rx_edged_price_list_id', 'i'), c('RxUncutPricelistID', 'rx_uncut_price_list_id', 'i'),
    c('FinEdgedPricelistID', 'fin_edged_price_list_id', 'i'), c('FinUncutPricelistID', 'fin_uncut_price_list_id', 'i'), c('StockLensPricelistID', 'stock_lens_price_list_id', 'i'),
    c('PackagePricelistID', 'package_price_list_id', 'i'), c('MiscItemPricelistID', 'misc_item_price_list_id', 'i'), c('FramePricelistID', 'frame_price_list_id', 'i'),
    c('FreightPricelistID', 'freight_price_list_id', 'i'), c('AddPricelistID', 'add_price_list_id', 'i'), c('OSPricelistID', 'os_price_list_id', 'i'),
    c('PrismPricelistID', 'prism_price_list_id', 'i'), c('SpecialPriceListID', 'special_price_list_id', 'i'),
  ] },
  // Not in the original list; needed by reconciliation (c). Lens lines (CategoryType 1) on invoices from
  // INVOICE_LINES_FROM. Product description text only; no patient fields are selected.
  { name: 'inn_invoice_lines', pk: 'invoice_line_id',
    from: 'dbo.InvoiceLines t INNER JOIN dbo.Invoices inv ON inv.InvoiceID = t.InvoiceID',
    where: () => `inv.InvoiceTime >= '${INVOICE_LINES_FROM}' AND t.CategoryType = 1`,
    cols: [
      c('InvoiceLineID', 'invoice_line_id', 'i'), c('InvoiceID', 'invoice_id', 'i'), { expr: 'inv.CustomerID', dest: 'customer_id', type: 'i' },
      { expr: 'inv.InvoiceTime', dest: 'invoice_time', type: 'd' }, c('PriceListID', 'price_list_id', 'i'), c('PriceListName', 'price_list_name', 't'),
      c('PriceGroupID', 'price_group_id', 'i'), c('PackageID', 'package_id', 'i'), c('CategoryType', 'category_type', 's'), c('Suppressed', 'suppressed', 'b'),
      c('Quantity', 'quantity', 'f'), c('PriceListPrice', 'price_list_price', 'm'), c('InvoicePrice', 'invoice_price', 'm'), c('CostPrice', 'cost_price', 'm'),
      c('Description', 'description', 't'), c('SKU', 'sku', 't'), c('LineNumber', 'line_number', 'i'), c('ReferenceOrderID', 'reference_order_id', 'g'),
    ] },
];

const SPEC_BY_NAME = Object.fromEntries(SPECS.map((s) => [s.name, s]));
const VOLATILE = new Set(['source_updated_at', 'source_hash', 'last_synced_at']);

const colSrc = (col) => (Array.isArray(col) ? { src: col[0], dest: col[1], type: col[2] } : { expr: col.expr, dest: col.dest, type: col.type });
const colExpr = (col) => { const x = colSrc(col); return x.expr || `t.${x.src}`; };
const resolve = (v, full) => (typeof v === 'function' ? v(full) : v);

function isoLiteral(value) {
  const iso = new Date(value).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(iso)) throw new Error(`Bad watermark ${value}`);
  return iso;
}

/** Builds the source SELECT. `since` is an ISO string or null (full). Plain text, no parameters. */
function buildSelect(spec, { since = null, countOnly = false } = {}) {
  const full = !since;
  const from = resolve(spec.from, full);
  const extraWhere = spec.where ? resolve(spec.where, full) : null;
  const luCols = spec.lastUpdated || ['t.LastUpdated'];
  const clauses = [];
  if (extraWhere) clauses.push(`(${extraWhere})`);
  if (since) {
    const lit = `CONVERT(datetimeoffset, '${isoLiteral(since)}', 127)`;
    clauses.push(`(${luCols.map((x) => `${x} > ${lit}`).join(' OR ')})`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  if (countOnly) return `SELECT COUNT(*) AS n FROM ${from} ${where}`;
  const select = spec.cols.map((col) => { const x = colSrc(col); return `${colExpr(col)} AS [${x.dest}]`; });
  select.push(`t.LastUpdated AS [source_updated_at]`);
  // Entities filtered on several timestamps (lens items + ancestors) advance their watermark on the newest of them.
  if (luCols.length > 1) select.push(`(SELECT MAX(v) FROM (VALUES ${luCols.map((x) => `(${x})`).join(',')}) AS lu(v)) AS [watermark_at]`);
  return `SELECT ${select.join(',\n  ')}\nFROM ${from}\n${where}\nORDER BY t.${spec.cols.find((x) => Array.isArray(x)).at(0)}`;
}

function mapValue(value, type) {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'i': case 's': case 'g': case 'm': case 'f': { const n = Number(value); if (!Number.isFinite(n)) throw new Error(`Non-numeric value ${value}`); return n; }
    case 'b': return typeof value === 'string' ? value === '1' || value.toLowerCase() === 'true' : !!value;
    case 'd': return new Date(value).toISOString();
    default: return String(value).trim();
  }
}

const stable = (v) => JSON.stringify(v);

function hashRow(record) {
  const keys = Object.keys(record).filter((k) => !VOLATILE.has(k)).sort();
  return crypto.createHash('sha256').update(stable(keys.map((k) => [k, record[k]]))).digest('hex');
}

function mapRow(spec, row, syncedAt = new Date().toISOString()) {
  const out = {};
  for (const col of spec.cols) { const x = colSrc(col); out[x.dest] = mapValue(row[x.dest], x.type); }
  out.source_updated_at = row.source_updated_at ? new Date(row.source_updated_at).toISOString() : null;
  out.source_hash = hashRow(out);
  out.last_synced_at = syncedAt;
  return out;
}

// ── watermark state ──────────────────────────────────────────────────────────
function readState(file = STATE_FILE) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return s && typeof s === 'object' && s.watermarks ? s : { watermarks: {} }; } catch { return { watermarks: {} }; }
}
function writeWatermark(name, watermark, file = STATE_FILE) {
  const state = readState(file);
  state.watermarks[name] = watermark;
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function sinceFor(name, { full = false, stateFile = STATE_FILE } = {}) {
  if (full) return null;
  const wm = readState(stateFile).watermarks[name];
  if (!wm) return null;
  return new Date(new Date(wm).getTime() - WATERMARK_OVERLAP_MS).toISOString();
}

const pendingWatermarks = new Map();

/** Reads and maps one mirror entity. Strictly SELECT, READ UNCOMMITTED. */
async function readMirror(spec, { full = false, stateFile = STATE_FILE, getPool } = {}) {
  const pool = await (getPool || require('./db').getLongSourcePool)();
  const since = sinceFor(spec.name, { full, stateFile });
  const query = `SET NOCOUNT ON; SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; ${buildSelect(spec, { since })}`;
  const result = await pool.request().query(query);
  const syncedAt = new Date().toISOString();
  const records = result.recordset.map((row) => mapRow(spec, row, syncedAt));
  const newest = result.recordset.reduce((max, row) => {
    const at = row.watermark_at || row.source_updated_at;
    const iso = at ? new Date(at).toISOString() : null;
    return iso && (!max || iso > max) ? iso : max;
  }, null);
  pendingWatermarks.set(spec.name, newest);
  records.mode = since ? `incremental since ${since}` : 'full';
  return records;
}

// Build ENTITIES entries for innovations-sync.js.
function mirrorEntities() {
  const entities = {};
  for (const spec of SPECS) {
    entities[spec.name] = {
      mirror: true,
      usesLivePool: true,
      batchSize: MIRROR_BATCH_SIZE,
      read: (opts = {}) => readMirror(spec, opts),
      commitSnapshot: () => {
        const newest = pendingWatermarks.get(spec.name);
        pendingWatermarks.delete(spec.name);
        if (newest) {
          const prev = readState().watermarks[spec.name];
          if (!prev || newest > prev) writeWatermark(spec.name, newest);
        } else if (!readState().watermarks[spec.name]) {
          // Empty source (e.g. nothing changed on a first run): record "now" so the next run is incremental.
          writeWatermark(spec.name, new Date().toISOString());
        }
      },
    };
  }
  return entities;
}

const MIRROR_ENTITY_NAMES = SPECS.map((s) => s.name);
const isMirrorEntity = (name) => Object.prototype.hasOwnProperty.call(SPEC_BY_NAME, name);

/** Receiver allowlist for an entity: every mapped column plus the audit columns. */
function allowlist(spec) {
  return [...spec.cols.map((x) => colSrc(x).dest), 'source_updated_at', 'source_hash', 'last_synced_at'];
}

/** Source COUNT(*) for the exact rows a FULL run would read (the dry-run gate). */
const countSql = (name) => buildSelect(SPEC_BY_NAME[name], { countOnly: true });

module.exports = {
  SPECS, SPEC_BY_NAME, MIRROR_ENTITY_NAMES, MIRROR_BATCH_SIZE, INVOICE_LINES_FROM, STATE_FILE,
  mirrorEntities, isMirrorEntity, buildSelect, countSql, mapRow, hashRow, mapValue, allowlist,
  readState, writeWatermark, sinceFor, readMirror, colSrc,
};
