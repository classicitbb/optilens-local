const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function deliveryError(message, statusCode = 409) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function resolveDirectory(root, configuredPath, label) {
  if (typeof configuredPath !== "string" || !configuredPath.trim()) {
    throw deliveryError(`${label} is not configured.`, 503);
  }
  return path.resolve(root, configuredPath);
}

function resolveFile(directory, filename, extension) {
  const name = String(filename || "");
  if (!name || path.basename(name) !== name || !name.endsWith(extension)) {
    throw deliveryError("The approved RX filename is invalid.");
  }
  const target = path.resolve(directory, name);
  const relative = path.relative(directory, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw deliveryError("The approved RX filename is outside its configured folder.");
  }
  return target;
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function existingFileMatches(file, expectedHash) {
  return fs.existsSync(file) && sha256(fs.readFileSync(file)) === expectedHash;
}

function atomicWriteMatching(file, content, expectedHash, label) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    if (existingFileMatches(file, expectedHash)) return { reused: true };
    throw deliveryError(`A different ${label} file already uses this approved RX filename.`);
  }

  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  try {
    const descriptor = fs.openSync(temporary, "wx");
    try {
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      if (fs.existsSync(file) && existingFileMatches(file, expectedHash)) return { reused: true };
      throw error;
    }
    return { reused: false };
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function stageApprovedRx({ root, config, filename, content, expectedHash }) {
  const stageDirectory = resolveDirectory(root, config?.folders?.staging, "RX Capture staging folder");
  const stagingPath = resolveFile(stageDirectory, filename, config?.output?.extension || ".rx");
  const hash = sha256(content);
  if (hash !== expectedHash) throw deliveryError("The approved RX content integrity check failed.");
  atomicWriteMatching(stagingPath, content, hash, "staged");
  return { filename, sha256: hash, stagingPath };
}

function releaseApprovedRx({ root, config, filename, expectedHash }) {
  const extension = config?.output?.extension || ".rx";
  const stagingPath = resolveFile(resolveDirectory(root, config?.folders?.staging, "RX Capture staging folder"), filename, extension);
  const archivePath = resolveFile(resolveDirectory(root, config?.folders?.archive, "RX Capture archive folder"), filename, extension);
  const incomingPath = resolveFile(resolveDirectory(root, config?.folders?.incoming, "Innovations incoming folder"), filename, extension);
  if (!fs.existsSync(stagingPath)) throw deliveryError("The approved staged RX file is unavailable.");
  const content = fs.readFileSync(stagingPath);
  const hash = sha256(content);
  if (hash !== expectedHash) throw deliveryError("The staged RX content integrity check failed.");

  // Keep the recoverable copy before making the file visible to Innovations.
  const archive = atomicWriteMatching(archivePath, content, hash, "archived");
  const incoming = atomicWriteMatching(incomingPath, content, hash, "Innovations incoming");
  // A matching incoming file means a previous attempt completed the external
  // handoff before its database status could be recorded. Returning that fact
  // lets the caller finish the audit without writing a second RX file.
  return { filename, sha256: hash, archiveReused: archive.reused, incomingReused: incoming.reused };
}

module.exports = { atomicWriteMatching, releaseApprovedRx, resolveDirectory, resolveFile, sha256, stageApprovedRx };
