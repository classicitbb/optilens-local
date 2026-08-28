const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("the OptiLens system declares the shared Classic Visions semantic foundation", () => {
  const tokens = read("public/styles/tokens.css");
  const system = read("public/styles/system.css");

  for (const token of [
    "--cv-navy", "--cv-teal", "--cv-gold", "--cv-linen",
    "--color-canvas", "--color-surface", "--color-text",
    "--color-interactive", "--color-accent", "--space-24"
  ]) {
    assert.match(tokens, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${token} must remain a shared token`);
  }

  for (const primitive of [".button", ".badge", ".workflow-tabs", ".module-workspace", ".table-wrap"]) {
    assert.match(system, new RegExp(primitive.replace(".", "\\.")), `${primitive} must have a system definition`);
  }
  assert.match(system, /prefers-reduced-motion/, "the system must preserve reduced-motion support");
});

test("all application surfaces load the final common system stylesheet", () => {
  const pages = [
    "index.html", "login.html", "admin-users.html", "automation.html",
    "business-metrics.html", "credentials.html", "delivery-export.html",
    "integrations.html", "pricing-automation.html", "release-notes.html",
    "settings.html", "statement-template.html", "supplier-email.html",
    "tools/pricing-automation/index.html"
  ];

  for (const page of pages) {
    assert.match(read(`public/${page}`), /href="\/styles\/system\.css"/,
      `${page} must load the shared visual system after its local layout CSS`);
  }

  const statement = read("public/statement-template.html");
  assert.match(statement, /href="\/styles\/tokens\.css"/,
    "the printable statement must receive the same type and colour tokens without inheriting app shell markup");
});

test("automation and integration capability icons use system variants instead of inline brand colours", () => {
  for (const page of ["public/automation.html", "public/integrations.html"]) {
    const html = read(page);
    assert.match(html, /icon--(?:navy|teal|success|gold)/, `${page} must use system icon variants`);
    assert.doesNotMatch(html, /style="background:#(?:7c3aed|1A8A9C|389457|C89130|b45309)"/,
      `${page} must not embed palette values in component markup`);
  }
});
