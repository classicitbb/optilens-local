const test = require("node:test");
const assert = require("node:assert/strict");
const { addressList, displayNameForFolder, folderSortKey, parseRecipients, safeFilename, snippetFrom } = require("../lib/email/message-utils");
const { bearerToken, createSupabaseStaffAuth } = require("../lib/email/supabase-auth");
const { isAllowedOrigin } = require("../lib/email/routes");

test("addressList flattens mailparser address objects and groups", () => {
  const field = { value: [
    { address: "Iris@BayStreet.bb", name: "Iris Clarke" },
    { name: "Team", group: [{ address: "a@x.com", name: "" }, { address: "not-an-address", name: "x" }] }
  ] };
  assert.deepEqual(addressList(field), [
    { address: "iris@baystreet.bb", name: "Iris Clarke" },
    { address: "a@x.com", name: null }
  ]);
  assert.deepEqual(addressList(undefined), []);
});

test("snippet skips quoted lines and truncates", () => {
  assert.equal(snippetFrom("Hello\n> old reply\nthere"), "Hello there");
  assert.equal(snippetFrom("x".repeat(400)).length, 280);
});

test("safeFilename strips path and reserved characters", () => {
  assert.equal(safeFilename("..\\..\\evil:name?.pdf"), "evil_name_.pdf");
  assert.equal(safeFilename(""), "attachment");
});

test("folders sort Inbox first and use friendly names", () => {
  assert.equal(displayNameForFolder("INBOX.Sent", "\\Sent"), "Sent Items");
  assert.equal(displayNameForFolder("INBOX.Suppliers", null), "Suppliers");
  const sorted = [{ special_use: null, display_name: "Suppliers" }, { special_use: "\\Sent", display_name: "Sent Items" }, { special_use: "\\Inbox", display_name: "Inbox" }]
    .sort((a, b) => folderSortKey(a).localeCompare(folderSortKey(b)));
  assert.deepEqual(sorted.map((f) => f.display_name), ["Inbox", "Sent Items", "Suppliers"]);
});

test("parseRecipients accepts lists and display names, rejects junk", () => {
  assert.deepEqual(parseRecipients("Iris <iris@bay.bb>; marcus@g.bb, IRIS@bay.bb"), ["iris@bay.bb", "marcus@g.bb"]);
  assert.throws(() => parseRecipients("nobody"), /not a valid email address/);
});

test("bearer token parsing", () => {
  assert.equal(bearerToken("Bearer abc.def"), "abc.def");
  assert.equal(bearerToken("Basic xyz"), null);
});

function fakeFetch(roles) {
  return async (url) => {
    if (url.endsWith("/auth/v1/user")) return { ok: true, status: 200, json: async () => ({ id: "u1", email: "staff@cv.bb" }) };
    return { ok: true, status: 200, json: async () => roles.map((role) => ({ role })) };
  };
}

test("staff auth accepts admin/operator and rejects others", async () => {
  const ok = createSupabaseStaffAuth({ getAnonKey: () => "anon", fetchFn: fakeFetch(["operator"]) });
  assert.deepEqual(await ok.verify("Bearer t"), { id: "u1", email: "staff@cv.bb" });
  const viewer = createSupabaseStaffAuth({ getAnonKey: () => "anon", fetchFn: fakeFetch(["viewer"]) });
  await assert.rejects(viewer.verify("Bearer t"), (error) => error.statusCode === 403);
  await assert.rejects(ok.verify(undefined), (error) => error.statusCode === 401);
});

test("staff auth reports an expired session as 401", async () => {
  const auth = createSupabaseStaffAuth({ getAnonKey: () => "anon", fetchFn: async () => ({ ok: false, status: 401, json: async () => ({}) }) });
  await assert.rejects(auth.verify("Bearer t"), (error) => error.statusCode === 401);
});

test("CORS allows OpticAdmin origins only", () => {
  assert.equal(isAllowedOrigin("https://www.classicvisions.net"), true);
  assert.equal(isAllowedOrigin("https://classicvisions.lovable.app"), true);
  assert.equal(isAllowedOrigin("https://abc-123.lovable.app"), false);
  assert.equal(isAllowedOrigin("https://evil.example"), false);
  assert.equal(isAllowedOrigin(""), false);
});
