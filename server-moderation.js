/**
 * Site-wide moderation: owner bans + automatic temporary IP blocks.
 * Stored in DATA_DIR/bans.json (backed up to the Gist with the other data files).
 *
 * Ban entry:
 *   { id, kind: 'manual'|'auto', at, expiresAt|null, liftedAt|null, liftedBy|null,
 *     email|null, ips[], deviceIds[], tokens[], name|null, reason, by|null, reportIds[] }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { DATA_DIR, ensureDataDir } = require(path.join(__dirname, 'data-dir.js'));
const BANS_FILE = path.join(DATA_DIR, 'bans.json');

const BAN_MESSAGE = 'You have been banned for violating the rules.';
const AUTO_BLOCK_REPORTS = 3;
const AUTO_BLOCK_WINDOW_MS = 24 * 60 * 60 * 1000;
const AUTO_BLOCK_DURATION_MS = 5 * 24 * 60 * 60 * 1000;
const MAX_HISTORY = 300;

let bans = [];
// IPs / device ids recently used by the owner account — never banned or auto-blocked.
let ownerSeen = { ips: [], deviceIds: [] };

// ---------- IP helpers ----------
function normalizeIp(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (s.startsWith('::ffff:')) s = s.slice(7);
  // "1.2.3.4:5678" -> "1.2.3.4"
  const m = s.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (m) s = m[1];
  if (s.startsWith('[') && s.includes(']')) s = s.slice(1, s.indexOf(']'));
  return s.slice(0, 64);
}

/**
 * Loopback / private / link-local addresses are never IP-banned: behind a proxy they would be the
 * proxy's own address (shared by every visitor), and locally they are the developer's machine.
 */
function isLocalIp(ip) {
  const s = normalizeIp(ip);
  if (!s || s === '::1' || s === '::' || s === 'localhost' || s === '0.0.0.0' || s === 'unknown') return true;
  if (/^(127|10)\./.test(s)) return true;
  if (/^192\.168\./.test(s)) return true;
  if (/^169\.254\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(s)) return true; // carrier-grade NAT / internal
  if (/^f[cd][0-9a-f]{2}:/.test(s) || /^fe80:/.test(s)) return true;
  return false;
}

/** Trust proxy headers on Render (RENDER env is set there) or when TRUST_PROXY=true. */
function trustProxy() {
  const v = String(process.env.TRUST_PROXY || '').trim().toLowerCase();
  if (v === 'false' || v === '0' || v === 'no') return false;
  if (v) return true;
  return !!process.env.RENDER;
}

