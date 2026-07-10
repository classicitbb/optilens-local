const { dispatch, OPERATIONS } = require('./live-data-gateway');

const AGENT_VERSION = '2026-07-10.1';
const DEFAULT_GATEWAY_BASE = 'https://xstmeirxhfbiyayrrsob.supabase.co/functions/v1/api-v1';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorMessage = (error) => String(error && (error.message || error) || 'Unknown live gateway error').slice(0, 1000);

function gatewayBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '') || DEFAULT_GATEWAY_BASE;
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
      capabilities: OPERATIONS, agentVersion: AGENT_VERSION,
    };
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
      capabilities: OPERATIONS, last_error: this.lastError,
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

