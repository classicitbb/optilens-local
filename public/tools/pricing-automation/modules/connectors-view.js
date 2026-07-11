import { $, app, setCombos, setSources, state, toast } from "./state.js";
import { connectorPost, fetchConnectorsStatus, reloadCatalogData } from "./api.js";

export async function buildConnectorsView() {
  const element = $("connectors-body");
  let response = null;
  try { response = await fetchConnectorsStatus(); } catch {}
  if (!response || !response.ok) {
    element.innerHTML = `<div class="conn-card conn-lock"><h3>⚠ Connectors unavailable</h3>
      <p class="conn-note">The connectors API isn't responding. Restart the server and reload.</p></div>`;
    return;
  }

  state.connStatus = await response.json().catch(() => ({ initialised: false }));
  if (!state.connStatus.initialised) {
    element.innerHTML = `<div class="conn-card conn-lock"><h3>🔐 Set a passphrase</h3>
      <p class="conn-note">Protects your connection keys. Minimum 6 characters. No recovery — store it safely.</p>
      <input type="password" id="conn-pass1" placeholder="New passphrase">
      <div style="margin-top:10px"><button class="pl-btn pl-btn-primary" type="button" data-action="conn-init">Set passphrase</button></div></div>`;
    return;
  }

  if (!state.connToken) {
    element.innerHTML = `<div class="conn-card conn-lock"><h3>🔒 Connectors locked</h3>
      <p class="conn-note">Enter your passphrase to view or change credentials.</p>
      <input type="password" id="conn-pass" placeholder="Passphrase">
      <div style="margin-top:10px"><button class="pl-btn pl-btn-primary" type="button" data-action="conn-unlock">Unlock</button></div></div>`;
    return;
  }

  const optilens = state.connStatus.optilens || {};
  const cvapi = state.connStatus.cvapi || {};
  const innovaapi = state.connStatus.innovaapi || {};
  element.innerHTML = `
    <div class="conn-card">
      <div class="conn-row"><h3>🔑 Classic Visions API (x-api-key)</h3><button class="pl-btn pl-btn-secondary" type="button" data-action="conn-lock">🔒 Lock</button></div>
      <p class="conn-note">Scoped REST API for catalog & customers. Key stored encrypted, used server-side only.</p>
      <label>Base URL</label><input id="cv-base" value="${cvapi.baseUrl || ""}" placeholder="https://….supabase.co/functions/v1/api-v1">
      <label>API key <span class="muted">current: ${cvapi.apiKeyMasked || "not set"}</span></label><input id="cv-key" type="password" placeholder="paste to set / replace">
      <div class="conn-actions">
        <button class="pl-btn pl-btn-primary" type="button" data-action="cv-save">Save (encrypted)</button>
        <button class="pl-btn pl-btn-secondary" type="button" data-action="cv-reveal">👁 Reveal</button>
        <button class="pl-btn pl-btn-teal" type="button" data-action="cv-test">⇄ Test link</button>
        <button class="pl-btn pl-btn-teal" type="button" data-action="cv-pull">⇩ Pull live catalog</button>
      </div>
      <div id="cv-result" class="conn-result">${cvapi.updatedAt ? `<span class="muted">Key saved ${new Date(cvapi.updatedAt).toLocaleString()}</span>` : ""}</div>
    </div>
    <div class="conn-card">
      <div class="conn-row"><h3>🔐 InnovaAPI (Rx order status)</h3><button class="pl-btn pl-btn-secondary" type="button" data-action="conn-lock">🔒 Lock</button></div>
      <p class="conn-note">Bearer token for the local Innovations API. It is encrypted at rest and used only by the on-premises live gateway worker.</p>
      <label>Base URL</label><input id="innova-base" value="${innovaapi.baseUrl || "https://localhost/api/v2"}" placeholder="https://localhost/api/v2">
      <label>Bearer token <span class="muted">current: ${innovaapi.bearerTokenMasked || "not set"}</span></label><input id="innova-token" type="password" placeholder="paste to set / replace">
      <div class="conn-actions">
        <button class="pl-btn pl-btn-primary" type="button" data-action="innova-save">Save (encrypted)</button>
        <button class="pl-btn pl-btn-secondary" type="button" data-action="innova-reveal">👁 Reveal</button>
      </div>
      <div class="conn-result">${innovaapi.updatedAt ? `<span class="muted">Token saved ${new Date(innovaapi.updatedAt).toLocaleString()}</span>` : ""}</div>
    </div>
    <div class="conn-card">
      <div class="conn-row"><h3>🗄 Optilens (Supabase) catalog</h3><button class="pl-btn pl-btn-secondary" type="button" data-action="conn-lock">🔒 Lock</button></div>
      <label>Project URL</label><input id="conn-url" value="${optilens.url || ""}" placeholder="https://your-project.supabase.co">
      <label>Anon / publishable key <span class="muted">current: ${optilens.anonKeyMasked || "not set"}</span></label><input id="conn-anon" type="password" placeholder="paste to set / replace">
      <label>Service-role key — push only <span class="muted">current: ${optilens.serviceKeyMasked || "not set"}</span></label><input id="conn-svc" type="password" placeholder="paste to set / replace">
      <div class="conn-actions">
        <button class="pl-btn pl-btn-primary" type="button" data-action="conn-save">Save (encrypted)</button>
        <button class="pl-btn pl-btn-secondary" type="button" data-action="conn-reveal">👁 Reveal</button>
      </div>
    </div>
    <div class="conn-card">
      <div class="conn-row"><h3>Sync</h3><span class="muted">${optilens.updatedAt ? `credentials updated ${new Date(optilens.updatedAt).toLocaleString()}` : ""}</span></div>
      <p class="conn-note">Pull is read-only — refreshes catalog & re-prices. Publish writes a new versioned pricelist back (dry-run first).</p>
      <div class="conn-actions">
        <button class="pl-btn pl-btn-teal" type="button" data-action="conn-pull">⇩ Pull catalog (live sync)</button>
        <button id="pricing-publish-btn" class="pl-btn pl-btn-gold" type="button" data-action="conn-push-dry-run">⇧ Publish prices… (dry-run)</button>
      </div>
      <div id="conn-result" class="conn-result"></div>
    </div>`;
  app.syncProtectedActionLocks?.();
}

