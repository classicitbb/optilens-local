const fs = require("node:fs");
const path = require("node:path");

const INCIDENT_COOLDOWN_MS = 15 * 60 * 1000;

function createHostIncidentReporter({ dataDir, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const directory = dataDir || path.join(process.cwd(), "data");
  const incidentLog = path.join(directory, "host-incidents.jsonl");
  const stateFile = path.join(directory, "host-incidents-state.json");
  const helpdeskUrl = String(process.env.OPTILENS_CVWEB_HELPDESK_URL || "").trim();
  const alertsUrl = String(process.env.OPTILENS_CVWEB_ALERTS_URL || "").trim();
  const bearer = String(process.env.OPTILENS_CVWEB_ALERTS_TOKEN || "").trim();

  function readState() {
    try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return {}; }
  }

  function writeLine(file, value) {
    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(value) + "\n", "utf8");
  }

  async function deliver(url, incident) {
    if (!url || typeof fetchImpl !== "function") return { configured: false };
    const headers = { "content-type": "application/json" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(incident),
        signal: AbortSignal.timeout(8000),
      });
      return { configured: true, delivered: response.ok, status: response.status };
    } catch (error) {
      return { configured: true, delivered: false, error: error.message };
    }
  }

  async function report({ fingerprint, severity = "error", title, message, details = {}, source = "host-monitor" }) {
    const key = String(fingerprint || `${source}:${title}:${message}`).slice(0, 240);
    const state = readState();
    const lastReportedAt = Number(state[key] || 0);
    const incident = {
      type: "optilens.host.incident",
      fingerprint: key,
      severity,
      title: String(title || "OptiLens Local host incident"),
      message: String(message || "The host monitor detected an error."),
      source,
      host: process.env.COMPUTERNAME || process.env.HOSTNAME || "unknown-host",
      occurredAt: new Date(now()).toISOString(),
      details,
    };
    writeLine(incidentLog, incident);
    if (lastReportedAt > 0 && now() - lastReportedAt < INCIDENT_COOLDOWN_MS) return { ...incident, suppressed: true };
    state[key] = now();
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
    const [helpdesk, alerts] = await Promise.all([deliver(helpdeskUrl, incident), deliver(alertsUrl, incident)]);
    return { ...incident, suppressed: false, delivery: { helpdesk, alerts } };
  }

  return { report };
}

module.exports = { createHostIncidentReporter };
