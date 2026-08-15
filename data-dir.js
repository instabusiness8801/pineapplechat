/**
 * Where accounts, inbox, and reports are stored.
 * On Render's free plan the container disk is wiped on every deploy.
 * Mount a persistent disk and set DATA_DIR to that path (e.g. /var/data).
 */
const fs = require('fs');
const path = require('path');

function resolveDataDir() {
  const fromEnv = String(process.env.DATA_DIR || '').trim();
  if (fromEnv) return fromEnv;
  return path.join(__dirname, 'data');
}

const DATA_DIR = resolveDataDir();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

ensureDataDir();
console.log(`[data] directory: ${DATA_DIR}`);

module.exports = { DATA_DIR, ensureDataDir, resolveDataDir };