export async function connInit() {
  const result = await connectorPost("init", { passphrase: $("conn-pass1")?.value });
  if (result.error) return toast(result.error);
  toast("Passphrase set");
  await buildConnectorsView();
}

export async function connUnlock() {
  const result = await connectorPost("unlock", { passphrase: $("conn-pass")?.value });
  if (result.error || !result.token) return toast(result.error || "Wrong passphrase");
  state.connToken = result.token;
  toast("Unlocked");
  await buildConnectorsView();
}

export function connLock() {
  if (state.connToken) connectorPost("lock", { token: state.connToken });
  state.connToken = null;
  buildConnectorsView();
}

export async function cvSave() {
  const result = await connectorPost("cvapi/config", {
    token: state.connToken,
    baseUrl: $("cv-base")?.value.trim(),
    apiKey: $("cv-key")?.value.trim() || undefined,
  });
  if (result.error) return toast(result.error);
  toast("API key saved (encrypted)");
  await buildConnectorsView();
}

export async function cvReveal() {
  const result = await connectorPost("cvapi/reveal", { token: state.connToken });
  if (result.error) return toast(result.error);
  if ($("cv-base")) $("cv-base").value = result.baseUrl || "";
  if ($("cv-key")) {
    $("cv-key").type = "text";
    $("cv-key").value = result.apiKey || "";
  }
}

export async function innovaSave() {
  const result = await connectorPost("innovaapi/config", {
    token: state.connToken,
    baseUrl: $("innova-base")?.value.trim(),
    bearerToken: $("innova-token")?.value.trim() || undefined,
  });
  if (result.error) return toast(result.error);
  toast("InnovaAPI token saved (encrypted)");
  await buildConnectorsView();
}

export async function innovaReveal() {
  const result = await connectorPost("innovaapi/reveal", { token: state.connToken });
  if (result.error) return toast(result.error);
  if ($("innova-base")) $("innova-base").value = result.baseUrl || "https://localhost/api/v2";
  if ($("innova-token")) {
    $("innova-token").type = "text";
    $("innova-token").value = result.bearerToken || "";
  }
}

