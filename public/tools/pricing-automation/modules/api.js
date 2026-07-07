import { normalizeClassOverrides, normalizeOverrides, normalizeSettings, state } from "./state.js";

export async function fetchJson(url, fallback) {
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    if (fallback !== undefined && response.status !== 401 && response.status !== 403) return fallback;
    throw error;
  }
  return data;
}

export async function fetchInitialPricingData() {
  const combos = await fetchJson("/api/v2/combos");
  const [customers, sources] = await Promise.all([
    fetchJson("/api/pl/customers", []),
    fetchJson("/api/v2/sources", { sources: [], live: [] }),
  ]);
  return { combos, customers, sources };
}

export function requestPriceRows(settings) {
  return fetch("/api/v2/price", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...normalizeSettings(settings),
      disabled: normalizeOverrides(state.overrides),
      classOverrides: normalizeClassOverrides(state.classOverrides),
    }),
  }).then((response) => response.json());
}

export function requestOverride(key, enteredPriceUSD, settings) {
  return fetch("/api/v2/override", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key,
      enteredPriceUSD,
      ...normalizeSettings(settings),
      classOverrides: normalizeClassOverrides(state.classOverrides),
    }),
  }).then((response) => response.json());
}

export function fetchSourceStatus() {
  return fetch("/api/v2/source-status").then((response) => response.json());
}

export function fetchCatalogSourceRows(supplier) {
  return fetchJson(`/api/v2/catalog-source-rows?supplier=${encodeURIComponent(supplier)}`);
}

export function postSourceMode(mode) {
  return fetch("/api/v2/source-mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

export function fetchClassificationPreview(classOverrides) {
  return fetch("/api/v2/classification-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ classOverrides: normalizeClassOverrides(classOverrides) }),
  }).then((response) => response.json());
}

export function fetchPricelists() {
  return fetch("/api/pricelists").then((response) => response.json());
}

export function fetchPricelist(id) {
  return fetch(`/api/pricelists/${id}`).then((response) => response.json());
}

export function updatePricelist(id, payload) {
  return fetch(`/api/pricelists/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export function createPricelist(payload) {
  return fetch("/api/pricelists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((response) => response.json());
}

export function removePricelist(id) {
  return fetch(`/api/pricelists/${id}`, { method: "DELETE" });
}

export function fetchConnectorsStatus() {
  return fetch("/api/connectors/status");
}

export async function connectorPost(path, body) {
  try {
    const response = await fetch(`/api/connectors/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      return { error: `Server error (HTTP ${response.status}).` };
    }
    if (!response.ok && !data.error) data.error = `Request failed (HTTP ${response.status}).`;
    return data;
  } catch (error) {
    return { error: `Cannot reach the server: ${error.message}` };
  }
}

export async function reloadCatalogData() {
  const [combos, sources] = await Promise.all([
    fetch("/api/v2/combos").then((response) => response.json()),
    fetch("/api/v2/sources").then((response) => response.json()),
  ]);
  return { combos, sources };
}
