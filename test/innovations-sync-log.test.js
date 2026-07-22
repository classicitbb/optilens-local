const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeEntities, trim } = require('../lib/innovations-sync-log');
const { ENTITIES, normalizeEntitySelection } = require('../lib/innovations-sync');

test('sync log summaries preserve counts but cap diagnostic text', () => {
  const result = summarizeEntities({
    customers: { ok: false, read: 3, received: 2, upserted: 1, failed: 1, batches: 1, error: 'x'.repeat(600) },
  });
  assert.deepEqual({ ...result.customers, error: undefined }, {
    ok: false, read: 3, received: 2, upserted: 1, failed: 1, batches: 1, error: undefined,
  });
  assert.equal(result.customers.error.length, 500);
  assert.equal(trim('a\nb'), 'a b');
});

test('statement sync selection automatically includes statement lines in dependency order', () => {
  assert.deepEqual(normalizeEntitySelection(['statements']), ['statements', 'statement_lines']);
  assert.deepEqual(
    normalizeEntitySelection(['statement_lines', 'customers', 'statements']),
    ['customers', 'statements', 'statement_lines'],
  );
});

test('order activity is included in the default scheduled sync and emits only the cloud contract fields', () => {
  assert.ok(normalizeEntitySelection().includes('order_activity'));
  assert.deepEqual(ENTITIES.order_activity.map({
    CustomerID: 12345,
    LastOrderDate: '2026-07-11',
    OrdersLast7Days: 9,
    OrdersLast30Days: 41,
    OrdersLast90Days: 122,
    AvgGapDays: '1.4',
  }), {
    innovations_customer_id: 12345,
    last_order_date: '2026-07-11',
    orders_last_7_days: 9,
    orders_last_30_days: 41,
    orders_last_90_days: 122,
    avg_gap_days: 1.4,
  });
  assert.equal(ENTITIES.order_activity.map({
    CustomerID: 12345,
    LastOrderDate: null,
    OrdersLast7Days: 0,
    OrdersLast30Days: 0,
    OrdersLast90Days: 2,
    AvgGapDays: null,
  }).avg_gap_days, null);
});

test('bank sync preserves the exact Innovations EFT institution name', () => {
  const sourceName = 'First Caribbean International ';
  assert.deepEqual(ENTITIES.banks.map({ EFTInstitutionID: 3, EFTInstitutionName: sourceName }), {
    innovations_eft_institution_id: 3,
    bank_name: sourceName,
  });
});

test('contact sync pre-fills CRM address fields from the linked customer address', () => {
  assert.deepEqual(ENTITIES.contacts.map({
    ContactID: 80,
    CustomerID: 12345,
    FirstName: 'Jane',
    Surname: 'Smith',
    CustomerName: 'North Coast Optical',
    EmailAddress: 'jane@example.com',
    PhoneNumber: '',
    MobileNumber: '555-0100',
    AddressLine1: '1 Main Street',
    AddressLine2: 'Suite 2',
    City: 'Bridgetown',
    State: 'St Michael',
    PostalCode: 'BB11000',
    CountryName: 'Barbados',
    CountryCode: 'BB',
  }), {
    innovations_contact_id: 80,
    innovations_parent_customer_id: 12345,
    name: 'Jane Smith',
    business_name: 'North Coast Optical',
    email: 'jane@example.com',
    phone: '555-0100',
    street: '1 Main Street',
    street2: 'Suite 2',
    city: 'Bridgetown',
    state: 'St Michael',
    zip: 'BB11000',
    country: 'Barbados',
    country_code: 'BB',
    is_company: false,
  });
});

test('customer sync folds the source address into customer contact fields', () => {
  assert.deepEqual(ENTITIES.customers.map({
    CustomerID: 12345,
    CustomerName: 'North Coast Optical',
    AccountNumber: 'NORTH',
    IsActive: 1,
    EmailAddress: 'accounts@example.com',
    PhoneNumber: '555-0111',
    AddressLine1: '1 Main Street',
    AddressLine2: 'Suite 2',
    AddressLine3: '',
    City: 'Bridgetown',
    State: 'St Michael',
    PostalCode: 'BB11000',
    CountryName: 'Barbados',
    CountryCode: 'BB',
    PayByCard: true,
    PayByEFT: false,
    EFTInstitutionName: 'Bank',
    DefaultPaymentType: 1,
  }), {
    innovations_customer_id: 12345,
    name: 'North Coast Optical',
    account_number: 'NORTH',
    address: '1 Main Street, Suite 2, Bridgetown, St Michael, BB11000, Barbados',
    country_code: 'BB',
    email: 'accounts@example.com',
    phone: '555-0111',
    notes: 'Innovations: active',
    pay_by_card: true,
    pay_by_eft: false,
    eft_institution_name: 'Bank',
    default_payment_type: 1,
  });
});
