const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("OS Lab status inbox is served from its own module route with automation permissions", () => {
  const server = read("server.js");
  assert.match(server, /"\/modules\/os-lab-status":\s+"supplier-email\.html"/);
  assert.match(server, /"\/modules\/os-lab-status": \["automation\.read", "automation\.manage"\]/);
  assert.match(server, /"\/modules\/automation\/supplier-email":\s+"supplier-email\.html"/,
    "the old Automation URL must keep working for existing bookmarks");
});

test("OS Lab status inbox appears on the launch pad and in the shell launcher", () => {
  const launchPad = read("public/app.js");
  const shared = read("public/shared.js");
  assert.match(launchPad, /id: "os-lab-status",[\s\S]*?href: "\/modules\/os-lab-status"/);
  assert.match(shared, /id: "os-lab-status",[\s\S]*?href: "\/modules\/os-lab-status"/);
  assert.match(shared, /"\/modules\/os-lab-status": \{\s*crumb: "OS Lab Status Update Inbox"/);
});

test("Automation no longer embeds the inbox in an iframe tab", () => {
  const automation = read("public/automation.html");
  assert.doesNotMatch(automation, /supplier-email/);
  assert.doesNotMatch(automation, /<iframe/);
});

test("OS Lab status inbox page fills the window like Delivery & Export", () => {
  const page = read("public/supplier-email.html");
  const css = read("public/styles/pages/automation.css");
  assert.match(page, /<body class="module-body automation-email-page os-lab-inbox-page">/);
  assert.match(css, /\.os-lab-inbox-page \.module-main \{[^}]*max-width:none;[^}]*padding:0;/);
  assert.match(css, /\.os-lab-inbox-page \.module-main \{ height:calc\(100vh - 56px\);/);
  assert.match(css, /\.os-lab-inbox-page \.mailbox-list,\s*\.os-lab-inbox-page \.records-table-wrap \{[^}]*max-height:none;/);
});
