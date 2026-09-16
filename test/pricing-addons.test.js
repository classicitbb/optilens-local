const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const loadState = () => import(pathToFileURL(path.join(root, "public/tools/pricing-automation/modules/state.js")).href);

test("pricelist settings carry editable coatings, defaulting older lists to the standard set", async () => {
  const { ADDONS, createDefaultSettings, normalizeSettings } = await loadState();
  assert.deepEqual(createDefaultSettings().addons, ADDONS);
  assert.deepEqual(normalizeSettings({ floorMargin: 0.2 }).addons, ADDONS);

  const edited = normalizeSettings({ addons: [{ label: "Mirror Coat", price: "18.5" }, { label: "Bad", price: -4 }, null] });
  assert.deepEqual(edited.addons, [{ label: "Mirror Coat", price: 18.5 }, { label: "Bad", price: 0 }]);
  assert.deepEqual(normalizeSettings({ addons: [] }).addons, []);
});

test("builder renders an editable coatings matrix under the lens grid and previews from it", () => {
  const markup = read("public/tools/pricing-automation/index.html");
  const builder = read("public/tools/pricing-automation/modules/builder-view.js");
  const boot = read("public/tools/pricing-automation/modules/boot.js");
  assert.match(markup, /id="matrix-container"><\/div>\s*<div id="addons-container"><\/div>/);
  assert.match(builder, /data-action="add-addon"/);
  assert.match(builder, /data-action="remove-addon"/);
  assert.match(builder, /state\.settings\.addons \|\| \[\]\)\.filter\(\(addon\) => addon\.label\)/);
  assert.doesNotMatch(builder, /\bADDONS\b/);
  assert.match(boot, /target\.matches\("\.addon-input"\)[\s\S]*?app\.onAddonEdit/);
});

test("coatings card is a keyboard-operable accordion that starts collapsed", () => {
  const builder = read("public/tools/pricing-automation/modules/builder-view.js");
  const boot = read("public/tools/pricing-automation/modules/boot.js");
  assert.match(builder, /const addonsCollapsed = \(\) => state\.collapsed\[ADDONS_COLLAPSE_KEY\] !== false;/);
  assert.match(builder, /aria-expanded="\$\{!isCollapsed\}" data-action="toggle-collapse" data-treatment="\$\{ADDONS_COLLAPSE_KEY\}"/);
  assert.match(builder, /state\.collapsed\[ADDONS_COLLAPSE_KEY\] = collapsed;/);
  assert.match(boot, /target\.matches\("\.matrix-hdr\[data-action\]"\)/);
});
