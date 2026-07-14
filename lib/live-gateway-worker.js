const { dispatch, OPERATIONS } = require('./live-data-gateway');
const { execSync } = require('node:child_process');
const path = require('node:path');

const AGENT_VERSION = '2026-07-14.1';
// Surfaced in status + self-test so "which code is actually running" is never
// a mystery again (a stale process after a pull/restart race caused a live bug).
let LOCAL_BUILD = 'unknown';
try {
  LOCAL_BUILD = execSync('git rev-parse --short HEAD', {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString().trim();
} catch { /* git unavailable — keep 'unknown' */ }
const DEFAULT_GATEWAY_BASE = 'https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorMessage = (error) => String(error && (error.message || error) || 'Unknown live gateway error').slice(0, 1000);

function gatewayBase(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '') || DEFAULT_GATEWAY_BASE;
  // The gateway is its own edge function (functions/v1/live-data-gateway), not
  // an api-v1 subroute. Stored credentials keep the api-v1 base for the sync
  // push — strip that suffix here so both flows share one base URL.
  return base.replace(/\/api-v1$/, '');
}

class LiveGatewayWorker {
  constructor() {
    this.running = false;
    this.creds = null;
    this.startedAt = null;
    this.lastSeenAt = null;
    this.lastRequestAt = null;
    this.lastError = null;
    this.processed = 0;
    this.failed = 0;
  }

  status() {
    return {
      running: this.running, startedAt: this.startedAt, lastSeenAt: this.lastSeenAt,
      lastRequestAt: this.lastRequestAt, lastError: this.lastError,
      processed: this.processed, failed: this.failed,
      capabilities: this.capabilities(), agentVersion: AGENT_VERSION,
      localBuild: LOCAL_BUILD,
    };
  }

  /**
   * End-to-end diagnostics for the live-data chain. Each step reports ok/detail
   * so a failure anywhere (stale code, locked vault, dead DB, unreachable cloud,
   * bad auth, empty operations) is visible in one click instead of surfacing as
   * a customer-facing timeout. `account` runs the real operations as a dry run.
   */
  async selfTest(options = {}) {
    const steps = [];
    const add = (name, ok, detail) => { steps.push({ name, ok, detail: String(detail ?? '').slice(0, 400) }); };

    add('local_build', true, `commit ${LOCAL_BUILD} · agent ${AGENT_VERSION}`);

    const st = this.status();
    add('worker', st.running && !st.lastError, st.running
      ? (st.lastError ? `running with error: ${st.lastError}` : `running · ${st.processed} served, ${st.failed} failed`)
      : 'stopped — start the live gateway');

    try {
      const { getAppPool } = require('./db');
      const pool = await getAppPool();
      const r = await pool.request().query(`
        SELECT MAX(COALESCE(closed_at, started_at)) AS latest,
               SUM(CASE WHEN closed_at IS NULL THEN 1 ELSE 0 END) AS open_count,
               COUNT(*) AS total
        FROM delivery.shipment_sessions;`);
      const row = r.recordset?.[0] || {};
      add('optilens_db', true, `${row.total ?? 0} shipment sessions · ${row.open_count ?? 0} open · latest activity ${row.latest ?? 'never'}`);
    } catch (e) { add('optilens_db', false, errorMessage(e)); }

    try {
      const { getSourcePool } = require('./db');
      const pool = await getSourcePool();
      const r = await pool.request().query('SELECT MAX(ReceivedTime) AS latest, COUNT(*) AS total FROM dbo.Orders;');
      const row = r.recordset?.[0] || {};
      const latest = row.latest ? new Date(row.latest) : null;
      const staleDays = latest ? Math.floor((Date.now() - latest.getTime()) / 86400000) : null;
      add('innovations_db', staleDays != null && staleDays <= 2,
        `${row.total ?? 0} orders · newest ${row.latest ?? 'never'}${staleDays != null ? ` (${staleDays}d old${staleDays > 2 ? ' — SOURCE LOOKS STALE' : ''})` : ''}`);
    } catch (e) { add('innovations_db', false, errorMessage(e)); }

    const creds = this.creds || (options.credentials && options.credentials.apiKey ? options.credentials : null);
    if (creds) {
      const hadCreds = !!this.creds;
      try {
        if (!hadCreds) this.creds = { baseUrl: creds.baseUrl || '', apiKey: creds.apiKey };
        await this.post({ action: 'agent.heartbeat', agent_name: 'OptiLens Local (self-test)', agent_version: AGENT_VERSION, capabilities: this.capabilities() });
        add('cloud_gateway', true, `heartbeat accepted at ${gatewayBase(this.creds.baseUrl)}/live-data-gateway`);
      } catch (e) {
        add('cloud_gateway', false, errorMessage(e));
      } finally {
        if (!hadCreds) this.creds = null;
      }
    } else {
      add('cloud_gateway', false, 'no credentials — unlock the vault and retry to test cloud auth');
    }

    const account = String(options.account || '').trim();
    if (account) {
      try {
        const data = await dispatch({ operation: 'innovations.customer_orders', target: { account_number: account }, arguments: {} });
        add('op_customer_orders', true, `${data.orders?.length ?? 0} active orders for ${account}`);
      } catch (e) { add('op_customer_orders', false, errorMessage(e)); }
      try {
        const data = await dispatch({ operation: 'optilens.customer_deliveries', target: { account_number: account }, arguments: {} });
        const deliveries = data.deliveries ?? [];
        const open = deliveries.filter((d) => !d.closed_at).length;
        const withItems = deliveries.filter((d) => (d.orders?.length ?? 0) > 0).length;
        const withTracking = deliveries.filter((d) => d.tracking_url).length;
        add('op_customer_deliveries', true,
          `${deliveries.length} shipments (${open} open, ${deliveries.length - open} closed ≤45d) · ${withItems} with items · ${withTracking} with tracking links`);
      } catch (e) { add('op_customer_deliveries', false, errorMessage(e)); }
    } else {
      add('op_dry_run', false, 'no sample account given — enter an account number to dry-run orders + deliveries');
    }

    return { ok: steps.every((s) => s.ok), steps, ran_at: new Date().toISOString() };
  }

  start(creds) {
    if (!creds || !creds.apiKey) throw new Error('CV API key is required to start the live gateway.');
    this.creds = { baseUrl: creds.baseUrl || '', apiKey: creds.apiKey };
    if (this.running) return this.status();
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.lastError = null;
    void this.runLoop();
    return this.status();
  }

  capabilities() {
    return OPERATIONS.slice();
  }

  stop() {
    this.running = false;
    this.creds = null;
    return this.status();
  }

  async post(body) {
    if (!this.creds) throw new Error('Live gateway credentials are not loaded.');
    const response = await fetch(`${gatewayBase(this.creds.baseUrl)}/live-data-gateway`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.creds.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { error: text.slice(0, 300) }; }
    if (response.status === 404) {
      throw new Error(`Gateway endpoint not found at ${gatewayBase(this.creds.baseUrl)}/live-data-gateway.`);
    }
    if (!response.ok) throw new Error(parsed.error || parsed.detail || `Gateway HTTP ${response.status}`);
    return parsed;
  }

  async heartbeat() {
    await this.post({
      action: 'agent.heartbeat', agent_name: 'OptiLens Local', agent_version: AGENT_VERSION,
      capabilities: this.capabilities(), last_error: this.lastError,
    });
    this.lastSeenAt = new Date().toISOString();
  }

  async processRequest(request) {
    this.lastRequestAt = new Date().toISOString();
    try {
      const data = await Promise.race([
        dispatch(request),
        new Promise((_, reject) => setTimeout(() => {
          const error = Object.assign(new Error('Private source query timed out after 18000ms.'), { code: 'source_timeout' });
          reject(error);
        }, 18000)),
      ]);
      await this.post({ action: 'agent.complete', request_id: request.id, ok: true, data });
      this.processed += 1;
      this.lastError = null;
    } catch (error) {
      this.failed += 1;
      this.lastError = errorMessage(error);
      try {
        await this.post({
          action: 'agent.complete', request_id: request.id, ok: false,
          error_code: error && error.code ? String(error.code) : 'source_error',
          error_message: this.lastError,
        });
      } catch (completeError) {
        this.lastError = `${this.lastError}; completion failed: ${errorMessage(completeError)}`;
      }
    }
  }

  async runLoop() {
    let nextHeartbeatAt = 0;
    let waitMs = 750;
    while (this.running) {
      try {
        if (Date.now() >= nextHeartbeatAt) {
          await this.heartbeat();
          nextHeartbeatAt = Date.now() + 5000;
        }
        const result = await this.post({ action: 'agent.next' });
        if (result.request) await this.processRequest(result.request);
        waitMs = result.request ? 50 : 750;
      } catch (error) {
        this.lastError = errorMessage(error);
        waitMs = Math.min(Math.max(waitMs * 2, 1500), 10000);
      }
      if (this.running) await delay(waitMs);
    }
  }
}

module.exports = Object.assign(new LiveGatewayWorker(), { gatewayBase });

