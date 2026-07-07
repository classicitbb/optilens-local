import { $, app, escHtml, isComboDisabled, isPriceProfitable, state, SUP_ABBR, sym, TIER_DISPLAY, toDisplay, toast } from "./state.js";
import { lineClassificationChips } from "./classification-view.js";

export function setSourcingSort(field) {
  if (state.sourcingSort.field === field) state.sourcingSort.dir = state.sourcingSort.dir === "asc" ? "desc" : "asc";
  else state.sourcingSort = { field, dir: field === "price" || field === "labs" ? "desc" : "asc" };
  buildSourcingView();
}

function sourcingSortMark(field) {
  return state.sourcingSort.field === field ? (state.sourcingSort.dir === "asc" ? "▲" : "▼") : "";
}

function renderSourcingHead() {
  const head = $("sourcing-head");
  if (!head) return;
  const th = (field, label, className = "") => `<th class="${className}"><button type="button" data-action="sort-sourcing" data-field="${field}">${label} <span>${sourcingSortMark(field)}</span></button></th>`;
  head.innerHTML = `<tr>
    ${th("line", "Line")}
    ${th("classification", "Classification")}
    ${th("price", "Wholesale", "num")}
    ${th("anchor", "Anchor (worst case)")}
    ${th("preferred", "Preferred source")}
    ${th("labs", "Labs")}
    ${th("flag", "Flag")}
  </tr>`;
}

function compareValues(left, right) {
  if (typeof left === "number" || typeof right === "number") return (Number(left) || 0) - (Number(right) || 0);
  return String(left || "").localeCompare(String(right || ""), undefined, { numeric: true, sensitivity: "base" });
}

function sortSourcingRows(rows) {
  const dir = state.sourcingSort.dir === "desc" ? -1 : 1;
  return rows.slice().sort((left, right) => {
    const primary = compareValues(left.sort[state.sourcingSort.field], right.sort[state.sourcingSort.field]) * dir;
    return primary || compareValues(left.sort.line, right.sort.line);
  });
}

export async function buildSourcingView() {
  try {
    await app.loadClassify();
  } catch {
    // loadClassify renders its own empty state
  }

  const rows = Object.entries(state.prices).map(([key, price]) => {
    if (isComboDisabled(key)) return null;
    const combo = state.comboByKey[key];
    if (!combo) return null;
    if (state.settings.hiddenGroups.includes(combo.treatment)) return null;
    const [treatment, tier, material] = key.split("||");
    const display = TIER_DISPLAY[tier] || { grade: tier, name: "" };
    const line = `${treatment} · ${display.grade} (${display.name}) · ${material}`;
    const flagScore = price.constraintSupplier ? 2 : combo.supplierCount === 1 ? 1 : 0;
    return {
      key,
      price,
      combo,
      line,
      single: combo.supplierCount === 1,
      constrained: !!price.constraintSupplier,
      sort: {
        line,
        classification: `${combo.treatment || ""} ${combo.tier || ""} ${combo.material || ""}`,
        price: Number(price.priceUSD) || 0,
        anchor: `${price.anchorSupplier || ""} ${Number(price.floorMargin) || 0}`,
        preferred: `${price.preferredSupplier || ""} ${Number(price.preferredMargin) || 0}`,
        labs: Number(combo.supplierCount) || 0,
        flag: flagScore,
      },
    };
  }).filter(Boolean);

  const priced = rows.length;
  const single = rows.filter((row) => row.single);
  const constrained = rows.filter((row) => row.constrained);
  const unsafe = rows.filter((row) => !isPriceProfitable(row.price));
  const flagged = sortSourcingRows(rows.filter((row) => row.single || row.constrained || !isPriceProfitable(row.price)));

  renderSourcingHead();
  $("sourcing-summary").innerHTML = `
    <div class="src-stat"><div class="ss-num">${priced}</div><div class="ss-lbl">Priced lines</div></div>
    <div class="src-stat"><div class="ss-num" style="color:var(--pl-gold)">${single.length}</div><div class="ss-lbl">Single-source</div></div>
    <div class="src-stat"><div class="ss-num" style="color:var(--pl-teal)">${constrained.length}</div><div class="ss-lbl">Source-constrained</div></div>
    <div class="src-stat"><div class="ss-num" style="color:var(--pl-danger)">${unsafe.length}</div><div class="ss-lbl">Below margin floor</div></div>`;

  if (!priced) {
    $("sourcing-body").innerHTML = '<tr><td colspan="7" class="pl-empty-state">Run Auto-Price first.</td></tr>';
    return;
  }
  if (!flagged.length) {
    $("sourcing-body").innerHTML = '<tr><td colspan="7" class="pl-empty-state">All clear — every priced line has multi-supplier fallback.</td></tr>';
    return;
  }

  $("sourcing-body").innerHTML = flagged.map((row) => {
    const flag = !isPriceProfitable(row.price)
      ? '<span class="flag flag-low">below floor</span>'
      : row.constrained
        ? `<span class="flag flag-con">⚑ ${SUP_ABBR[row.price.constraintSupplier] || row.price.constraintSupplier} only</span>`
        : '<span class="flag flag-sin">single-source</span>';
    return `<tr>
      <td>${escHtml(row.line)}</td>
      <td class="src-classes">${lineClassificationChips(row.combo)}</td>
      <td class="num">${sym()}${toDisplay(row.price.priceUSD).toFixed(2)}</td>
      <td>${escHtml(SUP_ABBR[row.price.anchorSupplier] || row.price.anchorSupplier)} <span class="muted">${(row.price.floorMargin * 100).toFixed(0)}%</span></td>
      <td>${escHtml(SUP_ABBR[row.price.preferredSupplier] || row.price.preferredSupplier)} <span class="muted">${(row.price.preferredMargin * 100).toFixed(0)}%</span></td>
      <td>${row.combo.supplierCount}</td>
      <td>${flag}</td>
    </tr>`;
  }).join("");
}

Object.assign(app, {
  buildSourcingView,
  setSourcingSort,
});
