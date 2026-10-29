const crypto = require("node:crypto");

// Rewrites a PDF produced by Chromium (classic xref table, no object streams)
// as an AES-128 (V4/R4) encrypted document with clean metadata. The user
// password, when given, is needed to open it; the owner password is random and
// discarded, so editing, copying and annotating stay locked while printing is
// allowed. Fails loudly on any structure it does not understand rather than
// emitting a corrupt file.

const PAD = Buffer.from("28BF4E5E4E758A4164004E56FFFA01082E2E00B6D0683E802F0CA9FE6453697A", "hex");
const PRINT = 1 << 2;
const PRINT_HIGH_QUALITY = 1 << 11;

function md5(...parts) {
  const hash = crypto.createHash("md5");
  parts.forEach((part) => hash.update(part));
  return hash.digest();
}

function rc4(key, data) {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let a = 0;
  let b = 0;
  for (let k = 0; k < data.length; k += 1) {
    a = (a + 1) & 255;
    b = (b + s[a]) & 255;
    [s[a], s[b]] = [s[b], s[a]];
    out[k] = data[k] ^ s[(s[a] + s[b]) & 255];
  }
  return out;
}

function padPassword(password) {
  return Buffer.concat([Buffer.from(String(password || ""), "latin1"), PAD]).subarray(0, 32);
}

function rc4Rounds(key, data) {
  let result = rc4(key, data);
  for (let i = 1; i <= 19; i += 1) result = rc4(Buffer.from(key.map((byte) => byte ^ i)), result);
  return result;
}

function computeKeys({ userPassword, ownerPassword, permissions, id }) {
  // Algorithm 3 (O entry), revision 4: 16-byte key.
  let ownerHash = md5(padPassword(ownerPassword));
  for (let i = 0; i < 50; i += 1) ownerHash = md5(ownerHash);
  const o = rc4Rounds(ownerHash.subarray(0, 16), padPassword(userPassword));
  // Algorithm 2 (file encryption key).
  const p = Buffer.alloc(4);
  p.writeInt32LE(permissions);
  let keyHash = md5(padPassword(userPassword), o, p, id);
  for (let i = 0; i < 50; i += 1) keyHash = md5(keyHash.subarray(0, 16));
  const key = keyHash.subarray(0, 16);
  // Algorithm 5 (U entry).
  const u = Buffer.concat([rc4Rounds(key, md5(PAD, id)), Buffer.alloc(16)]);
  return { key, o, u };
}

function objectKey(key, objectNumber) {
  const suffix = Buffer.from([objectNumber & 255, (objectNumber >> 8) & 255, (objectNumber >> 16) & 255, 0, 0]);
  return md5(key, suffix, Buffer.from("sAlT")).subarray(0, 16);
}

function aes(key, data) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([iv, cipher.update(data), cipher.final()]);
}

const hex = (buffer) => `<${buffer.toString("hex")}>`;

function pdfDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

function unescapeLiteral(body) {
  const out = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") { out.push(body.charCodeAt(i) & 255); continue; }
    i += 1;
    const next = body[i];
    const simple = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
    if (next in simple) out.push(simple[next]);
    else if (/[0-7]/.test(next)) {
      let octal = next;
      while (octal.length < 3 && /[0-7]/.test(body[i + 1] || "")) { i += 1; octal += body[i]; }
      out.push(parseInt(octal, 8) & 255);
    } else if (next === "\r") { if (body[i + 1] === "\n") i += 1; } else if (next !== "\n") out.push(next.charCodeAt(0) & 255);
  }
  return Buffer.from(out);
}

// Encrypts every string in a dictionary's text (literal and hex), leaving
// everything else untouched.
function encryptStrings(dictText, key) {
  let out = "";
  let i = 0;
  while (i < dictText.length) {
    const ch = dictText[i];
    if (ch === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < dictText.length && depth > 0) {
        if (dictText[j] === "\\") j += 2;
        else { if (dictText[j] === "(") depth += 1; else if (dictText[j] === ")") depth -= 1; j += 1; }
      }
      if (depth !== 0) throw new Error("Unterminated PDF string.");
      out += hex(aes(key, unescapeLiteral(dictText.slice(i + 1, j - 1))));
      i = j;
    } else if (ch === "<" && dictText[i + 1] !== "<") {
      const close = dictText.indexOf(">", i);
      if (close < 0) throw new Error("Unterminated PDF hex string.");
      let digits = dictText.slice(i + 1, close).replace(/\s+/g, "");
      if (digits.length % 2) digits += "0";
      out += hex(aes(key, Buffer.from(digits, "hex")));
      i = close + 1;
    } else if (ch === "<") { out += "<<"; i += 2; } else if (ch === ">" && dictText[i + 1] === ">") { out += ">>"; i += 2; } else { out += ch; i += 1; }
  }
  return out;
}

