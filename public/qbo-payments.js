(() => {
  'use strict';
  const root = document.getElementById('qboPaymentWorkspace');
  if (!root) return;
  const $ = (selector) => root.querySelector(selector);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const labels = { all: 'All', ready: 'Ready for review', needs_review: 'Needs a look', exception: 'Exceptions', matched: 'Matched in QuickBooks' };
  let data = null, scope = 'all', query = '';
  const money = (value) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-BB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
  function render() {
    $('[data-payment-lanes]').innerHTML = Object.entries(labels).map(([key, label]) => `<button type="button" class="qbo-lane" data-payment-scope="${key}" aria-pressed="${scope === key}">${label} <strong>${data?.counts[key] ?? '—'}</strong></button>`).join('');
    const rows = (data?.rows || []).filter((r) => (scope === 'all' || r.status === scope) && [r.id, r.customer, r.account, r.method, ...(r.allocations || []).map((a) => a.invoiceNumber)].join(' ').toLowerCase().includes(query));
    $('[data-payment-table]').innerHTML = rows.length ? `<table class="qbo-table"><caption>Innovations receipts compared with QuickBooks — read-only</caption><thead><tr>${['Receipt', 'Date', 'Customer', 'Method', 'Amount', 'Discount', 'Status and evidence'].map((s) => `<th scope="col">${s}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr><th scope="row">${escape(r.id)}</th><td>${escape(r.date)}</td><td>${escape(r.customer)}<br><small>${escape(r.account)}</small></td><td>${escape(r.method)}</td><td class="qbo-num">${money(r.amount)}</td><td class="qbo-num">${money(r.discount)}</td><td><details><summary>${escape(labels[r.status])}</summary><div class="payment-evidence">
      <ul>${r.reasons.map((reason) => `<li>${escape(reason)}</li>`).join('')}</ul>
      <p>Invoices: ${(r.allocations || []).map((a) => `${escape(a.invoiceNumber)} (${money(a.amount)})`).join(', ') || 'None'}</p>
      <p>QuickBooks Payment: ${escape(r.qboPaymentId || 'Not matched')}. Deposits: ${escape(r.qboDepositIds.join(', ') || 'Not matched')}.</p>
      ${r.matchKind === 'historical_candidate' ? '<p>Historical candidate — confirm before linking. No marker has been added.</p>' : ''}
      <p>Proposed memo:</p><pre>${escape(r.memo)}</pre></div></details></td></tr>`).join('')}</tbody></table>` : `<p class="qbo-empty">${data ? (data.rows.length ? 'No receipts match this filter.' : 'No receipts found in this date range.') : 'Choose the receipt dates and compare with QuickBooks.'}</p>`;
  }
  async function compare(event) {
    event.preventDefault();
    const button = $('[data-payment-compare]');
    button.disabled = true;
    root.setAttribute('aria-busy', 'true');
    $('[data-payment-notice]').textContent = 'Reading receipts and comparing invoice allocations, payments and deposits…';
    // Clear old evidence so a failed new comparison cannot look current.
    data = null; render();
    try {
      const params = new URLSearchParams(new FormData($('form')));
      const response = await fetch(`/api/automation/qbo-payments/review?${params}`, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(180000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Payment comparison failed.');
      data = result;
      $('[data-payment-notice]').textContent = `${result.environment}. Compared ${new Date(result.checkedAt).toLocaleString()}. ${result.notices.join(' ')}${result.comparisonComplete ? '' : ' Comparison incomplete; all receipts are held.'}`;
      render();
    } catch (error) {
      $('[data-payment-notice]').textContent = error.name === 'TimeoutError' ? 'Comparison timed out. Choose fewer receipts or a narrower date range and retry.' : error.message;
    } finally { button.disabled = false; root.removeAttribute('aria-busy'); }
  }
  root.addEventListener('click', (event) => {
    const button = event.target.closest('[data-payment-scope]');
    if (button) { scope = button.dataset.paymentScope; render(); }
  });
  $('[data-payment-search]').addEventListener('input', (event) => { query = event.target.value.toLowerCase().trim(); render(); });
  $('form').addEventListener('submit', compare);
  const today = new Date();
  const calendarDate = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Barbados', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  $('[name="to"]').value = calendarDate(today);
  $('[name="from"]').value = calendarDate(new Date(today.getTime() - 90 * 86400000));
  render();
})();
