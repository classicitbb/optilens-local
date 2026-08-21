'use strict';
const fs = require('node:fs'); const path = require('node:path');
const { protectString, unprotectString } = require('./windows-protected-store');
const FILE = path.join(__dirname, '..', 'data', 'qbo-production-secrets.json');
function load() { try { return JSON.parse(unprotectString(fs.readFileSync(FILE, 'utf8'))); } catch { return null; } }
function save(value) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); const tmp = `${FILE}.tmp`; fs.writeFileSync(tmp, protectString(JSON.stringify(value)), { mode: 0o600 }); fs.renameSync(tmp, FILE); return load(); }
function configured() { const value = load(); return value && value.environment === 'production' && value.clientId && value.clientSecret && value.refreshToken && value.realmId ? value : null; }
function clear() { try { fs.unlinkSync(FILE); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
module.exports = { configured, load, save, clear };
