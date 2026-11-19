'use strict';

// Sitewide search behind the header palette. Each provider owns one kind of record and one permission;
// a person only ever sees groups they may read, and a slow or failing source never blocks the others.
const PER_GROUP = 6;
const PROVIDER_TIMEOUT_MS = 4000;
const REVIEW_TTL_MS = 60 * 1000;

const LANE_LABELS = { ready: 'Ready to post', attention: 'Needs a look', exception: 'Exception', posted: 'In QuickBooks', new: 'New' };
const money = (value) => Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const terms = (query) => String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), ms))]);

function invoiceHits(rows, query) {
  const wanted = terms(query);
  if (!wanted.length) return [];
  const matches = rows.filter((row) => {
    const haystack = [row.sourceInvoiceId, row.customer, row.account, row.qboCustomer, row.memo, row.tracking, row.itemName].join(' ').toLowerCase();
    return wanted.every((term) => haystack.includes(term));
  });
  const shown = matches.slice(0, PER_GROUP).map((row) => ({
    title: `Invoice ${row.sourceInvoiceId}`,
    meta: `${row.customer} · ${row.isCredit ? '-' : ''}${money(row.total)} · ${LANE_LABELS[row.lane] || row.lane}`,
    href: `/modules/automation?q=${encodeURIComponent(row.sourceInvoiceId)}`,
    more: 0
  }));
  if (shown.length) shown[shown.length - 1].more = matches.length - shown.length;
  return shown;
}

function shipmentHits(ids) {
  return ids.slice(0, PER_GROUP).map((id) => ({ title: `Shipment ${id}`, meta: 'Delivery & Export', href: `/modules/delivery-export?q=${encodeURIComponent(id)}` }));
}

function customerHits(customers) {
  return customers.slice(0, PER_GROUP).map((customer) => ({
    title: customer.customerName,
    meta: `${String(customer.customerAccount || '').trim()}${customer.isExportCustomer ? ' · Export' : ' · Local'}`,
    href: `/modules/delivery-export?q=${encodeURIComponent(String(customer.customerAccount || customer.customerName).trim())}`
  }));
}

// providers: [{ id, label, icon, color, permission, run(query) -> hits[] }]
async function searchAll({ query, providers, can }) {
  const text = String(query || '').trim();
  if (text.length < 2) return { query: text, groups: [], skipped: [] };
  const skipped = [];
  const settled = await Promise.all(providers.map(async (provider) => {
    if (!can(provider.permission)) return null;
    try {
      const hits = await withTimeout(Promise.resolve(provider.run(text)), PROVIDER_TIMEOUT_MS);
      if (!hits.length) return null;
      const more = hits.reduce((count, hit) => count + (hit.more || 0), 0);
      return { id: provider.id, label: provider.label, icon: provider.icon, color: provider.color, more, hits: hits.map(({ more: _more, ...hit }) => hit) };
    } catch { skipped.push(provider.id); return null; }
  }));
  return { query: text, groups: settled.filter(Boolean), skipped };
}

// The review read hits Innovations, so share one copy between keystrokes for a minute.
function cachedReviewRows(loadReview, now = () => Date.now()) {
  let cache = null;
  let pending = null;
  return async () => {
    if (cache && now() - cache.at < REVIEW_TTL_MS) return cache.rows;
    pending ||= loadReview().then((review) => { cache = { at: now(), rows: review.rows || [] }; return cache.rows; }).finally(() => { pending = null; });
    return pending;
  };
}

module.exports = { searchAll, invoiceHits, shipmentHits, customerHits, cachedReviewRows, PER_GROUP };
