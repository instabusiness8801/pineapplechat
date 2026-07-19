/**
 * Reports, rate limits, reactions, mutes, invites — file-backed where useful.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const REPORTS_FILE = path.join(DATA_DIR, 'reports.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---- Rate limits ----
// key -> { count, resetAt }
const rateBuckets = new Map();

function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, b);
  }
  b.count += 1;
  if (b.count > max) {
    return { ok: false, message: 'Too many requests. Please wait a moment and try again.' };
  }
  return { ok: true, remaining: max - b.count };
}

// ---- Reports ----
const reports = [];
function loadReports() {
  try {
    ensureDir();
    if (fs.existsSync(REPORTS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf8'));
      if (Array.isArray(raw)) reports.push(...raw.slice(-500));
    }
  } catch (e) {
    console.warn('[features] reports load:', e.message);
  }
}
function saveReports() {
  try {
    ensureDir();
    fs.writeFileSync(REPORTS_FILE, JSON.stringify(reports.slice(-500), null, 2));
  } catch (e) {
    console.warn('[features] reports save:', e.message);
  }
}

function addReport({ reporterId, reporterToken, reporterName, targetId, targetToken, targetName, reason, details }) {
  const entry = {
    id: crypto.randomBytes(8).toString('hex'),
    at: Date.now(),
    reporterId: reporterId || null,
    reporterToken: reporterToken || null,
    reporterName: reporterName || null,
    targetId: targetId || null,
    targetToken: targetToken || null,
    targetName: targetName || null,
    reason: String(reason || 'other').slice(0, 40),
    details: String(details || '').slice(0, 500)
  };
  reports.push(entry);
  saveReports();
  console.log(`[report] ${entry.reporterName || entry.reporterId} → ${entry.targetName || entry.targetId}: ${entry.reason}`);
  return { ok: true, message: 'Report submitted. Thank you for helping keep PineappleChat safe.', id: entry.id };
}

// ---- Message ownership (for silent delete): msgId -> ownerKey (sessionToken or socketId)
const messageOwners = new Map();

function registerMessageOwner(msgId, ownerKey) {
  if (!msgId || !ownerKey) return;
  messageOwners.set(String(msgId), String(ownerKey));
  // Bound memory
  if (messageOwners.size > 5000) {
    const first = messageOwners.keys().next().value;
    messageOwners.delete(first);
  }
}

function hasMessageOwner(msgId) {
  return messageOwners.has(String(msgId));
}

function canDeleteMessage(msgId, requesterKey) {
  if (!msgId || !requesterKey) return false;
  const owner = messageOwners.get(String(msgId));
  if (!owner) return false;
  return owner === String(requesterKey);
}

/** Allow delete if you own it, or if ownership was never recorded (id is unguessable). */
function allowSilentDelete(msgId, requesterKey) {
  if (!msgId || !requesterKey) return false;
  if (!hasMessageOwner(msgId)) return true;
  return canDeleteMessage(msgId, requesterKey);
}

function forgetMessage(msgId) {
  if (!msgId) return;
  messageOwners.delete(String(msgId));
  reactions.delete(String(msgId));
}

// ---- Message reactions: msgId -> { emoji: Set of reactor tokens/ids }
const reactions = new Map();

function toggleReaction(msgId, emoji, reactorKey) {
  if (!msgId || !emoji || !reactorKey) return { ok: false };
  const allowed = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
  if (!allowed.includes(emoji)) return { ok: false, message: 'Invalid reaction.' };
  if (!reactions.has(msgId)) reactions.set(msgId, {});
  const byEmoji = reactions.get(msgId);
  if (!byEmoji[emoji]) byEmoji[emoji] = new Set();
  const set = byEmoji[emoji];
  let added = false;
  if (set.has(reactorKey)) {
    set.delete(reactorKey);
  } else {
    // one reaction type at a time per user: remove from others
    for (const e of Object.keys(byEmoji)) {
      if (byEmoji[e]) byEmoji[e].delete(reactorKey);
    }
    set.add(reactorKey);
    added = true;
  }
  return { ok: true, added, snapshot: reactionSnapshot(msgId) };
}

