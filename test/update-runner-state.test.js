const assert = require("node:assert/strict");
const test = require("node:test");
const { shouldReleaseScheduledUpdate } = require("../lib/update-runner-state");

test("releases only the matching scheduled update when no durable runner state appears", () => {
  const scheduled = { requestedAt: "2026-08-28T20:00:00.000Z" };

  assert.equal(shouldReleaseScheduledUpdate(scheduled, scheduled.requestedAt, null), true);
  assert.equal(shouldReleaseScheduledUpdate(scheduled, "2026-08-28T20:00:01.000Z", null), false);
  assert.equal(shouldReleaseScheduledUpdate(scheduled, scheduled.requestedAt, { status: "running" }), false);
});
