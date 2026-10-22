const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function renderRow(identity) {
  const context = { window: {}, document: { readyState: "loading", addEventListener() {} } };
  const source = fs.readFileSync(path.join(__dirname, "../public/business-metrics-inventory-intelligence.js"), "utf8")
    .replace('  if (document.readyState === "loading")', '  window.renderInventoryRow = renderRow;\n  if (document.readyState === "loading")');
  vm.runInNewContext(source, context);
  const row = context.window.renderInventoryRow({ recommendationId: "fixture", itemId: "1:1:2:2:1:4827",
    itemLabel: "Stock lens", sku: "0037769668", itemIdentity: identity, evidence: {}, proposedSettings: {} });
  return row;
}

function renderMetadata(identity) {
  return renderRow(identity).match(/<div class="ii-sub ii-item-meta">([\s\S]*?)<\/div>/)[1];
}

test("queue lens names include optical values without diameter, base and add labels", () => {
  const row = renderRow({ name: "Plastic 1.50 · Vision-Ease · Flat Top 28 · UNCoated", diameter: 70,
    base: 4, addPower: 3, familyName: "Bifocal", bins: { right: "C2", left: "C2" } });
  const name = row.match(/<div class="ii-item-name">([\s\S]*?)<\/div>/)[1];
  assert.equal(name, "Plastic 1.50 · Vision-Ease · Flat Top 28 · UNCoated · 70 mm · 4.00 · +3.00");
  assert.doesNotMatch(name, /Diameter|Base|Add/);
});

test("single vision shows only its right bin even when the source left bin is populated", () => {
  const html = renderMetadata({ familyName: "Single Vision", bins: { right: "P8", left: "P9" } });
  assert.match(html, /SKU 0037769668/);
  assert.match(html, /Bin R P8/);
  assert.doesNotMatch(html, /P9|1:1:2:2:1:4827/);
});

test("progressive and bifocal show separate right and left bins including identical locations", () => {
  for (const familyName of ["Progressive", "Bifocal"]) {
    assert.match(renderMetadata({ familyName, bins: { right: "D4", left: "D5" } }), /Bins R D4 \/ L D5/);
    assert.match(renderMetadata({ familyName, bins: { right: "C2", left: "C2" } }), /Bins R C2 \/ L C2/);
  }
});

test("missing bins and unknown source families stay explicit without showing the database key", () => {
  assert.match(renderMetadata({ familyName: "Bifocal", bins: { right: "C2" } }), /R C2 \/ L not set/);
  assert.match(renderMetadata({ familyName: "Single Vision", bins: {} }), /Bin R not set/);
  for (const identity of [null, { familyName: "Unknown", bins: { right: "C2", left: "C3" } }]) {
    const html = renderMetadata(identity);
    assert.match(html, /Bins unavailable/);
    assert.doesNotMatch(html, /1:1:2:2:1:4827/);
  }
});

test("source bin labels are escaped as text", () => {
  const html = renderMetadata({ familyName: "Bifocal", bins: { right: '<img src=x onerror="alert(1)">', left: "A&B" } });
  assert.match(html, /&lt;img/);
  assert.match(html, /A&amp;B/);
  assert.doesNotMatch(html, /<img/);
});
