/**
 * Persistent registered-user inbox.
 * Messages survive offline / restart until a participant deletes them.
 * Unanswered streak: max 5 messages, then 48h cooldown (owners exempt).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const INBOX_FILE = path.join(DATA_DIR, 'inbox.json');
const LIMIT = 5;
const RESET_MS = 48 * 60 * 60 * 1000;
const MAX_MSGS = 2000;
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

const store = {
  threads: {},
  notifyAt: {}
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  try {
    ensureDir();
    if (!fs.existsSync(INBOX_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(INBOX_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      store.threads = raw.threads && typeof raw.threads === 'object' ? raw.threads : {};
      store.notifyAt = raw.notifyAt && typeof raw.notifyAt === 'object' ? raw.notifyAt : {};
    }
    console.log(`[inbox] loaded ${Object.keys(store.threads).length} thread(s)`);
  } catch (e) {
    console.warn('[inbox] load failed:', e.message);
  }
}

let saveTimer = null;
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 200);
}

function saveNow() {
  try {
    ensureDir();
    fs.writeFileSync(
      INBOX_FILE,
      JSON.stringify({ threads: store.threads, notifyAt: store.notifyAt }, null, 2),
      'utf8'
    );
  } catch (e) {
    console.warn('[inbox] save failed:', e.message);
  }
}

function pairKey(a, b) {
  return [String(a || '').toLowerCase(), String(b || '').toLowerCase()].sort().join('|');
}

function otherOf(thread, email) {
  const me = String(email || '').toLowerCase();
  return (thread.participants || []).find((p) => p !== me) || null;
}

function getOrCreateThread(emailA, emailB) {
  const a = String(emailA || '').toLowerCase();
  const b = String(emailB || '').toLowerCase();
  if (!a || !b || a === b) return null;
  const id = pairKey(a, b);
  if (!store.threads[id]) {
    store.threads[id] = {
      id,
      participants: [a, b],
      messages: [],
      unread: { [a]: 0, [b]: 0 },
      updatedAt: Date.now()
    };
  }
  const t = store.threads[id];
  if (!t.unread) t.unread = {};
  if (t.unread[a] == null) t.unread[a] = 0;
  if (t.unread[b] == null) t.unread[b] = 0;
  return t;
}

function visibleMessages(thread) {
  return (thread.messages || []).filter((m) => !m.deleted);
}

function unansweredFrom(thread, fromEmail) {
  const me = String(fromEmail || '').toLowerCase();
  const msgs = visibleMessages(thread);
  const streak = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].from === me) streak.push(msgs[i]);
    else break;
  }
  return streak.reverse();
}

function limitStatus(fromEmail, toEmail, isOwnerFn) {
  const from = String(fromEmail || '').toLowerCase();
  const to = String(toEmail || '').toLowerCase();
  if (typeof isOwnerFn === 'function' && isOwnerFn(from)) {
    return { ok: true, remaining: null, unlimited: true, resetAt: null, used: 0 };
  }
  const thread = store.threads[pairKey(from, to)];
  if (!thread) {
    return { ok: true, remaining: LIMIT, unlimited: false, resetAt: null, used: 0 };
  }
  const streak = unansweredFrom(thread, from);
  const recent = streak.filter((m) => Date.now() - m.at < RESET_MS);
  const used = recent.length;
  if (used >= LIMIT) {
    const oldest = recent[0];
    const resetAt = (oldest && oldest.at ? oldest.at : Date.now()) + RESET_MS;
    return {
      ok: false,
      remaining: 0,
      unlimited: false,
      resetAt,
      used,
      message:
        'You can send up to 5 messages until they reply. Try again after 48 hours if they do not respond.'
    };
  }
  return { ok: true, remaining: LIMIT - used, unlimited: false, resetAt: null, used };
}

function sendMessage({ fromEmail, toEmail, text, isOwnerFn, fromName }) {
  const from = String(fromEmail || '').toLowerCase();
  const to = String(toEmail || '').toLowerCase();
  const clean = String(text || '').trim().slice(0, 800);
  if (!from || !to) return { ok: false, message: 'Missing sender or recipient.' };
  if (from === to) return { ok: false, message: 'You cannot message yourself.' };
  if (!clean) return { ok: false, message: 'Message cannot be empty.' };

  const lim = limitStatus(from, to, isOwnerFn);
  if (!lim.ok) return lim;

  const thread = getOrCreateThread(from, to);
  const msg = {
    id: crypto.randomBytes(8).toString('hex'),
    from,
    text: clean,
    at: Date.now(),
    status: 'sent',
    readAt: null,
    deleted: false
  };
  thread.messages.push(msg);
  if (thread.messages.length > MAX_MSGS) {
    thread.messages = thread.messages.slice(-MAX_MSGS);
  }
  thread.unread[to] = (thread.unread[to] || 0) + 1;
  thread.updatedAt = msg.at;
  saveSoon();

  const after = limitStatus(from, to, isOwnerFn);
  return {
    ok: true,
    message: msg,
    threadId: thread.id,
    to,
    from,
    fromName: fromName || from.split('@')[0],
    remaining: after.remaining,
    unlimited: !!after.unlimited,
    used: after.used
  };
}

function markDelivered(msgId, threadId) {
  const thread = store.threads[threadId];
  if (!thread) return null;
  const msg = (thread.messages || []).find((m) => m.id === msgId);
  if (!msg || msg.deleted) return null;
  if (msg.status === 'sent') {
    msg.status = 'delivered';
    saveSoon();
  }
  return msg;
}

function markThreadRead(readerEmail, partnerEmail) {
  const reader = String(readerEmail || '').toLowerCase();
  const partner = String(partnerEmail || '').toLowerCase();
  const thread = store.threads[pairKey(reader, partner)];
  if (!thread) return { ok: false, message: 'Thread not found.' };
  const now = Date.now();
  const newlyRead = [];
  for (const msg of thread.messages || []) {
    if (msg.deleted) continue;
    if (msg.from !== reader && msg.status !== 'read') {
      msg.status = 'read';
      msg.readAt = now;
      newlyRead.push(msg.id);
    }
  }
  thread.unread[reader] = 0;
  saveSoon();
  return { ok: true, threadId: thread.id, newlyRead, at: now, partner };
}

function deleteMessage(actorEmail, msgId, partnerEmail) {
  const actor = String(actorEmail || '').toLowerCase();
  const partner = String(partnerEmail || '').toLowerCase();
  const thread = store.threads[pairKey(actor, partner)];
  if (!thread) return { ok: false, message: 'Thread not found.' };
  const msg = (thread.messages || []).find((m) => m.id === msgId);
  if (!msg) return { ok: false, message: 'Message not found.' };
  if (msg.from !== actor && !thread.participants.includes(actor)) {
    return { ok: false, message: 'You can only delete messages in your inbox.' };
  }
  msg.deleted = true;
  thread.updatedAt = Date.now();
  saveSoon();
  return { ok: true, msgId, partner, threadId: thread.id };
}

function listThreads(email, enrichFn) {
  const me = String(email || '').toLowerCase();
  const out = [];
  for (const thread of Object.values(store.threads)) {
    if (!thread.participants || !thread.participants.includes(me)) continue;
    const partner = otherOf(thread, me);
    const msgs = visibleMessages(thread);
    const last = msgs[msgs.length - 1] || null;
    const extra = typeof enrichFn === 'function' ? enrichFn(partner) || {} : {};
    out.push({
      threadId: thread.id,
      partner,
      lastText: last ? last.text : '',
      lastAt: last ? last.at : thread.updatedAt,
      lastFrom: last ? last.from : null,
      lastStatus: last ? last.status : null,
      unread: thread.unread[me] || 0,
      ...extra
    });
  }
  out.sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  return out;
}

function getThread(email, partnerEmail) {
  const me = String(email || '').toLowerCase();
  const partner = String(partnerEmail || '').toLowerCase();
  const thread = store.threads[pairKey(me, partner)];
  if (!thread) {
    return {
      ok: true,
      threadId: pairKey(me, partner),
      partner,
      messages: [],
      unread: 0
    };
  }
  return {
    ok: true,
    threadId: thread.id,
    partner,
    messages: visibleMessages(thread).map((m) => ({
      id: m.id,
      from: m.from,
      text: m.text,
      at: m.at,
      status: m.status,
      readAt: m.readAt || null,
      fromSelf: m.from === me
    })),
    unread: thread.unread[me] || 0
  };
}

function unreadCount(email) {
  const me = String(email || '').toLowerCase();
  let n = 0;
  for (const thread of Object.values(store.threads)) {
    if (thread.participants && thread.participants.includes(me)) {
      n += thread.unread[me] || 0;
    }
  }
  return n;
}

function shouldEmailNotify(toEmail, threadId) {
  const key = `${threadId}|${String(toEmail || '').toLowerCase()}`;
  const last = store.notifyAt[key] || 0;
  if (Date.now() - last < NOTIFY_COOLDOWN_MS) return false;
  store.notifyAt[key] = Date.now();
  saveSoon();
  return true;
}

load();

module.exports = {
  LIMIT,
  RESET_MS,
  sendMessage,
  markDelivered,
  markThreadRead,
  deleteMessage,
  listThreads,
  getThread,
  unreadCount,
  limitStatus,
  pairKey,
  shouldEmailNotify,
  unansweredFrom
};