function parseObjects(pdf) {
  const text = pdf.toString("latin1");
  const startxref = text.lastIndexOf("startxref");
  if (startxref < 0) throw new Error("PDF has no startxref.");
  const xrefOffset = Number(text.slice(startxref + 9).trim().split(/\s+/)[0]);
  const xrefText = text.slice(xrefOffset, text.indexOf("trailer", xrefOffset));
  if (!/^xref\s/.test(xrefText) || /\/XRef/.test(text.slice(xrefOffset, xrefOffset + 200))) throw new Error("Unsupported PDF cross-reference format.");
  const trailer = text.slice(text.indexOf("trailer", xrefOffset), startxref);
  const root = trailer.match(/\/Root (\d+) 0 R/);
  const oldInfo = trailer.match(/\/Info (\d+) 0 R/);
  if (!root) throw new Error("PDF has no Root.");
  const objects = [];
  const section = xrefText.match(/^xref\s+(\d+)\s+(\d+)\s*\n([\s\S]*)$/);
  if (!section) throw new Error("Unsupported PDF cross-reference table.");
  const first = Number(section[1]);
  const entries = section[3].trim().split(/\r?\n/);
  entries.forEach((entry, index) => {
    const [offset, , flag] = entry.trim().split(/\s+/);
    if (flag !== "n") return;
    const number = first + index;
    const headerMatch = /^(\d+) 0 obj\s*/.exec(text.slice(Number(offset), Number(offset) + 32));
    if (!headerMatch || Number(headerMatch[1]) !== number) throw new Error(`Bad PDF object ${number}.`);
    const bodyStart = Number(offset) + headerMatch[0].length;
    const end = text.indexOf("endobj", bodyStart);
    const streamMatch = /stream\r?\n/.exec(text.slice(bodyStart, end));
    if (streamMatch && !/<<[\s\S]*>>\s*$/.test(text.slice(bodyStart, bodyStart + streamMatch.index))) throw new Error(`Bad PDF stream object ${number}.`);
    if (streamMatch) {
      const dict = text.slice(bodyStart, bodyStart + streamMatch.index).trim();
      const length = dict.match(/\/Length (\d+)(?! 0 R)/);
      if (!length) throw new Error(`PDF object ${number} has an indirect stream length.`);
      const dataStart = bodyStart + streamMatch.index + streamMatch[0].length;
      objects.push({ number, dict, stream: pdf.subarray(dataStart, dataStart + Number(length[1])) });
    } else {
      objects.push({ number, dict: text.slice(bodyStart, end).trim() });
    }
  });
  return { objects, rootNumber: Number(root[1]), oldInfoNumber: oldInfo ? Number(oldInfo[1]) : 0 };
}

function protectPdf(pdf, { userPassword = "", title = "", author = "", subject = "", keywords = "", creator = "", producer = "" } = {}) {
  const { objects, rootNumber, oldInfoNumber } = parseObjects(pdf);
  const ownerPassword = crypto.randomBytes(24).toString("hex");
  const id = crypto.randomBytes(16);
  const permissions = (0xFFFFF0C0 | PRINT | PRINT_HIGH_QUALITY) | 0;
  const { key, o, u } = computeKeys({ userPassword, ownerPassword, permissions, id });

  const maxNumber = Math.max(...objects.map((entry) => entry.number));
  const infoNumber = maxNumber + 1;
  const encryptNumber = maxNumber + 2;
  const now = pdfDate();
  const literal = (value) => `(${String(value).replace(/[\\()]/g, (ch) => `\\${ch}`)})`;
  const info = `<</Title ${literal(title)}/Author ${literal(author)}/Subject ${literal(subject)}/Keywords ${literal(keywords)}/Creator ${literal(creator)}/Producer ${literal(producer)}/CreationDate ${literal(now)}/ModDate ${literal(now)}>>`;

  const chunks = [Buffer.from("%PDF-1.6\n%âãÏÓ\n", "latin1")];
  let length = chunks[0].length;
  const offsets = new Map();
  const write = (buffer) => { chunks.push(buffer); length += buffer.length; };

  for (const entry of objects) {
    // Chromium's own Info dictionary is replaced by ours below.
    if (entry.number === oldInfoNumber) continue;
    const objKey = objectKey(key, entry.number);
    offsets.set(entry.number, length);
    let dict = encryptStrings(entry.dict, objKey);
    if (entry.stream) {
      const encrypted = aes(objKey, entry.stream);
      dict = dict.replace(/\/Length \d+/, `/Length ${encrypted.length}`);
      write(Buffer.concat([Buffer.from(`${entry.number} 0 obj\n${dict}\nstream\n`, "latin1"), encrypted, Buffer.from("\nendstream\nendobj\n")]));
    } else {
      write(Buffer.from(`${entry.number} 0 obj\n${dict}\nendobj\n`, "latin1"));
    }
  }

  offsets.set(infoNumber, length);
  write(Buffer.from(`${infoNumber} 0 obj\n${encryptStrings(info, objectKey(key, infoNumber))}\nendobj\n`, "latin1"));
  offsets.set(encryptNumber, length);
  write(Buffer.from(`${encryptNumber} 0 obj\n<</Filter /Standard/V 4/R 4/Length 128/CF <</StdCF <</AuthEvent /DocOpen/CFM /AESV2/Length 16>>>>/StmF /StdCF/StrF /StdCF/O ${hex(o)}/U ${hex(u)}/P ${permissions}>>\nendobj\n`, "latin1"));

  const xrefStart = length;
  const size = encryptNumber + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let number = 1; number < size; number += 1) {
    xref += offsets.has(number) ? `${String(offsets.get(number)).padStart(10, "0")} 00000 n \n` : "0000000000 65535 f \n";
  }
  write(Buffer.from(`${xref}trailer\n<</Size ${size}/Root ${rootNumber} 0 R/Info ${infoNumber} 0 R/Encrypt ${encryptNumber} 0 R/ID [${hex(id)}${hex(id)}]>>\nstartxref\n${xrefStart}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

module.exports = { protectPdf };
