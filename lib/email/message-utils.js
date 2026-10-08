// Pure helpers shared by the email sync and API. No I/O here so they can be
// unit tested without a mail server or database.

const SPECIAL_USE_ORDER = ["\\Inbox", "\\Drafts", "\\Sent", "\\Archive", "\\Junk", "\\Trash"];

function normalizeAddress(value) {
  const address = String(value || "").trim().toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+$/.test(address) ? address : null;
}

// mailparser AddressObject (or array of them) -> [{ address, name }]
function addressList(field) {
  const groups = Array.isArray(field) ? field : field ? [field] : [];
  const out = [];
  for (const group of groups) {
    for (const entry of group.value || []) {
      const members = Array.isArray(entry.group) ? entry.group : [entry];
      for (const member of members) {
        const address = normalizeAddress(member.address);
        if (address) out.push({ address, name: String(member.name || "").trim() || null });
      }
    }
  }
  return out;
}

function snippetFrom(text, max = 280) {
  const collapsed = String(text || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*>/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function safeFilename(name, fallback = "attachment") {
  const base = String(name || "").split(/[\\/]/).pop();
  const cleaned = base.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").replace(/^\.+/, "").trim().slice(0, 180);
  return cleaned || fallback;
}

function displayNameForFolder(path, specialUse) {
  const names = { "\\Inbox": "Inbox", "\\Sent": "Sent Items", "\\Drafts": "Drafts", "\\Trash": "Deleted Items", "\\Junk": "Junk Email", "\\Archive": "Archive" };
  if (specialUse && names[specialUse]) return names[specialUse];
  const parts = String(path || "").split(/[./]/);
  return parts[parts.length - 1] || path;
}

function folderSortKey(folder) {
  const index = SPECIAL_USE_ORDER.indexOf(folder.special_use);
  return `${index === -1 ? 9 : index}-${String(folder.display_name || "").toLowerCase()}`;
}

function parseRecipients(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(/[,;\n]+/);
  const out = [];
  for (const item of list) {
    const match = String(item).match(/<([^>]+)>/);
    const address = normalizeAddress(match ? match[1] : item);
    if (!address) {
      if (String(item).trim()) throw Object.assign(new Error(`"${String(item).trim()}" is not a valid email address.`), { statusCode: 400 });
      continue;
    }
    if (!out.includes(address)) out.push(address);
  }
  return out;
}

module.exports = { addressList, displayNameForFolder, folderSortKey, normalizeAddress, parseRecipients, safeFilename, snippetFrom, SPECIAL_USE_ORDER };
