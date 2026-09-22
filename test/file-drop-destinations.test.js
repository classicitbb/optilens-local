const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeDestination } = require("../lib/file-drop-destinations");

test("normalizes customer-scoped file-drop destinations without accepting relative paths", () => {
  const destination = normalizeDestination({
    destinationName: "RX incoming",
    purposeCode: "rx_capture",
    customerAccount: "5000150",
    folderPath: "\\\\server\\share\\rx",
    isActive: true
  });
  assert.equal(destination.purposeCode, "rx_capture");
  assert.equal(destination.customerAccount, "5000150");
  assert.equal(destination.folderPath, "\\\\server\\share\\rx");
  assert.throws(() => normalizeDestination({ destinationName: "Relative", purposeCode: "rx_capture", folderPath: "output/rx" }), /absolute drive or UNC/);
});
