/**
 * source-backend.js — the Innovations source switch.
 *
 * "live"   = the vendor Innovations MSSQL database.
 * "mirror" = innovations_mirror on the app SQL Server, fed from Actian Zen.
 *
 * Switching persists core.app_settings.source_backend and resets the shared
 * source pool, so every consumer of getSourcePool() follows immediately. A
 * switch never proceeds to an offline backend; a row-count parity mismatch
 * between the two backends blocks the switch unless force is passed.
 */
const {
  SOURCE_BACKEND_SETTING,
  SOURCE_PROFILES,
  checkSourceProfile,
  getActiveSourceProfile,
  resetSourcePool
} = require("./db");
const { setSetting } = require("./app-settings");
const { recordAuditEvent } = require("./audit");

const PARITY_TOLERANCE = 0.02; // 2% row-count drift allowed before force is required

function parityIssues(a, b) {
  if (!a.counts || !b.counts) return [];
  const issues = [];
  for (const key of Object.keys(a.counts)) {
    const left = a.counts[key];
    const right = b.counts[key];
    const base = Math.max(left, right, 1);
    if (Math.abs(left - right) / base > PARITY_TOLERANCE) {
      issues.push(`${key}: ${a.profile}=${left.toLocaleString()} vs ${b.profile}=${right.toLocaleString()}`);
    }
  }
  return issues;
}

async function getStatus() {
  const [active, live, mirror] = await Promise.all([
    getActiveSourceProfile(),
    checkSourceProfile("live"),
    checkSourceProfile("mirror")
  ]);
  return { active, profiles: { live, mirror }, parity: parityIssues(live, mirror) };
}

async function switchTo(target, { force = false, actorUserId = null } = {}) {
  if (!SOURCE_PROFILES.includes(target)) {
    const error = new Error(`Unknown source profile "${target}". Expected one of: ${SOURCE_PROFILES.join(", ")}.`);
    error.statusCode = 400;
    throw error;
  }

  const current = await getActiveSourceProfile();
  if (current === target) {
    return { switched: false, active: current, detail: `Source backend is already "${target}".` };
  }

  const targetHealth = await checkSourceProfile(target);
  if (targetHealth.state !== "online") {
    const error = new Error(`Refusing to switch: the "${target}" backend is not online (${targetHealth.detail}).`);
    error.statusCode = 409;
    throw error;
  }

  const currentHealth = await checkSourceProfile(current);
  let parity = [];
  if (currentHealth.state === "online") {
    parity = parityIssues(currentHealth, targetHealth);
    if (parity.length && !force) {
      const error = new Error(`Row-count parity mismatch between backends: ${parity.join("; ")}. Pass force to switch anyway.`);
      error.statusCode = 409;
      error.parity = parity;
      throw error;
    }
  }

  await setSetting(SOURCE_BACKEND_SETTING, target, actorUserId ? String(actorUserId) : "system");
  resetSourcePool();

  try {
    await recordAuditEvent({
      moduleCode: "integrations",
      actorUserId,
      eventType: "source_backend.switched",
      entityType: "setting",
      entityId: SOURCE_BACKEND_SETTING,
      eventData: { from: current, to: target, force, parity }
    });
  } catch {
    // The switch itself succeeded; a missing audit table must not undo it.
  }

  return { switched: true, active: target, from: current, force, parity, target: targetHealth };
}

module.exports = { getStatus, parityIssues, switchTo };