function clientIpFrom(headers, remoteAddress) {
  const h = headers || {};
  if (trustProxy()) {
    const cf = String(h['cf-connecting-ip'] || '').trim();
    if (cf) return normalizeIp(cf);
    const xff = String(h['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return normalizeIp(xff);
  }
  return normalizeIp(remoteAddress);
}

function cleanDeviceId(raw) {
  const s = String(raw || '').trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(s) ? s : null;
}

// ---------- persistence ----------
function load() {
  bans = [];
  ownerSeen = { ips: [], deviceIds: [] };
  try {
    ensureDataDir();
    if (!fs.existsSync(BANS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(BANS_FILE, 'utf8') || '{}');
    const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.bans) ? raw.bans : []);
    bans = list.filter((b) => b && b.id);
    if (raw && raw.ownerSeen) {
      ownerSeen.ips = Array.isArray(raw.ownerSeen.ips) ? raw.ownerSeen.ips.slice(-20) : [];
      ownerSeen.deviceIds = Array.isArray(raw.ownerSeen.deviceIds) ? raw.ownerSeen.deviceIds.slice(-20) : [];
    }
  } catch (e) {
    console.warn('[moderation] bans load:', e.message);
  }
}

function trimHistory() {
  const active = bans.filter((b) => isActive(b));
  const old = bans.filter((b) => !isActive(b)).slice(-MAX_HISTORY);
  bans = old.concat(active).sort((a, b) => a.at - b.at);
}

function save() {
  try {
    ensureDataDir();
    trimHistory();
    fs.writeFileSync(BANS_FILE, JSON.stringify({ bans, ownerSeen }, null, 2));
    try {
      require(path.join(__dirname, 'data-backup.js')).schedulePush();
    } catch (e) { /* ignore */ }
  } catch (e) {
    console.warn('[moderation] bans save:', e.message);
  }
}

// ---------- queries ----------
function isActive(b, now) {
  if (!b || b.liftedAt) return false;
  if (b.expiresAt && b.expiresAt <= (now || Date.now())) return false;
  return true;
}

function activeBans() {
  const now = Date.now();
  return bans.filter((b) => isActive(b, now));
}

/**
 * ctx: { email, ip, deviceId, token }
 * isOwnerFn(email) -> owner accounts are never banned.
 */
function findBan(ctx, isOwnerFn) {
  if (!ctx) return null;
  const email = ctx.email ? String(ctx.email).toLowerCase() : null;
  if (email && isOwnerFn && isOwnerFn(email)) return null;
  const ip = ctx.ip ? normalizeIp(ctx.ip) : null;
  const dev = ctx.deviceId || null;
  const tok = ctx.token || null;
  for (const b of activeBans()) {
    if (email && b.email && b.email === email) return b;
    if (ip && !isLocalIp(ip) && (b.ips || []).includes(ip)) return b;
    if (dev && (b.deviceIds || []).includes(dev)) return b;
    if (tok && (b.tokens || []).includes(tok)) return b;
  }
  return null;
}

function matchesBan(b, ctx, isOwnerFn) {
  if (!b || !ctx) return false;
  const email = ctx.email ? String(ctx.email).toLowerCase() : null;
  if (email && isOwnerFn && isOwnerFn(email)) return false;
  const ip = ctx.ip ? normalizeIp(ctx.ip) : null;
  if (email && b.email && b.email === email) return true;
  if (ip && !isLocalIp(ip) && (b.ips || []).includes(ip)) return true;
  if (ctx.deviceId && (b.deviceIds || []).includes(ctx.deviceId)) return true;
  if (ctx.token && (b.tokens || []).includes(ctx.token)) return true;
  return false;
}

function banPayload(b) {
  if (!b) return null;
  if (b.kind === 'auto') {
    const until = b.expiresAt ? new Date(b.expiresAt).toUTCString() : 'further notice';
    return {
      banned: true,
      kind: 'auto',
      until: b.expiresAt || null,
      message: 'You are temporarily blocked because several people reported you. The block lifts automatically on ' + until + '.'
    };
  }
  return {
    banned: true,
    kind: 'manual',
    until: b.expiresAt || null,
    message: BAN_MESSAGE
  };
}

// ---------- owner-seen protection ----------
function noteOwnerSeen(ip, deviceId) {
  let changed = false;
  const nip = normalizeIp(ip);
  if (nip && !isLocalIp(nip) && !ownerSeen.ips.includes(nip)) {
    ownerSeen.ips.push(nip);
    ownerSeen.ips = ownerSeen.ips.slice(-20);
    changed = true;
  }
  if (deviceId && !ownerSeen.deviceIds.includes(deviceId)) {
    ownerSeen.deviceIds.push(deviceId);
    ownerSeen.deviceIds = ownerSeen.deviceIds.slice(-20);
    changed = true;
  }
  if (changed) save();
}

function isOwnerIp(ip) {
  const nip = normalizeIp(ip);
  return !!nip && ownerSeen.ips.includes(nip);
}

// ---------- mutations ----------
function uniq(list) {
  return Array.from(new Set((list || []).filter(Boolean)));
}

/**
 * Create a manual ban. target: { email, ips[], deviceIds[], tokens[], name, reportId }
 * excludeIps / excludeDevices are owner identifiers that must never be banned.
 */
function addManualBan(target, opts) {
  const o = opts || {};
  const excludeIps = new Set((o.excludeIps || []).map(normalizeIp).concat(ownerSeen.ips));
  const excludeDevs = new Set((o.excludeDevices || []).concat(ownerSeen.deviceIds));
  const email = target.email ? String(target.email).toLowerCase() : null;
  const ips = uniq((target.ips || []).map(normalizeIp)).filter((ip) => !isLocalIp(ip) && !excludeIps.has(ip));
  const deviceIds = uniq(target.deviceIds).filter((d) => !excludeDevs.has(d));
  const tokens = uniq(target.tokens);
  if (!email && !ips.length && !deviceIds.length && !tokens.length) {
    return { ok: false, message: 'Nothing to ban: that user has no account, IP, device or session on record.' };
  }
  const entry = {
    id: crypto.randomBytes(8).toString('hex'),
    kind: 'manual',
    at: Date.now(),
    expiresAt: null,
    liftedAt: null,
    liftedBy: null,
    email,
    ips,
    deviceIds,
    tokens,
    name: target.name ? String(target.name).slice(0, 40) : null,
    reason: String(o.reason || 'Violating the rules').slice(0, 120),
    by: o.by || null,
    reportIds: target.reportId ? [String(target.reportId)] : []
  };
  bans.push(entry);
  save();
  console.log(`[moderation] BAN ${entry.name || entry.email || entry.ips[0] || entry.id} by ${entry.by || 'owner'}`);
  return { ok: true, ban: entry };
}

function unban(id, by) {
  const b = bans.find((x) => x.id === String(id || ''));
  if (!b) return { ok: false, message: 'Ban not found.' };
  if (!isActive(b)) return { ok: false, message: 'That ban is no longer active.' };
  b.liftedAt = Date.now();
  b.liftedBy = by || null;
  save();
  console.log(`[moderation] UNBAN ${b.name || b.email || (b.ips || [])[0] || b.id} by ${by || 'owner'}`);
  return { ok: true, ban: b };
}

/** Last time a ban touching this IP was created or lifted (reports before that do not count again). */
function lastBanEventForIp(ip) {
  let t = 0;
  for (const b of bans) {
    if (!(b.ips || []).includes(ip)) continue;
    t = Math.max(t, b.at || 0, b.liftedAt || 0);
  }
  return t;
}

/**
 * Auto-block check, called after each report.
 * reports: array of report entries (any order) with targetIp / reporterIp / reporterKey.
 * opts: { isOwnerFn, isProtectedIp(ip) }
 */
function checkAutoBlock(entry, reports, opts) {
  const o = opts || {};
  const now = Date.now();
  const ip = normalizeIp(entry && entry.targetIp);
  if (!ip || isLocalIp(ip)) return null;
  if (entry.targetEmail && o.isOwnerFn && o.isOwnerFn(entry.targetEmail)) return null;
  if (entry.targetIsBot) return null;
  if (isOwnerIp(ip)) return null;
  if (o.isProtectedIp && o.isProtectedIp(ip)) return null;
  if (activeBans().some((b) => (b.ips || []).includes(ip))) return null;
  const cutoff = Math.max(now - AUTO_BLOCK_WINDOW_MS, lastBanEventForIp(ip));
  const rel = (reports || []).filter((r) =>
    r && normalizeIp(r.targetIp) === ip && r.at > cutoff &&
    r.reporterIp && normalizeIp(r.reporterIp) !== ip
  );
  const reporterIps = new Set(rel.map((r) => normalizeIp(r.reporterIp)));
  const reporterKeys = new Set(rel.map((r) => r.reporterKey || ('ip:' + normalizeIp(r.reporterIp))));
  if (reporterIps.size < AUTO_BLOCK_REPORTS || reporterKeys.size < AUTO_BLOCK_REPORTS) return null;
  const entryBan = {
    id: crypto.randomBytes(8).toString('hex'),
    kind: 'auto',
    at: now,
    expiresAt: now + AUTO_BLOCK_DURATION_MS,
    liftedAt: null,
    liftedBy: null,
    email: null,
    ips: [ip],
    deviceIds: [],
    tokens: [],
    name: entry.targetName ? String(entry.targetName).slice(0, 40) : null,
    reason: `Auto-block: reported by ${reporterIps.size} different people within 24h`,
    by: 'auto',
    reportIds: rel.map((r) => r.id).filter(Boolean).slice(-20)
  };
  bans.push(entryBan);
  save();
  console.log(`[moderation] AUTO-BLOCK ip=${ip} (${entryBan.name || '?'}) until ${new Date(entryBan.expiresAt).toISOString()}`);
  return entryBan;
}

function listForAdmin() {
  const now = Date.now();
  const active = bans.filter((b) => isActive(b, now)).slice().reverse();
  const recent = bans.filter((b) => !isActive(b, now)).slice(-30).reverse().map((b) => ({
    ...b,
    status: b.liftedAt ? 'lifted' : 'expired'
  }));
  return { active, recent };
}

load();

module.exports = {
  BAN_MESSAGE,
  AUTO_BLOCK_REPORTS,
  AUTO_BLOCK_WINDOW_MS,
  AUTO_BLOCK_DURATION_MS,
  normalizeIp,
  isLocalIp,
  trustProxy,
  clientIpFrom,
  cleanDeviceId,
  load,
  reload: load,
  findBan,
  matchesBan,
  banPayload,
  activeBans,
  addManualBan,
  unban,
  checkAutoBlock,
  listForAdmin,
  noteOwnerSeen,
  isOwnerIp
};
