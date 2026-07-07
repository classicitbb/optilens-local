import { $, app, categoryClassLabel, escapeAttr, escapeHtml, normalizeOverrides, state, SUP_ABBR, SUPPLIER_COLORS, toast } from "./state.js";
import { fetchCatalogSourceRows, fetchSourceStatus, postSourceMode } from "./api.js";

export async function buildSourcesView() {
  const sourceStatus = await fetchSourceStatus().catch(() => null);
  const sources = state.sources.sources || [];
  const cards = sources.map((source) => `
    <div class="source-card">
      <div class="source-hd"><span class="source-type">${escapeHtml((source.format || source.type || "").toUpperCase())}</span><h3>${escapeHtml(source.name)}</h3></div>
      <div class="source-meta">${source.sheet ? `Sheet: ${escapeHtml(source.sheet)} · ` : ""}${source.approvedRows} approved rows → ${source.combos} priced combos</div>
      <table class="source-sup"><thead><tr><th>Supplier</th><th class="num">Catalog rows</th><th>In pricing</th></tr></thead><tbody>
        ${(source.suppliers || []).map((supplier) => {
          const excluded = state.settings.excluded.includes(supplier.name);
          return `<tr class="source-supplier-row" data-action="open-source-rows" data-supplier="${escapeAttr(supplier.name)}"><td><span class="dot" style="background:${SUPPLIER_COLORS[supplier.name] || "#888"}"></span>${escapeHtml(SUP_ABBR[supplier.name] || supplier.name)}</td>
            <td class="num">${supplier.rows}</td>
            <td><button class="mini-btn ${excluded ? "off" : ""}" type="button" data-action="toggle-source-exclude" data-supplier="${escapeAttr(supplier.name)}">${excluded ? "excluded" : "included"}</button></td></tr>`;
        }).join("")}
      </tbody></table>
      <p class="source-note">${escapeHtml(source.note || "")}</p>
    </div>`).join("");
  const live = (state.sources.live && state.sources.live.length)
    ? state.sources.live.map((feed) => `<div class="source-card"><h3>${escapeHtml(feed.name)}</h3><div class="source-meta">${escapeHtml(feed.status || "")}</div></div>`).join("")
    : '<div class="source-card empty"><h3>Live connections</h3><div class="source-meta">None yet. Connect via Connectors → Pull catalog.</div></div>';
  const discontinued = normalizeOverrides(state.overrides).combos.length;
  let sourceBanner = "";
  if (sourceStatus) {
    const onFallback = sourceStatus.active === "fallback";
    const isEmpty = sourceStatus.active === "empty";
    const dot = isEmpty ? "var(--pl-danger)" : onFallback ? "var(--pl-gold)" : "var(--pl-success)";
    const mode = sourceStatus.mode || "auto";
    const modeButton = (value, label, title) =>
      `<button class="mini-btn ${mode === value ? "" : "off"}" type="button" data-action="set-source-mode" data-mode="${value}" title="${title}">${label}</button>`;
    sourceBanner = `<div class="source-card" style="border-left:4px solid ${dot}">
      <div class="source-hd"><h3>Active data source</h3></div>
      <div class="source-meta">${escapeHtml(sourceStatus.label)} · ${sourceStatus.count} combos</div>
      <p class="source-note">
        Generated catalog: <b>${sourceStatus.generatedExists ? "present" : "missing"}</b> ·
        Fallback snapshot: <b>${sourceStatus.fallbackExists ? "ready" : "missing"}</b>.
        ${onFallback ? "Running on bundled fallback — live pull unavailable or not yet run." : isEmpty ? "No catalog available. Run a live pull from Connectors." : "Live catalog active. Bundled snapshot is the safety net."}
      </p>
      <div class="source-meta" style="margin-top:8px">Source mode:
        ${modeButton("auto", "Auto", "Use the live catalog when present, otherwise the bundled snapshot")}
        ${modeButton("live", "Live only", "Force the live-refreshed catalog; no snapshot fallback")}
        ${modeButton("fallback", "Bundled fallback", "Force the bundled snapshot — use when the live API is unreachable")}
      </div></div>`;
  }
  $("sources-body").innerHTML = `
    ${sourceBanner}
    <div class="src-stat" style="margin-bottom:12px"><div class="ss-num">${sources.reduce((count, source) => count + (source.combos || 0), 0)}</div><div class="ss-lbl">Priced combos from ${sources.length} source${sources.length !== 1 ? "s" : ""} · ${discontinued} discontinued</div></div>
    ${cards}
    <h4 class="src-h4">Live / external feeds</h4>
    ${live}`;
}

export async function openSourceRows(supplier) {
  try {
    const data = await fetchCatalogSourceRows(supplier);
    const rows = data.rows || [];
    const maxRows = 350;
    const rendered = rows.slice(0, maxRows).map((row) => {
      const status = row.included ? '<span class="row-status ok">included</span>' : `<span class="row-status off">${escapeHtml(row.reason)}</span>`;
      const classification = [row.classification?.treatment, row.classification?.tier ? categoryClassLabel(row.classification.tier) : "", row.classification?.material].filter(Boolean).join(" · ");
      return `<tr class="${row.included ? "" : "dim"}">
        <td>${status}</td>
        <td>${escapeHtml(row.name)}</td>
        <td>${escapeHtml(row.mftype)} · ${escapeHtml(row.lenstype)}</td>
        <td>${escapeHtml(row.material)}</td>
        <td class="num">${row.cost == null ? "—" : `$${Number(row.cost).toFixed(2)}`}</td>
        <td>${escapeHtml(classification || row.reason)}</td>
      </tr>`;
    }).join("");
    $("source-rows-title").textContent = `${SUP_ABBR[supplier] || supplier} catalog rows`;
    $("source-rows-meta").textContent = `${data.count || 0} loaded · ${data.included || 0} included in pricing · ${data.excluded || 0} excluded`;
    $("source-rows-body").innerHTML = rendered || '<tr><td colspan="6" class="pl-empty-state">No rows loaded for this supplier.</td></tr>';
    $("source-rows-limit").textContent = rows.length > maxRows ? `Showing first ${maxRows} rows.` : "";
    $("source-rows-overlay").classList.add("open");
  } catch (error) {
    toast(`Could not load source rows: ${error.message}`);
  }
}

export function closeSourceRows() {
  $("source-rows-overlay").classList.remove("open");
}

export async function toggleSourceExclude(supplier) {
  await app.supplierToggleExcludeAndReprice(supplier);
  await buildSourcesView();
}

export async function setSourceMode(mode) {
  try {
    const response = await postSourceMode(mode);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `HTTP ${response.status}`);
    }
    const status = await response.json();
    toast(`Data source: ${status.label} · ${status.count} combos`);
    location.reload();
  } catch (error) {
    toast(`Could not switch source: ${error.message}`);
  }
}

Object.assign(app, {
  buildSourcesView,
  closeSourceRows,
  openSourceRows,
  setSourceMode,
  toggleSourceExclude,
});