function reactionSnapshot(msgId) {
  const byEmoji = reactions.get(msgId) || {};
  const out = {};
  for (const [emoji, set] of Object.entries(byEmoji)) {
    if (set && set.size) out[emoji] = set.size;
  }
  return out;
}

// ---- Mutes: sessionToken -> Set of muted partner tokens/ids
const mutes = new Map();

function mutePartner(viewerToken, partnerKey) {
  if (!viewerToken || !partnerKey) return { ok: false };
  if (!mutes.has(viewerToken)) mutes.set(viewerToken, new Set());
  mutes.get(viewerToken).add(partnerKey);
  return { ok: true, muted: true };
}

function unmutePartner(viewerToken, partnerKey) {
  if (!viewerToken || !partnerKey) return { ok: false };
  const set = mutes.get(viewerToken);
  if (set) set.delete(partnerKey);
  return { ok: true, muted: false };
}

function isMuted(viewerToken, partnerKey) {
  if (!viewerToken || !partnerKey) return false;
  const set = mutes.get(viewerToken);
  return !!(set && (set.has(partnerKey)));
}

function listMutes(viewerToken) {
  const set = mutes.get(viewerToken);
  return set ? Array.from(set) : [];
}

// ---- Unblock: remove from block maps (caller passes maps)
function unblock(blockerToken, blockerSocketId, targetKey, blockedUsers, blockedBySession) {
  if (blockerSocketId && blockedUsers.has(blockerSocketId)) {
    blockedUsers.get(blockerSocketId).delete(targetKey);
  }
  if (blockerToken && blockedBySession.has(blockerToken)) {
    blockedBySession.get(blockerToken).delete(targetKey);
  }
  return { ok: true };
}

function listBlocked(blockerToken, blockerSocketId, blockedUsers, blockedBySession) {
  const out = new Set();
  if (blockerSocketId && blockedUsers.has(blockerSocketId)) {
    blockedUsers.get(blockerSocketId).forEach((x) => out.add(x));
  }
  if (blockerToken && blockedBySession.has(blockerToken)) {
    blockedBySession.get(blockerToken).forEach((x) => out.add(x));
  }
  return Array.from(out);
}

// ---- Invite codes ----
const invites = new Map(); // code -> { creatorToken, username, createdAt }

function createInvite(creatorToken, username) {
  const code = crypto.randomBytes(4).toString('hex');
  invites.set(code, {
    creatorToken: creatorToken || null,
    username: username || 'Someone',
    createdAt: Date.now()
  });
  return { ok: true, code, path: `/?invite=${code}` };
}

function getInvite(code) {
  return invites.get(code) || null;
}

// ---- Read receipts: pairKey -> { readerToken, lastMsgId, at }
// pairKey = sorted session tokens or socket ids
const readReceipts = new Map();

function pairKey(a, b) {
  return [String(a || ''), String(b || '')].sort().join('|');
}

function markRead(readerKey, partnerKey, lastMsgId) {
  if (!readerKey || !partnerKey) return { ok: false };
  const key = pairKey(readerKey, partnerKey);
  readReceipts.set(key, {
    readerKey,
    partnerKey,
    lastMsgId: lastMsgId || null,
    at: Date.now()
  });
  return { ok: true, at: Date.now(), lastMsgId };
}

function getReadState(readerKey, partnerKey) {
  const key = pairKey(readerKey, partnerKey);
  return readReceipts.get(key) || null;
}

loadReports();

module.exports = {
  rateLimit,
  addReport,
  toggleReaction,
  reactionSnapshot,
  registerMessageOwner,
  canDeleteMessage,
  hasMessageOwner,
  allowSilentDelete,
  forgetMessage,
  mutePartner,
  unmutePartner,
  isMuted,
  listMutes,
  unblock,
  listBlocked,
  createInvite,
  getInvite,
  markRead,
  getReadState,
  pairKey
};
