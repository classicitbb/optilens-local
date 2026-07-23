const assert = require("node:assert/strict");
const test = require("node:test");
const { protectString, unprotectString } = require("../lib/windows-protected-store");

test("protects auth-session payloads with the current Windows user profile", () => {
  const original = JSON.stringify([["a".repeat(64), { userId: "user-1", expiresAt: 123456789 }]]);
  const protectedValue = protectString(original);

  assert.notEqual(protectedValue, original);
  assert.equal(unprotectString(protectedValue), original);
});