export async function cvTest() {
  const box = $("cv-result");
  box.innerHTML = '<span class="muted">Testing…</span>';
  const result = await connectorPost("cvapi/test", { token: state.connToken });
  if (result.error) {
    box.innerHTML = `<span class="conn-err">${result.error}</span>`;
    return;
  }
  if (!result.ok) {
    box.innerHTML = `<span class="conn-err">✗ ${result.message || "Link failed"}</span>`;
    return;
  }
  const fields = Object.entries(result.parity).map(([key, hit]) => `${hit ? "✓" : "✗"} ${key}${hit ? ` → ${hit}` : " missing"}`).join(" · ");
  box.innerHTML = `<div class="conn-dry"><span class="conn-ok">✓ Connected.</span> Catalog rows sampled: <b>${result.catalogRows}</b>; customers: <b>${result.customersOk ? "ok" : "no"}</b>.<br><span class="muted">Parity:</span> ${fields}</div>`;
}

async function refreshCatalogData() {
  const data = await reloadCatalogData();
  setCombos(data.combos);
  setSources(data.sources);
  await app.rePrice();
}

export async function cvPull() {
  const box = $("cv-result");
  box.innerHTML = '<span class="muted">Pulling live catalog from Classic Visions…</span>';
  const result = await connectorPost("cvapi/pull", { token: state.connToken });
  if (result.error) {
    box.innerHTML = `<span class="conn-err">Pull failed: ${result.error}</span>`;
    return;
  }
  await refreshCatalogData();
  box.innerHTML = `<span class="conn-ok">✓ Pulled ${result.combos} combos from ${result.rawRows} catalog rows (${result.mappedRows} classified). Prices regenerated.</span>`;
  toast("Classic Visions catalog synced");
}

export async function connSave() {
  const result = await connectorPost("config", {
    token: state.connToken,
    url: $("conn-url")?.value.trim(),
    anonKey: $("conn-anon")?.value.trim() || undefined,
    serviceKey: $("conn-svc")?.value.trim() || undefined,
  });
  if (result.error) return toast(result.error);
  toast("Credentials saved (encrypted)");
  await buildConnectorsView();
}

export async function connReveal() {
  const result = await connectorPost("reveal", { token: state.connToken });
  if (result.error) return toast(result.error);
  if ($("conn-url")) $("conn-url").value = result.url || "";
  if ($("conn-anon")) {
    $("conn-anon").type = "text";
    $("conn-anon").value = result.anonKey || "";
  }
  if ($("conn-svc")) {
    $("conn-svc").type = "text";
    $("conn-svc").value = result.serviceKey || "";
  }
}

export async function connPull() {
  $("conn-result").innerHTML = '<span class="muted">Pulling live catalog…</span>';
  const result = await connectorPost("pull", { token: state.connToken });
  if (result.error) {
    $("conn-result").innerHTML = `<span class="conn-err">Pull failed: ${result.error}</span>`;
    return;
  }
  await refreshCatalogData();
  $("conn-result").innerHTML = `<span class="conn-ok">✓ Pulled ${result.combos} combos from ${result.rawRows} rows. Prices regenerated.</span>`;
  toast("Live catalog synced");
}

export async function connPushDryRun() {
  const unsafe = app.unsafePriceEntries();
  if (unsafe.length) {
    app.revealBlockedPriceEntry();
    toast(`Cannot publish: ${unsafe.length} price${unsafe.length === 1 ? "" : "s"} below margin floor`);
    return;
  }
  const rows = app.visiblePriceEntries().map(([key, price]) => {
    const combo = state.comboByKey[key] || {};
    return {
      key,
      treatment: combo.treatment,
      tier: combo.tier,
      material: combo.material,
      available: true,
      priceUSD: price.priceUSD,
      retailUSD: price.retailUSD,
      constraintSupplier: price.constraintSupplier || null,
    };
  });
  if (!rows.length) return toast("Run Auto-Price first");
  const result = await connectorPost("push", {
    token: state.connToken,
    pricedRows: rows,
    settings: { ...state.settings, disabled: state.overrides, classOverrides: state.classOverrides },
    commit: false,
  });
  if (result.error) {
    $("conn-result").innerHTML = `<span class="conn-err">${result.error}</span>`;
    return;
  }
  $("conn-result").innerHTML = `<div class="conn-dry"><b>Dry run — nothing sent.</b><br>Would publish <b>${result.plan.lineCount}</b> lines as version "${result.plan.versionName}" → ${result.plan.target} (${result.plan.reversible}).<br><span class="muted">Live write stays disabled until first confirmed connect.</span></div>`;
}

Object.assign(app, {
  buildConnectorsView,
  connInit,
  connLock,
  connPull,
  connPushDryRun,
  connReveal,
  connSave,
  connUnlock,
  cvPull,
  cvReveal,
  cvSave,
  cvTest,
  innovaReveal,
  innovaSave,
});
