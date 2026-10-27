const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MODULE_ACCESS, MODULE_PAGES } = require("../lib/auth");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// Launch-pad entries that are deliberately not a role-assignable module.
const NOT_MODULES = new Set(["launch-pad", "release-notes", "users", "credentials", "settings"]);

function launcherEntries() {
  const source = read("public/shared.js");
  return [...source.matchAll(/\{\s*id:\s*"([^"]+)"[^}]*?href:\s*"([^"]+)"[^}]*?permissions:\s*\[([^\]]*)\]/g)]
    .map(([, id, href, permissions]) => ({ id, href, permissions: [...permissions.matchAll(/"([^"]+)"/g)].map((m) => m[1]) }));
}

test("every launch-pad module has a role-assignable permission entry", () => {
  const codes = new Set(MODULE_ACCESS.map((module) => module.code));
  const modules = launcherEntries().filter((entry) => !NOT_MODULES.has(entry.id) && entry.href.startsWith("/") && !entry.href.startsWith("/api/"));
  assert.ok(modules.length >= 10, "launcher entries were parsed");
  for (const entry of modules) {
    assert.ok(codes.has(entry.id), `${entry.id} is missing from MODULE_ACCESS`);
  }
});

test("launch-pad visibility uses the same permissions the module grants", () => {
  for (const entry of launcherEntries()) {
    const module = MODULE_ACCESS.find((item) => item.code === entry.id);
    if (!module) continue;
    const granted = new Set(module.readPermissions.concat(module.fullPermissions));
    assert.ok(entry.permissions.length > 0, `${entry.id} must require a permission`);
    for (const permission of entry.permissions) {
      assert.ok(granted.has(permission), `${entry.id} lists ${permission}, which its module does not grant`);
    }
  }
});

test("module entries are well formed and no permission belongs to two modules", () => {
  const seen = new Map();
  for (const module of MODULE_ACCESS) {
    assert.ok(module.readPermissions.length > 0, `${module.code} needs a read permission`);
    for (const permission of module.readPermissions.concat(module.fullPermissions)) {
      assert.ok(!seen.has(permission), `${permission} is used by ${seen.get(permission)} and ${module.code}`);
      seen.set(permission, module.code);
    }
  }
});

test("every module with a page has its routes registered", () => {
  for (const module of MODULE_ACCESS) {
    assert.ok((MODULE_PAGES[module.code] || []).length > 0, `${module.code} has no page routes for the access guard`);
  }
});
