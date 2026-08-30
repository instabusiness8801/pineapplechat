const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const safety = require(path.join(__dirname, 'public', 'content-safety.js'));
const mail = require(path.join(__dirname, 'server-mail.js'));
const backup = require(path.join(__dirname, 'data-backup.js'));
const accounts = require(path.join(__dirname, 'server-accounts.js'));
const features = require(path.join(__dirname, 'server-features.js'));
const inbox = require(path.join(__dirname, 'server-inbox.js'));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Helpful behind Render / mobile proxies
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.json({ limit: '32kb' }));
app.disable('x-powered-by');
app.use((req, res, next) => {
  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (host === 'www.pineapplechat.com') {
    return res.redirect(301, 'https://pineapplechat.com' + req.originalUrl);
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(?:js|css|png|jpe?g|svg|webp|woff2)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

function sendPublicHtml(name) {
  return (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.sendFile(path.join(__dirname, 'public', name));
  };
}
const infoPages = {
  '/about': 'about.html',
  '/random-chat': 'random-chat.html',
  '/friend-chat': 'friend-chat.html',
  '/chat-websites': 'chat-websites.html'
};
Object.keys(infoPages).forEach((route) => {
  app.get(route, sendPublicHtml(infoPages[route]));
  app.get(route + '.html', (req, res) => res.redirect(301, route));
});

const ENABLE_DEMO_USERS = process.env.ENABLE_DEMO_USERS === 'true';
/** Keep user on the online list as away & allow seamless rejoin for this long after disconnect */
const SESSION_GRACE_MS = 10 * 60 * 1000;

const SITE_BOT_ID = 'bot:pineapplechat';
const SITE_BOT_PROFILE = {
  username: 'PineappleChat Bot',
  gender: '',
  age: '',
  country: '',
  city: '',
  location: '',
  image: '/icon-192.png',
  whatsOnMind: "I'm the site bot — not a person. Chat with me until someone real joins."
};
const SITE_BOT_GREETING =
  "Hey — I'm PineappleChat Bot, not a person. Nobody else is in the list right now. Chat with me until someone real shows up, then tap them. 18+ only.";
const SITE_BOT_HUMAN_JOINED =
  "A real person just came online. Check People and tap them — I'm still here if you want.";
const SITE_BOT_REPLIES = [
  "Still just the site bot here — not a person. Hang tight and tap someone in People when they show up.",
  "I'm PineappleChat Bot. I keep you company when the list is quiet. A real person can jump in any time.",
  "Yep, still me, the bot. Check the People list — if someone real is there, tap them to chat.",
  "Happy to chat, but I'm not human. Wait for a real visitor and tap their name in People.",
  "Got it. I'm the site bot, 18+ only, SFW. When someone real joins I'll let you know."
];

app.get('/api/config', (req, res) => {
  res.json({
    enableDemoUsers: ENABLE_DEMO_USERS,
    appName: 'PineappleChat',
    minAge: safety.MIN_AGE || 18,
    sessionGraceMs: SESSION_GRACE_MS,
    emailConfigured: accounts.emailConfigured(),
    ownerEmailHint: accounts.ownerEmail() ? true : false,
    features: {
      block: true,
      friends: true,
      friendRequests: true,
      inbox: true,
      registeredUsers: true,
      reply: true,
      reactions: true,
      readReceipts: true,
      mute: true,
      voiceNotes: true,
      report: true,
      invite: true,
      interests: true
    }
  });
});

app.get('/api/members', (req, res) => {
  res.json(accounts.listPublicMembers((email) => presenceForEmail(email)));
});

app.get('/api/invite/:code', (req, res) => {
  const inv = features.getInvite(req.params.code);
  if (!inv) return res.status(404).json({ ok: false, message: 'Invite not found or expired.' });
  res.json({ ok: true, username: inv.username, code: req.params.code });
});

function loadWorldLocations() {
  try {
    const src = fs.readFileSync(path.join(__dirname, 'public', 'world-locations.js'), 'utf8');
    const sandbox = { window: {} };
    vm.runInNewContext(src, sandbox);
    return sandbox.window.WORLD_LOCATIONS || {};
  } catch (err) {
    console.warn('[PineappleChat] Could not load world-locations.js:', err.message);
    return {};
  }
}
const WORLD_LOCATIONS = loadWorldLocations();
console.log(`[PineappleChat] Location list: ${Object.keys(WORLD_LOCATIONS).length} countries`);

function isValidLocation(country, city) {
  return !!(
    country &&
    city &&
    WORLD_LOCATIONS[country] &&
    Array.isArray(WORLD_LOCATIONS[country]) &&
    WORLD_LOCATIONS[country].includes(city)
  );
}

// ---- Session-aware presence (survives refresh for SESSION_GRACE_MS) ----
// token -> { profile, socketId|null, disconnectedAt|null, graceTimer|null, pending: [] }
const sessions = new Map();
// socketId -> token
const socketToSession = new Map();
const pairs = new Map(); // socketId -> partnerSocketId
/** socketId -> Set of blocked socketIds or session tokens */
const blockedUsers = new Map();
/** sessionToken -> Set of blocked sessionTokens (survives reconnect) */
const blockedBySession = new Map();
/** socket ids currently chatting with the site bot */
const siteBotChats = new Set();
let siteBotReplyCursor = 0;
let lastLiveHumanCount = 0;

function newSessionToken() {
  return crypto.randomBytes(16).toString('hex');
}

function getBlockedSetForSocket(socketId) {
  if (!blockedUsers.has(socketId)) blockedUsers.set(socketId, new Set());
  return blockedUsers.get(socketId);
}

function getBlockedSetForSession(token) {
  if (!token) return null;
  if (!blockedBySession.has(token)) blockedBySession.set(token, new Set());
  return blockedBySession.get(token);
}

function blockPair(blockerSocketId, blockerToken, targetId, targetToken) {
  const setA = getBlockedSetForSocket(blockerSocketId);
  if (targetId) setA.add(targetId);
  if (targetToken) setA.add(targetToken);

  if (blockerToken) {
    const sSet = getBlockedSetForSession(blockerToken);
    if (targetToken) sSet.add(targetToken);
    if (targetId) sSet.add(targetId);
  }
}

function isBlockedBetween(idOrTokenA, idOrTokenB, tokenA, tokenB) {
  // Legacy socket-id map
  if (idOrTokenA && idOrTokenB) {
    const a = blockedUsers.get(idOrTokenA);
    if (a && (a.has(idOrTokenB) || (tokenB && a.has(tokenB)))) return true;
    const b = blockedUsers.get(idOrTokenB);
    if (b && (b.has(idOrTokenA) || (tokenA && b.has(tokenA)))) return true;
  }
  // Session-token map (reconnect-safe)
  if (tokenA && tokenB) {
    const sa = blockedBySession.get(tokenA);
    if (sa && sa.has(tokenB)) return true;
    const sb = blockedBySession.get(tokenB);
    if (sb && sb.has(tokenA)) return true;
  }
  if (tokenA && idOrTokenB) {
    const sa = blockedBySession.get(tokenA);
    if (sa && sa.has(idOrTokenB)) return true;
  }
  if (tokenB && idOrTokenA) {
    const sb = blockedBySession.get(tokenB);
    if (sb && sb.has(idOrTokenA)) return true;
  }
  return false;
}

function isSiteBotTarget(id) {
  const s = String(id || '');
  return s === SITE_BOT_ID || s.toLowerCase().startsWith('bot:');
}

function siteBotListEntry() {
  return {
    id: SITE_BOT_ID,
    socketId: SITE_BOT_ID,
    sessionToken: SITE_BOT_ID,
    profile: SITE_BOT_PROFILE,
    online: true,
    away: false,
    isBot: true,
    registered: false,
    hidden: false
  };
}

function botSenderProfile() {
  return {
    username: SITE_BOT_PROFILE.username,
    age: SITE_BOT_PROFILE.age,
    gender: SITE_BOT_PROFILE.gender,
    country: SITE_BOT_PROFILE.country,
    city: SITE_BOT_PROFILE.city,
    location: SITE_BOT_PROFILE.location,
    image: SITE_BOT_PROFILE.image,
    whatsOnMind: SITE_BOT_PROFILE.whatsOnMind
  };
}

function botMessagePayload(text) {
  return {
    msgId: crypto.randomBytes(8).toString('hex'),
    text: String(text || ''),
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    senderId: SITE_BOT_ID,
    senderSessionToken: SITE_BOT_ID,
    senderMemberId: null,
    senderHidden: false,
    replyTo: null,
    from: SITE_BOT_ID,
    fromSelf: false,
    senderProfile: botSenderProfile()
  };
}

function emitBotMessageSoon(socket, text, delayMs) {
  if (!socket) return;
  const wait = delayMs != null ? delayMs : (400 + Math.floor(Math.random() * 501));
  const payload = botMessagePayload(text);
  setTimeout(() => {
    if (!socket.connected) return;
    socket.emit('receive-message', payload);
  }, wait);
}

function siteBotGreetingText() {
  const n = countOnlineHumans();
  if (n <= 1) return SITE_BOT_GREETING;
  return "Hi — I'm PineappleChat Bot, the official site bot (not a person). Real people show up in the People list as guests or members. I'm here if you want to chat. 18+ only.";
}

function nextSiteBotReply() {
  const text = SITE_BOT_REPLIES[siteBotReplyCursor % SITE_BOT_REPLIES.length];
  siteBotReplyCursor += 1;
  return text;
}

function pickSiteBotReply(userText) {
  const t = String(userText || '').toLowerCase();
  if (
    /\b(are you (a )?(real )?(human|person)|you real|r u real|are you a bot|you a bot|are you ai|human or bot|bot or human)\b/.test(t)
  ) {
    return "I'm PineappleChat Bot — the site bot, not a person. Tap a real name in People when someone joins.";
  }
  const sexual = /\b(sex|sexy|nude|nudes|horny|porn|nsfw|dick|pussy|fuck me|send nudes|onlyfans|hook.?up|cam girl)\b/.test(t);
  const minor = /\b(minor|underage|child|kid|loli|shota|preteen)\b/.test(t);
  if (sexual && minor) {
    return "No. Sexual content involving minors is not allowed. PineappleChat is 18+ and I'm a site bot, not a person.";
  }
  if (sexual) {
    return "I'm a site bot, not a dating or cam partner. Keep it SFW-ish here — this is a social chat lobby, not an NSFW bot.";
  }
  if (/^\s*(hi+|hey+|hello|yo|sup|hiya|howdy|good (morning|afternoon|evening))\b/.test(t)) {
    return "Hey! I'm PineappleChat Bot, not a person. Chat with me until someone real shows up, then tap them in People.";
  }
  return nextSiteBotReply();
}

function countOnlineHumans() {
  let n = 0;
  for (const sess of sessions.values()) {
    if (!sess || !sess.profile) continue;
    const live = sess.socketId && getLiveSocket(sess.socketId);
    if (live && !sess.browseHidden) n += 1;
  }
  return n;
}

function notifySiteBotChatsHumanJoined(exceptSocketId) {
  for (const sid of [...siteBotChats]) {
    if (exceptSocketId && sid === exceptSocketId) continue;
    const s = getLiveSocket(sid);
    if (!s) {
      siteBotChats.delete(sid);
      continue;
    }
    s.emit('receive-message', botMessagePayload(SITE_BOT_HUMAN_JOINED));
  }
}

function maybeAnnounceHumanJoined(exceptSocketId, prevOverride) {
  const n = countOnlineHumans();
  const prev = prevOverride != null ? prevOverride : lastLiveHumanCount;
  lastLiveHumanCount = n;
  if (prev < 2 && n >= 2) {
    notifySiteBotChatsHumanJoined(exceptSocketId);
  }
}

function getLiveSocket(socketId) {
  if (!socketId) return null;
  const s = io.sockets.sockets.get(socketId);
  return s && s.connected ? s : null;
}

function getSessionBySocket(socketId) {
  const token = socketToSession.get(socketId);
  return token ? sessions.get(token) : null;
}

function getSessionByToken(token) {
  return token ? sessions.get(token) : null;
}

function resolveLiveSocketForTarget(targetId) {
  // targetId may be current socket id, session token, or member:{publicId}
  if (!targetId) return { socket: null, session: null };

  let s = getLiveSocket(targetId);
  if (s) return { socket: s, session: getSessionBySocket(targetId) };

  if (String(targetId).toLowerCase().startsWith('member:')) {
    const pub = String(targetId).slice(7);
    const acc = pub ? accounts.getAccountByPublicId(pub) : null;
    if (acc && acc.email) return findLiveSocketForEmail(acc.email);
  }

  // By session token (may be live or in grace)
  const byToken = getSessionByToken(targetId);
  if (byToken) {
    s = getLiveSocket(byToken.socketId);
    return { socket: s, session: byToken };
  }

  // By last known socket id — include grace sessions (disconnected, still within grace window)
  for (const candidate of sessions.values()) {
    if (candidate.socketId === targetId) {
      s = getLiveSocket(candidate.socketId);
      return { socket: s, session: candidate };
    }
  }
  return { socket: null, session: null };
}

function sessionTokenOf(sess) {
  if (!sess) return null;
  for (const [token, s] of sessions.entries()) {
    if (s === sess) return token;
  }
  return null;
}

function isSessionInGrace(sess) {
  if (!sess || !sess.disconnectedAt) return false;
  return Date.now() - sess.disconnectedAt < SESSION_GRACE_MS;
}

function revealStealthFromSocket(socket, targetSocketId, targetToken, targetEmail, targetMemberId) {
  const tok = (socket && (socket.sessionToken || socketToSession.get(socket.id))) || null;
  const sess = tok ? sessions.get(tok) : null;
  if (!sess || !sess.stealth) return false;
  if (!sess.revealedTo) sess.revealedTo = new Set();
  if (targetSocketId) sess.revealedTo.add('sid:' + targetSocketId);
  if (targetToken) sess.revealedTo.add('tok:' + targetToken);
  if (targetEmail) sess.revealedTo.add('em:' + String(targetEmail).toLowerCase());
  if (targetMemberId) sess.revealedTo.add('mid:' + targetMemberId);
  return true;
}

function stealthVisibleTo(sess, viewerSocketId, viewerToken, viewerEmail, viewerMemberId) {
  if (!sess || !sess.stealth) return true;
  const r = sess.revealedTo;
  if (!r || !r.size) return false;
  if (viewerSocketId && r.has('sid:' + viewerSocketId)) return true;
  if (viewerToken && r.has('tok:' + viewerToken)) return true;
  if (viewerEmail && r.has('em:' + String(viewerEmail).toLowerCase())) return true;
  if (viewerMemberId && r.has('mid:' + viewerMemberId)) return true;
  return false;
}

function noteStealthReveal(socket, targetId) {
  if (!socket || !targetId) return;
  const memberEmail = resolveMemberEmail(targetId);
  let tSock = null;
  let tSess = null;
  if (memberEmail) {
    const live = findLiveSocketForEmail(memberEmail);
    tSock = live.socket;
    tSess = live.session;
  } else {
    const live = resolveLiveSocketForTarget(targetId);
    tSock = live.socket;
    tSess = live.session;
  }
  const tTok = tSess ? sessionTokenOf(tSess) : (tSock && (tSock.sessionToken || socketToSession.get(tSock.id)));
  const mid = memberEmail ? accounts.publicIdOf(memberEmail) : null;
  if (revealStealthFromSocket(socket, tSock && tSock.id, tTok, memberEmail, mid)) {
    broadcastOnlineUsers();
    broadcastStats();
  }
}

function stealthSessionForEmail(email) {
  const target = String(email || '').toLowerCase();
  if (!target) return null;
  const tok = accounts.findSessionTokenForEmail(target);
  if (tok) {
    const sess = getSessionByToken(tok);
    if (sess && sess.stealth) return sess;
  }
  for (const sock of io.sockets.sockets.values()) {
    if (!sock.connected) continue;
    if (String(sock.accountEmail || '').toLowerCase() !== target) continue;
    const sess = getSessionBySocket(sock.id);
    if (sess && sess.stealth) return sess;
  }
  return null;
}

function isSessStealth(sess) {
  return !!(sess && sess.stealth);
}

function memberChatIdForEmail(email) {
  if (!email) return null;
  const acc = accounts.getAccountByEmail(email);
  if (!acc || !acc.verified) return null;
  return 'member:' + accounts.publicIdOf(acc.email);
}

function senderPublicMeta(socket) {
  const sess = socket ? getSessionBySocket(socket.id) : null;
  const email = socket && (socket.accountEmail || accounts.getEmailForSession(socket.sessionToken || socketToSession.get(socket.id)));
  const chatId = memberChatIdForEmail(email);
  return {
    hidden: isSessStealth(sess) || !!(socket && socket.stealth),
    registered: !!chatId,
    memberId: chatId ? chatId.slice(7) : null,
    email: chatId ? String(email).toLowerCase() : null,
    partnerId: chatId || (socket && socket.id) || null
  };
}

/** Queue event for a session that is offline / in grace (max 80 items). */
function queuePending(sess, entry) {
  if (!sess) return false;
  sess.pending = sess.pending || [];
  sess.pending.push(entry);
  while (sess.pending.length > 80) sess.pending.shift();
  return true;
}

function getPartnerId(socketId) {
  return pairs.get(socketId) || null;
}

function unpair(socketId) {
  const partnerId = pairs.get(socketId);
  if (partnerId) pairs.delete(partnerId);
  pairs.delete(socketId);
}

function isBlocked(userA, userB) {
  const tokenA = socketToSession.get(userA) || null;
  const tokenB = socketToSession.get(userB) || null;
  // Also resolve tokens if userA/B are already tokens
  const ta = tokenA || (sessions.has(userA) ? userA : null);
  const tb = tokenB || (sessions.has(userB) ? userB : null);
  return isBlockedBetween(userA, userB, ta, tb);
}

function viewerBlocksTarget(viewerSocketId, viewerToken, targetSocketId, targetToken) {
  return isBlockedBetween(viewerSocketId, targetSocketId, viewerToken, targetToken);
}

function clearGraceTimer(sess) {
  if (sess && sess.graceTimer) {
    clearTimeout(sess.graceTimer);
    sess.graceTimer = null;
  }
}

function removeSession(token, reason) {
  const sess = sessions.get(token);
  if (!sess) return null;
  clearGraceTimer(sess);
  if (sess.socketId) {
    socketToSession.delete(sess.socketId);
    blockedUsers.delete(sess.socketId);
    unpair(sess.socketId);
  }
  sessions.delete(token);
  console.log(`[session] removed ${sess.profile && sess.profile.username} (${reason})`);
  return sess;
}

/** Resolve session token for a socket (mapping, property, or scan). */
function resolveSessionTokenForSocket(socket) {
  if (!socket) return null;
  let token = socketToSession.get(socket.id) || socket.sessionToken || null;
  if (token && sessions.has(token)) return token;
  // Fallback: find session bound to this socket id
  for (const [t, sess] of sessions.entries()) {
    if (sess.socketId === socket.id) return t;
  }
  return token && sessions.has(token) ? token : null;
}

/** Permanently remove presence for a socket (log off). No grace period. */
function forceLogoutSocket(socket, reason) {
  const token = resolveSessionTokenForSocket(socket);
  let removed = null;
  if (token) {
    const email = socket && socket.accountEmail;
    if (email) accounts.touchLastSeen(email);
    accounts.unbindSession(token);
    removed = removeSession(token, reason || 'logout');
  }
  // Always clear socket-local state so reconnect without set-profile stays anonymous
  if (socket) {
    socket.profile = null;
    socket.sessionToken = null;
    socket.accountEmail = null;
    socket.intentionalLogout = true;
    socketToSession.delete(socket.id);
  }
  return removed;
}

function emailBoundToSession(token, socketId) {
  const fromBind = accounts.getEmailForSession(token);
  if (fromBind) return fromBind;
  const sock = getLiveSocket(socketId);
  if (sock && sock.accountEmail) return String(sock.accountEmail).toLowerCase();
  return null;
}

function stripMemberPrefix(raw) {
  const s = String(raw || '').trim();
  if (s.toLowerCase().startsWith('member:')) return s.slice(7);
  return s;
}

function resolveMemberEmail(raw) {
  if (!raw) return null;
  let s = stripMemberPrefix(raw);
  if (!s) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s.toLowerCase();
  const byPublic = accounts.getAccountByPublicId(s);
  if (byPublic) return byPublic.email;
  const bySess = accounts.getEmailForSession(s);
  if (bySess) return bySess;
  const { socket: liveSock, session: liveSess } = resolveLiveSocketForTarget(raw);
  if (liveSock && liveSock.accountEmail) return String(liveSock.accountEmail).toLowerCase();
  if (liveSess) {
    const tok = sessionTokenOf(liveSess);
    const em = accounts.getEmailForSession(tok);
    if (em) return em;
  }
  return null;
}

function findLiveSocketForEmail(email) {
  const target = String(email || '').toLowerCase();
  if (!target) return { socket: null, session: null };
  for (const sock of io.sockets.sockets.values()) {
    if (!sock.connected) continue;
    if (String(sock.accountEmail || '').toLowerCase() === target) {
      const sess = getSessionBySocket(sock.id) || getSessionByToken(sock.sessionToken);
      return { socket: sock, session: sess };
    }
  }
  const tok = accounts.findSessionTokenForEmail(target);
  if (tok) {
    const sess = getSessionByToken(tok);
    if (sess) return { socket: getLiveSocket(sess.socketId), session: sess };
  }
  return { socket: null, session: null };
}

function presenceForEmail(email) {
  const target = String(email || '').toLowerCase();
  if (!target) return null;
  if (isAccountSocketOnline(target)) {
    const tok = accounts.findSessionTokenForEmail(target);
    const sess = tok ? getSessionByToken(tok) : null;
    return {
      online: true,
      away: false,
      username: (sess && sess.profile && sess.profile.username) || null,
      sessionToken: tok || null,
      socketId: (sess && sess.socketId) || null
    };
  }
  const tok = accounts.findSessionTokenForEmail(target);
  if (!tok) return null;
  const sess = getSessionByToken(tok);
  if (!sess) return null;
  const live = sess.socketId && getLiveSocket(sess.socketId);
  const away = !live && isSessionInGrace(sess);
  if (!live && !away) return null;
  return {
    online: !!live,
    away: !!away,
    username: (sess.profile && sess.profile.username) || null,
    sessionToken: tok,
    socketId: sess.socketId || null
  };
}

function profileFromAccount(acc, liveProfile) {
  const p = liveProfile || {};
  const display = (p.username && String(p.username).trim()) || (acc && acc.displayName) || (acc && acc.email && acc.email.split('@')[0]) || 'Member';
  const country = p.country || (acc && acc.country) || '';
  const city = p.city || (acc && acc.city) || '';
  const location = p.location || (city && country ? city + ', ' + country : (country || city || ''));
  const interests = (p.interests && p.interests.length)
    ? p.interests
    : (acc && Array.isArray(acc.interests) ? acc.interests.slice(0, 5) : []);
  return {
    username: display,
    age: p.age != null ? p.age : null,
    gender: p.gender || (acc && acc.gender) || null,
    country: country || null,
    city: city || null,
    location,
    image: p.image || (acc && acc.image) || null,
    whatsOnMind: p.whatsOnMind || null,
    interests,
    relationshipStatus: p.relationshipStatus || null
  };
}

function buildOnlineList() {
  const list = [];
  const now = Date.now();
  for (const [token, sess] of sessions.entries()) {
    const live = sess.socketId && getLiveSocket(sess.socketId);
    const inGrace =
      !live &&
      sess.disconnectedAt &&
      now - sess.disconnectedAt < SESSION_GRACE_MS;

    if (!live && !inGrace) {
      // Expired grace — clean up
      if (sess.disconnectedAt) removeSession(token, 'grace-expired-prune');
      continue;
    }

    // Prefer live socket id; during grace keep last socket id so clients can match chats.
    // Registered members always use a stable member:{publicId} list id so the People
    // list cannot grow a second dummy row keyed by socket id.
    const socketId = live ? sess.socketId : sess.socketId || null;
    const fallbackId = socketId || token;
    const email = emailBoundToSession(token, sess.socketId);
    const acc = email ? accounts.getAccountByEmail(email) : null;
    const registered = !!(acc && acc.verified);
    const memberId = registered ? accounts.publicIdOf(email) : null;
    list.push({
      id: memberId ? ('member:' + memberId) : fallbackId,
      socketId,
      sessionToken: token,
      profile: registered ? profileFromAccount(acc, sess.profile) : sess.profile,
      away: (!live && !!inGrace) || !!sess.browseHidden,
      online: !!live && !sess.browseHidden,
      registered,
      hidden: !!sess.stealth,
      memberId,
      email: registered ? email : null,
      lastSeenAt: acc ? acc.lastSeenAt || null : null,
      lastLoginAt: acc ? acc.lastLoginAt || null : null
    });
  }
  return list;
}

function memberPeopleEntry(acc, includeEmail) {
  if (!acc || !acc.verified) return null;
  const presence = presenceForEmail(acc.email) || {};
  const stealthSess = stealthSessionForEmail(acc.email);
  const entry = {
    id: 'member:' + accounts.publicIdOf(acc.email),
    socketId: presence.socketId || null,
    sessionToken: presence.sessionToken || null,
    profile: profileFromAccount(acc, presence.username ? { username: presence.username } : null),
    away: !!presence.away,
    online: !!presence.online,
    registered: true,
    hidden: isSessStealth(stealthSess),
    memberId: accounts.publicIdOf(acc.email),
    lastSeenAt: acc.lastSeenAt || null,
    lastLoginAt: acc.lastLoginAt || null
  };
  if (includeEmail) entry.email = acc.email;
  return entry;
}

function buildOnlineListForViewer(viewerSocketId, viewerToken) {
  const live = buildOnlineList();
  const viewerSock = getLiveSocket(viewerSocketId);
  const viewerEmail =
    accounts.getEmailForSession(viewerToken) ||
    (viewerSock && viewerSock.accountEmail && String(viewerSock.accountEmail).toLowerCase()) ||
    null;
  const viewerMemberId = viewerEmail ? accounts.publicIdOf(viewerEmail) : null;
  const includeEmail = !!viewerEmail;
  const seenEmails = new Set();
  const seenMemberIds = new Set();
  const seenUsernames = new Set();
  const out = [];

  for (const u of live) {
    if (!u) continue;
    const isSelf =
      (viewerSocketId && (u.id === viewerSocketId || u.socketId === viewerSocketId)) ||
      (viewerToken && u.sessionToken === viewerToken) ||
      (viewerEmail && u.email && u.email === viewerEmail) ||
      (viewerMemberId && u.memberId && u.memberId === viewerMemberId);
    if (isSelf) {
      continue;
    }
    const liveSess = u.sessionToken ? sessions.get(u.sessionToken) : null;
    if (liveSess && liveSess.stealth && !stealthVisibleTo(liveSess, viewerSocketId, viewerToken, viewerEmail, viewerMemberId)) {
      continue;
    }
    if (viewerBlocksTarget(viewerSocketId, viewerToken, u.id, u.sessionToken) ||
        (u.socketId && viewerBlocksTarget(viewerSocketId, viewerToken, u.socketId, u.sessionToken))) continue;
    if (viewerEmail && u.email && accounts.isBlockedAccount(viewerEmail, u.email)) continue;
    if (u.email) seenEmails.add(u.email);
    if (u.memberId) seenMemberIds.add(u.memberId);
    if (u.profile && u.profile.username) seenUsernames.add(String(u.profile.username).toLowerCase());
    const copy = Object.assign({}, u);
    copy.hidden = !!(liveSess && liveSess.stealth) || !!u.hidden;
    if (!includeEmail) delete copy.email;
    out.push(copy);
  }

  const members = accounts.listActiveAccounts ? accounts.listActiveAccounts() : [];
  for (const acc of members) {
    if (!acc || !acc.email) continue;
    if (viewerEmail && acc.email === viewerEmail) continue;
    if (seenEmails.has(acc.email)) continue;
    const mid = accounts.publicIdOf(acc.email);
    if (seenMemberIds.has(mid)) continue;
    const dname = acc.displayName ? String(acc.displayName).toLowerCase() : '';
    if (dname && seenUsernames.has(dname)) continue;
    const stealthSess = stealthSessionForEmail(acc.email);
    if (stealthSess && !stealthVisibleTo(stealthSess, viewerSocketId, viewerToken, viewerEmail, viewerMemberId)) {
      continue;
    }
    if (viewerEmail && accounts.isBlockedAccount(viewerEmail, acc.email)) continue;
    const entry = memberPeopleEntry(acc, includeEmail);
    if (entry) out.push(entry);
  }

  const viewerIsBot =
    viewerSocketId === SITE_BOT_ID ||
    viewerToken === SITE_BOT_ID;
  if (!viewerIsBot && !out.some((u) => u && (u.isBot || u.id === SITE_BOT_ID))) {
    out.push(siteBotListEntry());
  }

  out.sort((a, b) => {
    const abot = a && a.isBot ? 1 : 0;
    const bbot = b && b.isBot ? 1 : 0;
    const ao = (a && a.online ? 2 : (a && a.away ? 1 : 0)) + (abot ? 0.5 : 0);
    const bo = (b && b.online ? 2 : (b && b.away ? 1 : 0)) + (bbot ? 0.5 : 0);
    if (ao !== bo) return bo - ao;
    if (abot !== bbot) return bbot - abot;
    const an = (a.profile && a.profile.username) || '';
    const bn = (b.profile && b.profile.username) || '';
    return String(an).localeCompare(String(bn));
  });
  const botIdx = out.findIndex((u) => u && u.isBot);
  if (botIdx > 0) {
    const [bot] = out.splice(botIdx, 1);
    out.unshift(bot);
  }
  return out;
}

function broadcastOnlineUsers() {
  // Per-viewer list so blocked users disappear for both sides
  for (const sock of io.sockets.sockets.values()) {
    if (!sock.connected) continue;
    const token = resolveSessionTokenForSocket(sock);
    sock.emit('online-users', buildOnlineListForViewer(sock.id, token));
  }
}

function broadcastStats() {
  const list = buildOnlineListForViewer(null, null);
  const online = list.filter((u) => u && u.online && !u.isBot).length;
  lastLiveHumanCount = online;
  let chattingPairs = 0;
  const seen = new Set();
  for (const [a, b] of pairs.entries()) {
    if (seen.has(a) || seen.has(b)) continue;
    if (socketToSession.has(a) && socketToSession.has(b)) {
      chattingPairs += 1;
      seen.add(a);
      seen.add(b);
    }
  }
  io.emit('stats', { online, chatting: chattingPairs });
}

function flushPending(sess) {
  if (!sess || !sess.pending || !sess.pending.length) return 0;
  const sock = getLiveSocket(sess.socketId);
  if (!sock) return 0;
  const queue = sess.pending.splice(0, sess.pending.length);
  // Deliver as a batch first (client can merge reliably), then individual events
  // for backward compatibility with older clients.
  const messages = [];
  const attachments = [];
  for (const msg of queue) {
    if (msg.type === 'message') {
      messages.push(msg.payload);
      sock.emit('receive-message', msg.payload);
    } else if (msg.type === 'attachment') {
      attachments.push(msg.payload);
      sock.emit('receive-attachment', msg.payload);
    } else if (msg.type === 'chat-started') {
      sock.emit('chat-started', msg.payload);
    } else if (msg.type === 'message-deleted') {
      sock.emit('message-deleted', msg.payload);
    }
  }
  if (messages.length || attachments.length) {
    sock.emit('pending-sync', { messages, attachments, count: messages.length + attachments.length });
  }
  console.log(`[pending] flushed ${queue.length} item(s) to ${sess.profile && sess.profile.username}`);
  return queue.length;
}

/** Deliver after client has finished set-profile handling (avoids race on refresh). */
function flushPendingSoon(sess) {
  if (!sess) return;
  setTimeout(() => {
    flushPending(sess);
  }, 80);
  // Second pass in case first socket rebind was mid-flight
  setTimeout(() => {
    flushPending(sess);
  }, 400);
}

function emitToEmail(email, event, payload) {
  const target = String(email || '').toLowerCase();
  if (!target) return 0;
  let n = 0;
  for (const sock of io.sockets.sockets.values()) {
    if (!sock.connected) continue;
    if (sock.accountEmail === target) {
      sock.emit(event, payload);
      n += 1;
    }
  }
  return n;
}

function isAccountSocketOnline(email) {
  const target = String(email || '').toLowerCase();
  if (!target) return false;
  for (const sock of io.sockets.sockets.values()) {
    if (sock.connected && sock.accountEmail === target) return true;
  }
  return false;
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  {
    const tok = resolveSessionTokenForSocket(socket);
    socket.emit('online-users', buildOnlineListForViewer(socket.id, tok));
  }
  broadcastStats();

  socket.on('request-online-users', () => {
    const tok = resolveSessionTokenForSocket(socket);
    socket.emit('online-users', buildOnlineListForViewer(socket.id, tok));
    broadcastStats();
  });

  socket.on('set-profile', (profile) => {
    const cleanedProfile = profile || {};
    const accountEmail = socket.accountEmail || accounts.getEmailForSession(socket.sessionToken || socketToSession.get(socket.id));
    const acc = accountEmail ? accounts.getAccountByEmail(accountEmail) : null;
    if (cleanedProfile.fromAccount && acc && acc.verified) {
      if (!cleanedProfile.username) cleanedProfile.username = acc.displayName || acc.email.split('@')[0];
      if (!cleanedProfile.gender) cleanedProfile.gender = acc.gender || 'male';
      if (!cleanedProfile.country) cleanedProfile.country = acc.country || '';
      if (!cleanedProfile.city) cleanedProfile.city = acc.city || '';
      if (!cleanedProfile.image) cleanedProfile.image = acc.image || '';
      if (!cleanedProfile.interests && acc.interests) cleanedProfile.interests = acc.interests.slice();
      if (!safety.isValidAge(cleanedProfile.age)) cleanedProfile.age = 18;
      cleanedProfile.agreedToTerms = true;
    }

    const country = (cleanedProfile.country || '').trim();
    const city = (cleanedProfile.city || '').trim();
    if (!isValidLocation(country, city)) {
      socket.emit('profile-error', {
        field: 'location',
        message: 'Please select a valid country and city from the list.'
      });
      return;
    }
    cleanedProfile.country = country;
    cleanedProfile.city = city;
    cleanedProfile.location = `${city}, ${country}`;

    if (!safety.isValidAge(cleanedProfile.age)) {
      socket.emit('profile-error', {
        field: 'age',
        message: 'You must be 18 years or older to use PineappleChat.'
      });
      return;
    }
    cleanedProfile.age = safety.parseAge(cleanedProfile.age);

    if (!cleanedProfile.agreedToTerms) {
      socket.emit('profile-error', {
        field: 'terms',
        message: 'You must accept the Terms & Safety Agreement to continue.'
      });
      return;
    }
    cleanedProfile.agreedToTerms = true;
    cleanedProfile.agreedAt = cleanedProfile.agreedAt || new Date().toISOString();

    if (cleanedProfile.gender !== 'male' && cleanedProfile.gender !== 'female') {
      cleanedProfile.gender = 'male';
    }

    const nameCheck = safety.validateUsername(cleanedProfile.username);
    if (!nameCheck.ok) {
      socket.emit('profile-error', {
        field: 'username',
        message: nameCheck.message || 'Invalid username.'
      });
      return;
    }
    cleanedProfile.username = nameCheck.text;

    if (cleanedProfile.whatsOnMind) {
      const mindCheck = safety.validateWhatsOnMind(cleanedProfile.whatsOnMind);
      if (!mindCheck.ok) {
        socket.emit('profile-error', {
          field: 'whatsOnMind',
          message: mindCheck.message || 'That status text is not allowed.'
        });
        return;
      }
      cleanedProfile.whatsOnMind = mindCheck.text || '';
    }

    // Optional interests (max 5 short tags)
    if (Array.isArray(cleanedProfile.interests)) {
      const allowed = new Set([
        'Friends', 'Dating', 'Chit Chat',
        'Music', 'Movies', 'Sports', 'Gaming', 'Travel',
        'Food', 'Tech', 'Art', 'Books', 'Fitness'
      ]);
      cleanedProfile.interests = cleanedProfile.interests
        .map((t) => String(t || '').trim())
        .filter((t) => allowed.has(t))
        .slice(0, 5);
    } else {
      cleanedProfile.interests = [];
    }

    // Optional relationship status
    const allowedStatus = new Set([
      'single',
      'in_a_relationship',
      'married',
      'divorced',
      'separated'
    ]);
    if (cleanedProfile.relationshipStatus && allowedStatus.has(String(cleanedProfile.relationshipStatus))) {
      cleanedProfile.relationshipStatus = String(cleanedProfile.relationshipStatus);
    } else {
      cleanedProfile.relationshipStatus = null;
    }

    const newUsername = (cleanedProfile.username || '').trim().toLowerCase();
    if (newUsername && newUsername === String(SITE_BOT_PROFILE.username).trim().toLowerCase()) {
      socket.emit('profile-error', {
        field: 'username',
        message: 'This username is reserved for the site bot.'
      });
      return;
    }

    // Resume existing session within grace window (by token, else by username if away)
    let token = typeof cleanedProfile.sessionToken === 'string' ? cleanedProfile.sessionToken.trim() : '';
    let sess = token ? sessions.get(token) : null;

    // If token missing/stale but same username is in grace, reclaim that session
    // so queued messages from while they were away are not lost.
    if (!sess && newUsername && newUsername !== 'anonymous') {
      for (const [t, other] of sessions.entries()) {
        const existing = (other.profile && other.profile.username || '').trim().toLowerCase();
        if (existing !== newUsername) continue;
        const otherLive = other.socketId && getLiveSocket(other.socketId);
        if (!otherLive && isSessionInGrace(other)) {
          sess = other;
          token = t;
          console.log(`[session] reclaimed grace session for ${cleanedProfile.username} via username`);
          break;
        }
      }
    }

    // Unique username among *other* live/grace sessions
    if (newUsername && newUsername !== 'anonymous') {
      for (const [t, other] of sessions.entries()) {
        if (sess && t === token) continue;
        const existing = (other.profile && other.profile.username || '').trim().toLowerCase();
        if (existing === newUsername) {
          // Same session reconnecting is OK; different session takes the name → error
          const otherLive = other.socketId && getLiveSocket(other.socketId);
          const otherGrace = isSessionInGrace(other);
          if (otherLive || otherGrace) {
            socket.emit('profile-error', {
              field: 'username',
              message: 'This username is already taken. Please choose a different one.'
            });
            return;
          }
        }
      }
    }

    if (sess) {
      // Rebind to new socket id
      clearGraceTimer(sess);
      if (sess.socketId && sess.socketId !== socket.id) {
        socketToSession.delete(sess.socketId);
        // Migrate pair/block keys if needed
        if (pairs.has(sess.socketId)) {
          const p = pairs.get(sess.socketId);
          pairs.delete(sess.socketId);
          pairs.set(socket.id, p);
          if (p && pairs.get(p) === sess.socketId) pairs.set(p, socket.id);
        }
        if (blockedUsers.has(sess.socketId)) {
          blockedUsers.set(socket.id, blockedUsers.get(sess.socketId));
          blockedUsers.delete(sess.socketId);
        }
      }
      // Preserve any pending messages queued while away
      if (!Array.isArray(sess.pending)) sess.pending = [];
      sess.socketId = socket.id;
      sess.disconnectedAt = null;
      sess.profile = cleanedProfile;
      sess.profile.sessionToken = token;
      sessions.set(token, sess);
    } else {
      token = newSessionToken();
      sess = {
        profile: cleanedProfile,
        socketId: socket.id,
        disconnectedAt: null,
        graceTimer: null,
        pending: []
      };
      cleanedProfile.sessionToken = token;
      sess.profile = cleanedProfile;
      sessions.set(token, sess);
    }

    socketToSession.set(socket.id, token);
    socket.profile = cleanedProfile;
    socket.sessionToken = token;
    socket.intentionalLogout = false; // joined / re-joined after log off
    sess.browseHidden = false;
    if (typeof socket.stealth === 'boolean') sess.stealth = socket.stealth;
    if (!sess.revealedTo) sess.revealedTo = new Set();

    if (socket.accountEmail) {
      accounts.bindSession(token, socket.accountEmail);
      const acc = accounts.getAccountByEmail(socket.accountEmail);
      if (acc && acc.verified && !acc.displayName) {
        accounts.setDisplayName(socket.accountEmail, cleanedProfile.username);
      }
      if (acc && acc.verified) {
        const patch = {};
        if (!acc.gender && cleanedProfile.gender) patch.gender = cleanedProfile.gender;
        if (!acc.country && cleanedProfile.country) patch.country = cleanedProfile.country;
        if (!acc.city && cleanedProfile.city) patch.city = cleanedProfile.city;
        if ((!acc.interests || !acc.interests.length) && cleanedProfile.interests) patch.interests = cleanedProfile.interests;
        if (!acc.image && cleanedProfile.image) patch.image = cleanedProfile.image;
        if (Object.keys(patch).length) accounts.updateMemberProfile(token, patch);
      }
    }

    socket.emit('profile-accepted', {
      id: socket.id,
      sessionToken: token,
      sessionGraceMs: SESSION_GRACE_MS,
      pendingCount: (sess.pending && sess.pending.length) || 0
    });

    // Deliver queued messages after client finishes profile-accepted / hub restore
    flushPendingSoon(sess);

    const prevHumans = lastLiveHumanCount;
    broadcastOnlineUsers();
    broadcastStats();
    maybeAnnounceHumanJoined(socket.id, prevHumans);
    console.log(`[profile] ${cleanedProfile.username} socket=${socket.id} token=${token.slice(0, 8)}…`);
  });

  socket.on('start-chat-with', (data) => {
    const targetId = data && data.targetId;
    if (!targetId || targetId === socket.id) return;

    if (isSiteBotTarget(targetId)) {
      if (!socket.sessionToken || !getSessionByToken(socket.sessionToken)) {
        socket.emit('chat-error', { message: 'Please complete your profile first.' });
        return;
      }
      socket.emit('chat-started', {
        partnerId: SITE_BOT_ID,
        partnerProfile: SITE_BOT_PROFILE,
        isBot: true,
        partnerSessionToken: SITE_BOT_ID
      });
      siteBotChats.add(socket.id);
      if (!socket.siteBotGreeted) {
        socket.siteBotGreeted = true;
        emitBotMessageSoon(socket, siteBotGreetingText(), 500);
      }
      return;
    }

    const memberEmail = resolveMemberEmail(targetId);
    const memberAcc = memberEmail ? accounts.getAccountByEmail(memberEmail) : null;
    if (memberAcc && memberAcc.verified) {
      const meEmail = socket.accountEmail || accounts.getEmailForSession(socket.sessionToken || socketToSession.get(socket.id));
      if (meEmail) {
        if (!accounts.isOwner(meEmail) && accounts.isBlockedAccount(meEmail, memberEmail)) {
          socket.emit('chat-error', { message: 'You have blocked this user or they have blocked you.' });
          return;
        }
        const presence = presenceForEmail(memberEmail) || {};
        noteStealthReveal(socket, targetId);
        const targetStealth = stealthSessionForEmail(memberEmail);
        socket.emit('chat-started', {
          partnerId: 'member:' + accounts.publicIdOf(memberEmail),
          partnerProfile: profileFromAccount(memberAcc, presence.username ? { username: presence.username } : null),
          partnerSessionToken: presence.sessionToken || null,
          registered: true,
          memberId: accounts.publicIdOf(memberEmail),
          email: memberEmail,
          online: !!presence.online,
          away: !!presence.away,
          hidden: isSessStealth(targetStealth),
          lastSeenAt: memberAcc.lastSeenAt || null,
          lastLoginAt: memberAcc.lastLoginAt || null
        });
        return;
      }
      // Guest ↔ member: live chat only (no inbox, no friends)
      if (!socket.sessionToken || !getSessionByToken(socket.sessionToken)) {
        socket.emit('chat-error', { message: 'Please complete your profile first.' });
        return;
      }
      const live = findLiveSocketForEmail(memberEmail);
      const targetSocket = live.socket;
      const targetSess = live.session;
      const memberMeta = {
        registered: true,
        memberId: accounts.publicIdOf(memberEmail),
        email: memberEmail,
        hidden: isSessStealth(targetSess) || isSessStealth(stealthSessionForEmail(memberEmail))
      };
      const meMeta = senderPublicMeta(socket);
      const memberPartnerId = 'member:' + accounts.publicIdOf(memberEmail);
      if (!targetSocket && targetSess && isSessionInGrace(targetSess)) {
        const myProfile = socket.profile;
        const awayToken = sessionTokenOf(targetSess);
        noteStealthReveal(socket, targetId);
        socket.emit('chat-started', {
          partnerId: memberPartnerId,
          partnerProfile: profileFromAccount(memberAcc, targetSess.profile),
          partnerSessionToken: awayToken,
          ...memberMeta,
          away: true,
          online: false
        });
        queuePending(targetSess, {
          type: 'chat-started',
          payload: {
            partnerId: meMeta.partnerId || socket.id,
            partnerProfile: myProfile,
            partnerSessionToken: socket.sessionToken,
            hidden: meMeta.hidden,
            registered: meMeta.registered,
            memberId: meMeta.memberId
          }
        });
        return;
      }
      if (!targetSocket || !targetSess) {
        socket.emit('chat-error', {
          message: 'They are not in chat right now. Register to send an inbox message they will see later.'
        });
        return;
      }
      const myTok = socket.sessionToken || socketToSession.get(socket.id);
      const theirTok = socketToSession.get(targetSocket.id) || sessionTokenOf(targetSess);
      if (isBlockedBetween(socket.id, targetSocket.id, myTok, theirTok)) {
        socket.emit('chat-error', { message: 'You have blocked this user or they have blocked you.' });
        return;
      }
      noteStealthReveal(socket, targetId);
      socket.emit('chat-started', {
        partnerId: memberPartnerId,
        partnerProfile: profileFromAccount(memberAcc, targetSess.profile),
        partnerSessionToken: theirTok,
        ...memberMeta,
        online: true
      });
      // Deliver even if the member is hidden — they still receive the chat.
      targetSocket.emit('chat-started', {
        partnerId: meMeta.partnerId || socket.id,
        partnerProfile: socket.profile,
        partnerSessionToken: socket.sessionToken,
        hidden: meMeta.hidden,
        registered: meMeta.registered,
        memberId: meMeta.memberId
      });
      broadcastStats();
      return;
    }

    if (!socket.sessionToken || !getSessionByToken(socket.sessionToken)) {
      socket.emit('chat-error', { message: 'Please complete your profile first.' });
      return;
    }

    const { socket: targetSocket, session: targetSess } = resolveLiveSocketForTarget(targetId);
    if (!targetSocket || !targetSess) {
      // If target is in grace (away), still allow chat-started on our side; queue for them
      const awaySess =
        getSessionByToken(targetId) ||
        [...sessions.values()].find((s) => s.socketId === targetId);
      if (awaySess && isSessionInGrace(awaySess)) {
        const myProfile = socket.profile;
        const awayToken = sessionTokenOf(awaySess);
        socket.emit('chat-started', {
          partnerId: awaySess.socketId || targetId,
          partnerProfile: awaySess.profile,
          partnerSessionToken: awayToken
        });
        queuePending(awaySess, {
          type: 'chat-started',
          payload: {
            partnerId: socket.id,
            partnerProfile: myProfile,
            partnerSessionToken: socket.sessionToken
          }
        });
        return;
      }
      socket.emit('chat-error', { message: 'That user is no longer online.' });
      broadcastOnlineUsers();
      return;
    }

    const myTok = socket.sessionToken || socketToSession.get(socket.id);
    const theirTok = socketToSession.get(targetSocket.id) || sessionTokenOf(targetSess);
    if (isBlockedBetween(socket.id, targetSocket.id, myTok, theirTok)) {
      socket.emit('chat-error', { message: 'You have blocked this user or they have blocked you.' });
      return;
    }

    const myProfile = socket.profile;
    const theirProfile = targetSess.profile;
    const theirToken = theirTok;

    noteStealthReveal(socket, targetId);
    const meMeta = senderPublicMeta(socket);
    const theirMeta = senderPublicMeta(targetSocket);
    socket.emit('chat-started', {
      partnerId: theirMeta.partnerId || targetSocket.id,
      partnerProfile: theirProfile,
      partnerSessionToken: theirToken,
      hidden: theirMeta.hidden,
      registered: theirMeta.registered,
      memberId: theirMeta.memberId
    });
    targetSocket.emit('chat-started', {
      partnerId: meMeta.partnerId || socket.id,
      partnerProfile: myProfile,
      partnerSessionToken: socket.sessionToken,
      hidden: meMeta.hidden,
      registered: meMeta.registered,
      memberId: meMeta.memberId
    });

    broadcastStats();
  });

  socket.on('send-message-to', (data) => {
    const targetId = data && data.targetId;
    const text = data && data.text;
    if (!targetId || typeof text !== 'string') return;

    const rl = features.rateLimit('msg:' + socket.id, 40, 60 * 1000);
    if (!rl.ok) {
      socket.emit('chat-error', { message: rl.message });
      return;
    }

    if (isSiteBotTarget(targetId)) {
      const check = safety.validateChatText(text);
      if (!check.ok) {
        socket.emit('chat-error', { message: check.message || 'Message blocked by safety filters.' });
        return;
      }
      const clientMsgId = data.msgId != null ? String(data.msgId) : '';
      const msgId =
        clientMsgId && /^[a-zA-Z0-9_-]{8,40}$/.test(clientMsgId)
          ? clientMsgId
          : crypto.randomBytes(8).toString('hex');
      features.registerMessageOwner(msgId, socket.sessionToken || socket.id);
      siteBotChats.add(socket.id);
      emitBotMessageSoon(socket, pickSiteBotReply(check.text));
      return;
    }

    let deliverId = targetId;
    const memberEmail = resolveMemberEmail(targetId);
    const memberAcc = memberEmail ? accounts.getAccountByEmail(memberEmail) : null;
    if (memberAcc && memberAcc.verified) {
      const meEmail = socket.accountEmail || accounts.getEmailForSession(socket.sessionToken || socketToSession.get(socket.id));
      if (meEmail) return; // registered → member uses inbox
      const live = findLiveSocketForEmail(memberEmail);
      if (live.socket) deliverId = live.socket.id;
      else if (live.session && isSessionInGrace(live.session)) deliverId = live.session.socketId || sessionTokenOf(live.session);
      else {
        socket.emit('chat-error', { message: 'They are not in chat right now. Register to leave an inbox message.' });
        return;
      }
    }

    const check = safety.validateChatText(text);
    if (!check.ok) {
      socket.emit('chat-error', { message: check.message || 'Message blocked by safety filters.' });
      return;
    }
    const clean = check.text;
    // Prefer client msgId so sender & receiver share the same id (needed for reactions)
    const clientMsgId = data.msgId != null ? String(data.msgId) : '';
    const msgId =
      clientMsgId && /^[a-zA-Z0-9_-]{8,40}$/.test(clientMsgId)
        ? clientMsgId
        : crypto.randomBytes(8).toString('hex');

    // Optional reply-to quote (tap a message → reply)
    let replyTo = null;
    if (data.replyTo && typeof data.replyTo === 'object') {
      const snippet = String(data.replyTo.text || '').slice(0, 160);
      replyTo = {
        msgId: data.replyTo.msgId || null,
        text: snippet,
        username: String(data.replyTo.username || 'User').slice(0, 40)
      };
    }

    const senderMeta = senderPublicMeta(socket);
    const payload = {
      msgId,
      text: clean,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      senderId: socket.id,
      senderSessionToken: socket.sessionToken,
      senderMemberId: senderMeta.memberId,
      senderHidden: senderMeta.hidden,
      replyTo,
      senderProfile: socket.profile
        ? {
            username: socket.profile.username,
            age: socket.profile.age,
            gender: socket.profile.gender,
            country: socket.profile.country,
            city: socket.profile.city,
            location: socket.profile.location,
            image: socket.profile.image,
            whatsOnMind: socket.profile.whatsOnMind,
            interests: socket.profile.interests || [],
            relationshipStatus: socket.profile.relationshipStatus || null
          }
        : null
    };

    // Track ownership for silent unsend/delete
    features.registerMessageOwner(msgId, socket.sessionToken || socket.id);
    noteStealthReveal(socket, deliverId);

    const { socket: targetSocket, session: targetSess } = resolveLiveSocketForTarget(deliverId);
    const targetTok = targetSess ? sessionTokenOf(targetSess) : null;
    if (isBlockedBetween(socket.id, deliverId, socket.sessionToken, targetTok)) return;

    // Always queue when target is in grace (even if a zombie socket still looks "connected")
    if (targetSess && isSessionInGrace(targetSess)) {
      queuePending(targetSess, { type: 'message', payload: { ...payload, fromSelf: false } });
      socket.emit('receive-message', { ...payload, fromSelf: true });
      // Soft notice once-style (non-blocking for sender UI)
      socket.emit('delivery-status', {
        targetId,
        queued: true,
        message: 'User is reconnecting — message will be delivered when they are back (within 10 min).'
      });
      return;
    }

    if (targetSocket) {
      targetSocket.emit('receive-message', { ...payload, fromSelf: false });
      socket.emit('receive-message', { ...payload, fromSelf: true });
      return;
    }

    // Target temporarily disconnected within grace — queue message
    if (targetSess && isSessionInGrace(targetSess)) {
      queuePending(targetSess, { type: 'message', payload: { ...payload, fromSelf: false } });
      socket.emit('receive-message', { ...payload, fromSelf: true });
      socket.emit('delivery-status', {
        targetId,
        queued: true,
        message: 'User is reconnecting — message will be delivered when they are back (within 10 min).'
      });
      return;
    }

    socket.emit('chat-error', { message: 'Message not delivered — that user is offline.' });
  });

  socket.on('send-attachment-to', (data) => {
    const targetId = data && data.targetId;
    const attachment = data && data.attachment;
    if (!targetId || !attachment || !attachment.data) return;

    if (isSiteBotTarget(targetId)) {
      siteBotChats.add(socket.id);
      emitBotMessageSoon(socket, "I can only read text for now. I'm the site bot, not a cam or dating profile.");
      return;
    }

    let attDeliverId = targetId;
    const attMember = resolveMemberEmail(targetId);
    if (attMember) {
      const meEmail = socket.accountEmail || accounts.getEmailForSession(socket.sessionToken || socketToSession.get(socket.id));
      if (meEmail) {
        socket.emit('chat-error', { message: 'Photos and voice notes to members are coming soon. Send a text message for now.' });
        return;
      }
      const live = findLiveSocketForEmail(attMember);
      if (live.socket) attDeliverId = live.socket.id;
      else if (live.session && isSessionInGrace(live.session)) attDeliverId = live.session.socketId || sessionTokenOf(live.session);
      else {
        socket.emit('chat-error', { message: 'They are not in chat right now.' });
        return;
      }
    }

    if (isBlocked(socket.id, attDeliverId)) return;

    if (
      !attachment.type ||
      (!attachment.type.startsWith('image/') &&
        !attachment.type.startsWith('video/') &&
        !attachment.type.startsWith('audio/'))
    ) {
      socket.emit('chat-error', { message: 'Only image, video, or audio files are allowed.' });
      return;
    }

    const attMsgId =
      data.msgId && /^[a-zA-Z0-9_-]{8,40}$/.test(String(data.msgId))
        ? String(data.msgId)
        : crypto.randomBytes(8).toString('hex');
    const attSenderMeta = senderPublicMeta(socket);
    const payload = {
      msgId: attMsgId,
      attachment,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      senderId: socket.id,
      senderSessionToken: socket.sessionToken,
      senderMemberId: attSenderMeta.memberId,
      senderHidden: attSenderMeta.hidden,
      senderProfile: socket.profile
        ? {
            username: socket.profile.username,
            age: socket.profile.age,
            gender: socket.profile.gender,
            country: socket.profile.country,
            city: socket.profile.city,
            location: socket.profile.location,
            image: socket.profile.image,
            whatsOnMind: socket.profile.whatsOnMind,
            interests: socket.profile.interests || [],
            relationshipStatus: socket.profile.relationshipStatus || null
          }
        : null
    };

    features.registerMessageOwner(attMsgId, socket.sessionToken || socket.id);
    noteStealthReveal(socket, attDeliverId);

    const { socket: targetSocket, session: targetSess } = resolveLiveSocketForTarget(attDeliverId);

    if (targetSess && isSessionInGrace(targetSess)) {
      queuePending(targetSess, { type: 'attachment', payload: { ...payload, fromSelf: false } });
      socket.emit('receive-attachment', { ...payload, fromSelf: true });
      return;
    }

    if (targetSocket) {
      targetSocket.emit('receive-attachment', { ...payload, fromSelf: false });
      socket.emit('receive-attachment', { ...payload, fromSelf: true });
      return;
    }

    if (targetSess && isSessionInGrace(targetSess)) {
      queuePending(targetSess, { type: 'attachment', payload: { ...payload, fromSelf: false } });
      socket.emit('receive-attachment', { ...payload, fromSelf: true });
      return;
    }

    socket.emit('chat-error', { message: 'Attachment not delivered — that user is offline.' });
  });

  // Client asks to re-flush any remaining pending after hub UI is ready
  socket.on('request-pending', () => {
    const token = resolveSessionTokenForSocket(socket);
    const sess = token ? sessions.get(token) : null;
    if (sess) flushPending(sess);
  });

  socket.on('next-stranger', () => {
    socket.emit('back-to-browse');
    broadcastStats();
  });

  socket.on('end-chat', () => {
    socket.emit('chat-ended');
    broadcastStats();
  });

  socket.on('leave-chat', (data) => {
    const targetId = data && data.targetId;
    if (!targetId) return;
    if (isSiteBotTarget(targetId)) {
      siteBotChats.delete(socket.id);
      socket.emit('chat-left', { by: socket.id, partnerId: SITE_BOT_ID });
      return;
    }
    const { socket: targetSocket } = resolveLiveSocketForTarget(targetId);
    if (targetSocket) {
      targetSocket.emit('chat-left', { by: socket.id, partnerId: socket.id });
    }
    socket.emit('chat-left', { by: socket.id, partnerId: targetId });
  });

  socket.on('block-user', (data) => {
    const targetId = data && data.targetId;
    if (!targetId) return;

    if (isSiteBotTarget(targetId)) {
      socket.emit('block-ok', {
        targetId: SITE_BOT_ID,
        targetSessionToken: SITE_BOT_ID,
        message: 'The site bot stays in People — it is not a person you can block.'
      });
      return;
    }

    const { socket: targetSocket, session: targetSess } = resolveLiveSocketForTarget(targetId);
    const myToken = socket.sessionToken || socketToSession.get(socket.id);
    const theirToken = targetSess ? sessionTokenOf(targetSess) : (data.targetSessionToken || null);

    blockPair(socket.id, myToken, targetId, theirToken);
    const meEmail = socket.accountEmail || accounts.getEmailForSession(myToken);
    const memberEmail = resolveMemberEmail(targetId) || resolveMemberEmail(theirToken);
    if (meEmail && memberEmail) {
      const tok = myToken || socket.id;
      accounts.bindSession(tok, meEmail);
      accounts.blockAccount(tok, memberEmail);
    }
    // Mutual block effect for messaging: also mark reverse socket-level if live
    if (targetSocket) {
      blockPair(targetSocket.id, theirToken, socket.id, myToken);
      targetSocket.emit('chat-left', { by: socket.id, partnerId: socket.id, blocked: true });
      targetSocket.emit('you-were-blocked', { by: socket.id });
    }

    socket.emit('chat-left', { by: socket.id, partnerId: targetId, blocked: true });
    socket.emit('block-ok', {
      targetId,
      targetSessionToken: theirToken,
      message: 'User blocked. You will not see or message each other.'
    });
    broadcastOnlineUsers();
  });

  // ---- Email account + friends + inbox ----
  function sessionTokenOfSocket() {
    return socket.sessionToken || socketToSession.get(socket.id) || null;
  }

  function pickAck(a, b) {
    if (typeof a === 'function') return a;
    if (typeof b === 'function') return b;
    return null;
  }

  function accountEmailOfSocket() {
    return socket.accountEmail || accounts.getEmailForSession(sessionTokenOfSocket()) || null;
  }

  function requireVerifiedAccount() {
    const email = accountEmailOfSocket();
    if (!email) return null;
    const acc = accounts.getAccountByEmail(email);
    if (!acc || !acc.verified) return null;
    const token = sessionTokenOfSocket() || socket.id;
    accounts.bindSession(token, email);
    return { email, acc, token };
  }

  function bindAccountToSocket(email) {
    const em = String(email || '').trim().toLowerCase();
    if (!em) return;
    socket.accountEmail = em;
    const token = sessionTokenOfSocket();
    if (token) accounts.bindSession(token, em);
    if (socket.profile && socket.profile.username) {
      accounts.setDisplayName(em, socket.profile.username);
    }
  }

  function resolveAccountEmail(raw) {
    if (!raw) return null;
    const via = resolveMemberEmail(raw);
    if (via) return via;
    const s = stripMemberPrefix(raw);
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s.toLowerCase();
    const { session: tSess } = resolveLiveSocketForTarget(s);
    if (tSess) {
      const t = sessionTokenOf(tSess);
      const em = accounts.getEmailForSession(t);
      if (em) return em;
    }
    const byTok = getSessionByToken(s);
    if (byTok) {
      const em = accounts.getEmailForSession(sessionTokenOf(byTok));
      if (em) return em;
    }
    const byPublic = accounts.getAccountByPublicId(s);
    if (byPublic) return byPublic.email;
    return accounts.getEmailForSession(s);
  }

  function friendPresenceForEmail(email) {
    if (isAccountSocketOnline(email)) {
      const tok = accounts.findSessionTokenForEmail(email);
      const sess = tok ? getSessionByToken(tok) : null;
      return {
        online: true,
        away: false,
        username: (sess && sess.profile && sess.profile.username) || null,
        sessionToken: tok || null,
        socketId: (sess && sess.socketId) || null
      };
    }
    const tok = accounts.findSessionTokenForEmail(email);
    if (!tok) return null;
    const sess = getSessionByToken(tok);
    if (!sess) return null;
    const live = sess.socketId && getLiveSocket(sess.socketId);
    const away = !live && isSessionInGrace(sess);
    if (!live && !away) return null;
    return {
      online: !!live,
      away: !!away,
      username: (sess.profile && sess.profile.username) || null,
      sessionToken: tok,
      socketId: sess.socketId || null
    };
  }

  function pushUnread(email) {
    emitToEmail(email, 'inbox-unread', { count: inbox.unreadCount(email) });
  }

  socket.on('account-register', async (data, ack) => {
    const rl = features.rateLimit('reg:' + (socket.handshake.address || socket.id), 15, 15 * 60 * 1000);
    if (!rl.ok) {
      if (typeof ack === 'function') ack(rl);
      return;
    }
    const rawProfile = {
      displayName: data && (data.displayName || data.username),
      gender: data && data.gender,
      age: data && data.age,
      country: data && data.country,
      city: data && data.city,
      interests: data && data.interests,
      image: data && data.image
    };
    const displayName = String(rawProfile.displayName || '').trim().slice(0, 24);
    const gender = rawProfile.gender === 'female' ? 'female' : (rawProfile.gender === 'male' ? 'male' : '');
    const age = safety.parseAge(rawProfile.age);
    const country = String(rawProfile.country || '').trim();
    const city = String(rawProfile.city || '').trim();
    if (!displayName) {
      if (typeof ack === 'function') ack({ ok: false, message: 'Please choose a display name.' });
      return;
    }
    if (!gender) {
      if (typeof ack === 'function') ack({ ok: false, message: 'Please choose male or female.' });
      return;
    }
    if (!safety.isValidAge(age)) {
      if (typeof ack === 'function') ack({ ok: false, message: 'Age must be 18–99.' });
      return;
    }
    if (!isValidLocation(country, city)) {
      if (typeof ack === 'function') ack({ ok: false, message: 'Please pick a valid country and city from the list.' });
      return;
    }
    const nameCheck = safety.validateUsername(displayName);
    if (!nameCheck.ok) {
      if (typeof ack === 'function') ack({ ok: false, message: nameCheck.message || 'Invalid display name.' });
      return;
    }
    const result = await accounts.register(data && data.email, data && data.password, {
      displayName: nameCheck.text,
      gender,
      age,
      country,
      city,
      interests: Array.isArray(rawProfile.interests) ? rawProfile.interests : [],
      image: rawProfile.image || null
    });
    if (typeof ack === 'function') ack(result);
    else socket.emit('account-result', { action: 'register', ...result });
  });

  socket.on('account-password-reset-request', async (data, ack) => {
    const rl = features.rateLimit('reset:' + (socket.handshake.address || socket.id), 10, 15 * 60 * 1000);
    if (!rl.ok) {
      if (typeof ack === 'function') ack(rl);
      return;
    }
    const result = await accounts.requestPasswordReset(data && data.email);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('account-password-reset', (data, ack) => {
    const result = accounts.resetPassword(data && data.email, data && data.code, data && data.password);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('account-verify', (data, ack) => {
    const result = accounts.verify(data && data.email, data && data.code);
    if (result.ok) {
      bindAccountToSocket(data.email);
      accounts.touchLastLogin(data.email);
      io.emit('members-changed');
      broadcastOnlineUsers();
      broadcastStats();
    }
    if (typeof ack === 'function') ack(result);
    else socket.emit('account-result', { action: 'verify', ...result });
  });

  socket.on('account-login', async (data, ack) => {
    const rl = features.rateLimit('login:' + (socket.handshake.address || socket.id), 20, 15 * 60 * 1000);
    if (!rl.ok) {
      if (typeof ack === 'function') ack(rl);
      return;
    }
    const result = await accounts.login(data && data.email, data && data.password);
    if (result.ok) {
      bindAccountToSocket(data.email);
      io.emit('members-changed');
      broadcastOnlineUsers();
      broadcastStats();
    }
    if (typeof ack === 'function') ack(result);
    else socket.emit('account-result', { action: 'login', ...result });
  });

  socket.on('account-restore', (data, ack) => {
    const result = accounts.restoreAuth(data && data.token);
    if (result.ok && result.account) {
      bindAccountToSocket(result.account.email);
      accounts.touchLastSeen(result.account.email);
      result.unread = inbox.unreadCount(result.account.email);
      broadcastOnlineUsers();
      broadcastStats();
    }
    if (typeof ack === 'function') ack(result);
  });

  socket.on('account-resend-code', async (data, ack) => {
    const result = await accounts.resendCode(data && data.email);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('account-unbind-tab', (data, ack) => {
    const token = sessionTokenOfSocket();
    accounts.unbindSession(token);
    socket.accountEmail = null;
    broadcastOnlineUsers();
    broadcastStats();
    io.emit('members-changed');
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('account-logout', (data, ack) => {
    const email = accountEmailOfSocket();
    const token = sessionTokenOfSocket();
    if (email) accounts.touchLastSeen(email);
    accounts.unbindSession(token);
    if (data && data.authToken) accounts.revokeAuthToken(data.authToken);
    else if (email) accounts.revokeAuthTokensForEmail(email);
    socket.accountEmail = null;
    io.emit('members-changed');
    broadcastOnlineUsers();
    broadcastStats();
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('account-status', (data, ack) => {
    ack = pickAck(data, ack);
    const email = accountEmailOfSocket();
    const acc = email ? accounts.getAccountByEmail(email) : null;
    const payload = {
      ok: !!(acc && acc.verified),
      account: acc && acc.verified ? accounts.publicAccount(acc) : null,
      emailConfigured: accounts.emailConfigured(),
      unread: email ? inbox.unreadCount(email) : 0,
      isOwner: !!(acc && accounts.isOwner(acc.email))
    };
    if (typeof ack === 'function') ack(payload);
    else socket.emit('account-status', payload);
  });

  socket.on('friend-add', (data, ack) => {
    const targetRawEarly = (data && (data.email || data.targetEmail || data.targetId || data.targetSessionToken)) || null;
    if (isSiteBotTarget(targetRawEarly)) {
      if (typeof ack === 'function') ack({ ok: false, message: 'The site bot is not a person — you cannot add it as a friend.' });
      return;
    }
    const me = requireVerifiedAccount();
    const token = me ? me.token : sessionTokenOfSocket();
    const targetRaw = (data && (data.email || data.targetEmail || data.targetId || data.targetSessionToken)) || null;
    const result = accounts.sendFriendRequest(token, targetRaw, resolveAccountEmail);
    if (result.ok && result.targetEmail) {
      const fromEmail = accountEmailOfSocket();
      if (result.alreadyFriends) {
        emitToEmail(result.targetEmail, 'friend-added', {
          email: fromEmail,
          message: 'You are friends now.'
        });
      } else if (result.pending) {
        emitToEmail(result.targetEmail, 'friend-request', {
          email: fromEmail,
          displayName: (socket.profile && socket.profile.username) || (fromEmail && fromEmail.split('@')[0]),
          message: 'Someone sent you a friend request.'
        });
      }
    }
    if (typeof ack === 'function') ack(result);
    else socket.emit('friend-result', result);
  });

  socket.on('friend-accept', (data, ack) => {
    const me = requireVerifiedAccount();
    const result = accounts.acceptFriendRequest(me ? me.token : sessionTokenOfSocket(), data && (data.email || data.fromEmail));
    if (result.ok && result.targetEmail) {
      emitToEmail(result.targetEmail, 'friend-added', {
        email: accountEmailOfSocket(),
        message: 'Your friend request was accepted.'
      });
    }
    if (typeof ack === 'function') ack(result);
  });

  socket.on('friend-decline', (data, ack) => {
    const me = requireVerifiedAccount();
    const result = accounts.declineFriendRequest(me ? me.token : sessionTokenOfSocket(), data && (data.email || data.fromEmail));
    if (typeof ack === 'function') ack(result);
  });

  socket.on('friend-remove', (data, ack) => {
    const me = requireVerifiedAccount();
    const result = accounts.removeFriend(me ? me.token : sessionTokenOfSocket(), data && (data.email || data.friendEmail));
    if (typeof ack === 'function') ack(result);
  });

  socket.on('friend-list', (data, ack) => {
    ack = pickAck(data, ack);
    const me = requireVerifiedAccount();
    const result = accounts.listFriendsWithPresence(me ? me.token : sessionTokenOfSocket(), friendPresenceForEmail);
    if (typeof ack === 'function') ack(result);
    else socket.emit('friend-list', result);
  });

  socket.on('friend-requests', (data, ack) => {
    ack = pickAck(data, ack);
    const me = requireVerifiedAccount();
    const result = accounts.listFriendRequests(me ? me.token : sessionTokenOfSocket(), friendPresenceForEmail);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('users-list', (data, ack) => {
    ack = pickAck(data, ack);
    const me = requireVerifiedAccount();
    const result = accounts.listRegisteredUsers(me ? me.token : sessionTokenOfSocket(), friendPresenceForEmail);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('members-public', (data, ack) => {
    ack = pickAck(data, ack);
    const result = accounts.listPublicMembers(friendPresenceForEmail);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('account-delete', (data, ack) => {
    const me = requireVerifiedAccount();
    if (!me) {
      if (typeof ack === 'function') ack({ ok: false, message: 'Please log in first.' });
      return;
    }
    const result = accounts.deleteAccount(me.token, data && data.password);
    if (result.ok) {
      inbox.deleteThreadsForEmail(result.email);
      socket.accountEmail = null;
      io.emit('members-changed');
    }
    if (typeof ack === 'function') ack(result);
  });

  socket.on('account-update-profile', (data, ack) => {
    const me = requireVerifiedAccount();
    if (!me) {
      if (typeof ack === 'function') ack({ ok: false, message: 'Log in first.' });
      return;
    }
    const patch = data || {};
    if ((patch.country || patch.city) && !isValidLocation(patch.country, patch.city)) {
      if (typeof ack === 'function') ack({ ok: false, message: 'Please pick a valid country and city from the list.' });
      return;
    }
    if (patch.displayName) {
      const nameCheck = safety.validateUsername(patch.displayName);
      if (!nameCheck.ok) {
        if (typeof ack === 'function') ack({ ok: false, message: nameCheck.message || 'Invalid name.' });
        return;
      }
      patch.displayName = nameCheck.text;
    }
    const result = accounts.updateMemberProfile(me.token, patch);
    if (result.ok) {
      io.emit('members-changed');
      broadcastOnlineUsers();
    }
    if (typeof ack === 'function') ack(result);
  });

  socket.on('admin-users', (data, ack) => {
    ack = pickAck(data, ack);
    const me = requireVerifiedAccount();
    const result = accounts.listAllUsersAdmin(me ? me.token : sessionTokenOfSocket(), friendPresenceForEmail);
    if (result.ok) {
      result.reports = features.getReports(100);
    }
    if (typeof ack === 'function') ack(result);
  });

  socket.on('account-block', (data, ack) => {
    const me = requireVerifiedAccount();
    const result = accounts.blockAccount(me ? me.token : sessionTokenOfSocket(), data && (data.email || data.targetEmail));
    if (typeof ack === 'function') ack(result);
  });

  socket.on('account-unblock', (data, ack) => {
    const me = requireVerifiedAccount();
    const result = accounts.unblockAccount(me ? me.token : sessionTokenOfSocket(), data && (data.email || data.targetEmail));
    if (typeof ack === 'function') ack(result);
  });

  socket.on('account-blocked-list', (data, ack) => {
    ack = pickAck(data, ack);
    const me = requireVerifiedAccount();
    const result = accounts.listBlockedAccounts(me ? me.token : sessionTokenOfSocket());
    if (typeof ack === 'function') ack(result);
  });

  socket.on('inbox-list', (data, ack) => {
    ack = pickAck(data, ack);
    const me = requireVerifiedAccount();
    if (!me) {
      if (typeof ack === 'function') ack({ ok: false, threads: [], message: 'Log in to use Inbox.' });
      return;
    }
    const threads = inbox.listThreads(me.email, (partner) => {
      const p = friendPresenceForEmail(partner) || {};
      const acc = accounts.getAccountByEmail(partner);
      return {
        displayName: (acc && acc.displayName) || (p.username) || (partner && partner.split('@')[0]),
        online: !!p.online,
        away: !!p.away,
        lastSeenAt: acc ? acc.lastSeenAt : null,
        lastLoginAt: acc ? acc.lastLoginAt : null
      };
    });
    if (typeof ack === 'function') {
      ack({ ok: true, threads, unread: inbox.unreadCount(me.email), isOwner: accounts.isOwner(me.email) });
    }
  });

  socket.on('inbox-open', (data, ack) => {
    const me = requireVerifiedAccount();
    const partner = resolveAccountEmail((data && (data.email || data.partnerEmail)) || '');
    if (!me) {
      if (typeof ack === 'function') ack({ ok: false, message: 'Log in to use Inbox.' });
      return;
    }
    if (!partner) {
      if (typeof ack === 'function') ack({ ok: false, message: 'User not found.' });
      return;
    }
    if (!accounts.isOwner(me.email) && accounts.isBlockedAccount(me.email, partner)) {
      if (typeof ack === 'function') ack({ ok: false, message: 'You cannot open this conversation.' });
      return;
    }
    const thread = inbox.getThread(me.email, partner);
    const marked = inbox.markThreadRead(me.email, partner);
    if (marked.ok && marked.newlyRead && marked.newlyRead.length) {
      emitToEmail(partner, 'inbox-read', {
        reader: me.email,
        ids: marked.newlyRead,
        at: marked.at
      });
    }
    const acc = accounts.getAccountByEmail(partner);
    const p = friendPresenceForEmail(partner) || {};
    const lim = inbox.limitStatus(me.email, partner, accounts.isOwner);
    pushUnread(me.email);
    if (typeof ack === 'function') {
      ack({
        ok: true,
        ...thread,
        partnerDisplay: (acc && acc.displayName) || p.username || partner.split('@')[0],
        online: !!p.online,
        away: !!p.away,
        lastSeenAt: acc ? acc.lastSeenAt : null,
        lastLoginAt: acc ? acc.lastLoginAt : null,
        isFriend: !!(me.acc.friends || []).includes(partner),
        blocked: accounts.isBlockedAccount(me.email, partner),
        limit: lim,
        isOwner: accounts.isOwner(me.email)
      });
    }
  });

  socket.on('inbox-send', async (data, ack) => {
    const me = requireVerifiedAccount();
    if (!me) {
      if (typeof ack === 'function') ack({ ok: false, message: 'Log in to use Inbox.' });
      return;
    }
    const partner = resolveAccountEmail((data && (data.email || data.partnerEmail || data.to)) || '');
    if (!partner) {
      if (typeof ack === 'function') ack({ ok: false, message: 'User not found.' });
      return;
    }
    const targetAcc = accounts.getAccountByEmail(partner);
    if (!targetAcc || !targetAcc.verified) {
      if (typeof ack === 'function') ack({ ok: false, message: 'That user is not a registered member.' });
      return;
    }
    if (!accounts.isOwner(me.email) && accounts.isBlockedAccount(me.email, partner)) {
      if (typeof ack === 'function') ack({ ok: false, message: 'You cannot message this user.' });
      return;
    }
    const textCheck = safety.validateChatText ? safety.validateChatText(data && data.text) : { ok: true, text: String((data && data.text) || '').trim() };
    if (!textCheck.ok) {
      if (typeof ack === 'function') ack({ ok: false, message: textCheck.message || 'Message not allowed.' });
      return;
    }
    const rl = features.rateLimit('inbox:' + me.email, accounts.isOwner(me.email) ? 500 : 40, 60 * 1000);
    if (!rl.ok) {
      if (typeof ack === 'function') ack(rl);
      return;
    }
    const fromName = (me.acc.displayName) || (socket.profile && socket.profile.username) || me.email.split('@')[0];
    const result = inbox.sendMessage({
      fromEmail: me.email,
      toEmail: partner,
      text: textCheck.text || (data && data.text),
      isOwnerFn: accounts.isOwner,
      fromName
    });
    if (!result.ok) {
      if (typeof ack === 'function') ack(result);
      return;
    }
    noteStealthReveal(socket, partner);
    const inboxSender = senderPublicMeta(socket);

    const liveCount = emitToEmail(partner, 'inbox-new', {
      threadId: result.threadId,
      message: { ...result.message, fromSelf: false },
      from: me.email,
      fromName,
      fromPublicId: accounts.publicIdOf(me.email),
      hidden: inboxSender.hidden,
      unread: inbox.unreadCount(partner)
    });
    if (liveCount > 0) {
      inbox.markDelivered(result.message.id, result.threadId);
      result.message.status = 'delivered';
      emitToEmail(me.email, 'inbox-delivered', { id: result.message.id, partner });
    } else if (inbox.shouldEmailNotify(partner, result.threadId)) {
      mail.sendInboxNotification(partner, fromName, result.message.text).catch((e) => {
        console.warn('[inbox] notify email failed:', e.message);
      });
    }
    pushUnread(partner);
    pushUnread(me.email);
    if (typeof ack === 'function') {
      ack({
        ok: true,
        message: { ...result.message, fromSelf: true },
        remaining: result.remaining,
        unlimited: result.unlimited,
        used: result.used
      });
    }
  });

  socket.on('inbox-mark-read', (data, ack) => {
    const me = requireVerifiedAccount();
    const partner = resolveAccountEmail((data && (data.email || data.partnerEmail)) || '');
    if (!me || !partner) {
      if (typeof ack === 'function') ack({ ok: false });
      return;
    }
    const marked = inbox.markThreadRead(me.email, partner);
    if (marked.ok && marked.newlyRead && marked.newlyRead.length) {
      emitToEmail(partner, 'inbox-read', { reader: me.email, ids: marked.newlyRead, at: marked.at });
    }
    pushUnread(me.email);
    if (typeof ack === 'function') ack(marked);
  });

  socket.on('inbox-delete', (data, ack) => {
    const me = requireVerifiedAccount();
    const partner = resolveAccountEmail((data && (data.email || data.partnerEmail)) || '');
    const msgId = data && data.msgId;
    if (!me || !partner || !msgId) {
      if (typeof ack === 'function') ack({ ok: false, message: 'Missing message.' });
      return;
    }
    const result = inbox.deleteMessage(me.email, msgId, partner);
    if (result.ok) {
      emitToEmail(partner, 'inbox-deleted', { msgId, partner: me.email });
      socket.emit('inbox-deleted', { msgId, partner });
    }
    if (typeof ack === 'function') ack(result);
  });

  socket.on('inbox-unread', (data, ack) => {
    ack = pickAck(data, ack);
    const me = requireVerifiedAccount();
    const count = me ? inbox.unreadCount(me.email) : 0;
    if (typeof ack === 'function') ack({ ok: !!me, count });
  });

  // ---- Report ----
  socket.on('report-user', (data, ack) => {
    if (data && isSiteBotTarget(data.targetId)) {
      if (typeof ack === 'function') ack({ ok: false, message: 'That is the site bot, not a person. You cannot report it as a user.' });
      return;
    }
    const rl = features.rateLimit('report:' + socket.id, 10, 60 * 60 * 1000);
    if (!rl.ok) {
      if (typeof ack === 'function') ack(rl);
      return;
    }
    const targetId = data && data.targetId;
    const { session: tSess } = resolveLiveSocketForTarget(targetId);
    const result = features.addReport({
      reporterId: socket.id,
      reporterToken: socket.sessionToken,
      reporterName: socket.profile && socket.profile.username,
      targetId,
      targetToken: tSess ? sessionTokenOf(tSess) : (data && data.targetSessionToken),
      targetName: (tSess && tSess.profile && tSess.profile.username) || (data && data.targetName),
      reason: data && data.reason,
      details: data && data.details
    });
    if (typeof ack === 'function') ack(result);
  });

  // ---- Silent delete (unsend) — no tombstone / no trail for the other user ----
  socket.on('delete-message', (data, ack) => {
    const msgId = data && data.msgId ? String(data.msgId) : '';
    const targetId = data && data.targetId;
    const targetSessionToken = data && data.targetSessionToken;
    if (!msgId) {
      if (typeof ack === 'function') ack({ ok: false, message: 'Missing message id.' });
      return;
    }
    const ownerKey = socket.sessionToken || socket.id;
    const allowed =
      features.allowSilentDelete(msgId, ownerKey) ||
      features.allowSilentDelete(msgId, socket.id);

    if (!allowed) {
      if (typeof ack === 'function') ack({ ok: false, message: 'You can only delete your own messages.' });
      return;
    }

    features.forgetMessage(msgId);

    // Minimal payload only — never a "message deleted" placeholder for the peer
    const payload = { msgId };
    socket.emit('message-deleted', payload);

    let targetSocket = resolveLiveSocketForTarget(targetId).socket;
    if (!targetSocket && targetSessionToken) {
      targetSocket = resolveLiveSocketForTarget(targetSessionToken).socket;
    }
    if (targetSocket && targetSocket.id !== socket.id) {
      targetSocket.emit('message-deleted', payload);
    }

    const { session: tSess } = resolveLiveSocketForTarget(targetId || targetSessionToken);
    if (tSess && isSessionInGrace(tSess) && (!targetSocket || !targetSocket.connected)) {
      queuePending(tSess, { type: 'message-deleted', payload });
    }

    if (typeof ack === 'function') ack({ ok: true });
  });

  // ---- Reactions ----
  socket.on('message-react', (data, ack) => {
    const msgId = data && data.msgId;
    const emoji = data && data.emoji;
    const targetId = data && data.targetId;
    const targetSessionToken = data && data.targetSessionToken;
    if (!msgId || !emoji) {
      if (typeof ack === 'function') ack({ ok: false, message: 'Missing message or emoji.' });
      return;
    }
    const reactorKey = socket.sessionToken || socket.id;
    const result = features.toggleReaction(msgId, emoji, reactorKey);
    if (!result.ok) {
      if (typeof ack === 'function') ack(result);
      return;
    }
    const payload = {
      msgId,
      reactions: result.snapshot,
      by: socket.id,
      byToken: socket.sessionToken
    };
    // Always confirm to reactor
    socket.emit('message-reactions', payload);
    // Deliver to chat partner (try socket id, then session token)
    let targetSocket = resolveLiveSocketForTarget(targetId).socket;
    if (!targetSocket && targetSessionToken) {
      targetSocket = resolveLiveSocketForTarget(targetSessionToken).socket;
    }
    if (targetSocket && targetSocket.id !== socket.id) {
      targetSocket.emit('message-reactions', payload);
    }
    if (typeof ack === 'function') ack(result);
  });

  // ---- Read receipts ----
  socket.on('mark-read', (data) => {
    const partnerId = data && data.targetId;
    if (!partnerId) return;
    const myKey = socket.sessionToken || socket.id;
    const { session: tSess } = resolveLiveSocketForTarget(partnerId);
    const partnerKey = (tSess && sessionTokenOf(tSess)) || partnerId;
    const result = features.markRead(myKey, partnerKey, data.lastMsgId);
    const { socket: targetSocket } = resolveLiveSocketForTarget(partnerId);
    if (targetSocket) {
      targetSocket.emit('read-receipt', {
        readerId: socket.id,
        readerToken: socket.sessionToken,
        lastMsgId: data.lastMsgId,
        at: result.at
      });
    }
  });

  // ---- Mute ----
  socket.on('mute-chat', (data, ack) => {
    const token = socket.sessionToken || socketToSession.get(socket.id);
    const partnerKey = (data && (data.targetSessionToken || data.targetId)) || null;
    const result = data && data.unmute
      ? features.unmutePartner(token, partnerKey)
      : features.mutePartner(token, partnerKey);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('list-mutes', (ack) => {
    const token = socket.sessionToken || socketToSession.get(socket.id);
    if (typeof ack === 'function') ack({ ok: true, mutes: features.listMutes(token) });
  });

  // ---- Unblock ----
  socket.on('unblock-user', (data, ack) => {
    const token = socket.sessionToken || socketToSession.get(socket.id);
    const targetKey = data && (data.targetId || data.targetSessionToken);
    const result = features.unblock(token, socket.id, targetKey, blockedUsers, blockedBySession);
    broadcastOnlineUsers();
    if (typeof ack === 'function') ack(result);
  });

  socket.on('list-blocked', (ack) => {
    const token = socket.sessionToken || socketToSession.get(socket.id);
    const list = features.listBlocked(token, socket.id, blockedUsers, blockedBySession);
    if (typeof ack === 'function') ack({ ok: true, blocked: list });
  });

  // ---- Invite link ----
  socket.on('create-invite', (ack) => {
    const token = socket.sessionToken || socketToSession.get(socket.id);
    const username = (socket.profile && socket.profile.username) || 'Someone';
    const result = features.createInvite(token, username);
    if (typeof ack === 'function') ack(result);
  });

  // Suppress muted notifications: wrap receive for muted (client also filters)
  // (Server still delivers; client skips badge/sound when muted)

  // Explicit log off — remove immediately (no grace period)
  socket.on('logout', (ack) => {
    const partnerId = getPartnerId(socket.id);
    const removed = forceLogoutSocket(socket, 'logout');
    const name = removed && removed.profile && removed.profile.username;
    console.log(`[logout] ${name || socket.id} (removed=${!!removed})`);

    // Tell active chat partner this leave is permanent (not temporary grace)
    if (partnerId) {
      const partner = getLiveSocket(partnerId);
      if (partner) {
        partner.emit('partner-left', {
          reason: 'logout',
          partnerId: socket.id,
          temporary: false
        });
        partner.emit('chat-left', { by: socket.id, partnerId: socket.id, logout: true });
      }
      unpair(partnerId);
    }

    // Broadcast first so other clients drop this user from online lists
    broadcastOnlineUsers();
    broadcastStats();
    socket.emit('logged-out', { ok: true });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('set-hidden-mode', (data, ack) => {
    const tok = resolveSessionTokenForSocket(socket);
    const sess = tok ? sessions.get(tok) : null;
    if (!sess) {
      socket.stealth = !!(data && data.hidden);
      if (typeof ack === 'function') ack({ ok: true, hidden: !!socket.stealth, pending: true });
      return;
    }
    sess.stealth = !!(data && data.hidden);
    socket.stealth = sess.stealth;
    if (!sess.revealedTo) sess.revealedTo = new Set();
    broadcastOnlineUsers();
    broadcastStats();
    if (typeof ack === 'function') ack({ ok: true, hidden: sess.stealth });
  });

  socket.on('browse-leave', () => {
    const token = resolveSessionTokenForSocket(socket);
    const sess = token ? sessions.get(token) : null;
    if (sess) sess.browseHidden = true;
    broadcastOnlineUsers();
    broadcastStats();
  });

  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} (${reason})`);
    siteBotChats.delete(socket.id);

    // Intentional log off already removed the session — do not start grace
    if (socket.intentionalLogout) {
      socketToSession.delete(socket.id);
      broadcastOnlineUsers();
      broadcastStats();
      return;
    }

    const token = socketToSession.get(socket.id) || socket.sessionToken;
    const sess = token ? sessions.get(token) : null;

    // If already removed via logout, nothing left to grace
    if (socket.accountEmail) {
      accounts.touchLastSeen(socket.accountEmail);
    }

    if (sess) {
      sess.disconnectedAt = Date.now();
      // Keep socketId so list/chat remapping still works until grace ends
      clearGraceTimer(sess);
      sess.graceTimer = setTimeout(() => {
        removeSession(token, 'grace-timeout');
        broadcastOnlineUsers();
        broadcastStats();
      }, SESSION_GRACE_MS);
      // Stay visible on online list during grace
      broadcastOnlineUsers();
      broadcastStats();
      console.log(`[session] grace started for ${sess.profile && sess.profile.username} (${SESSION_GRACE_MS}ms)`);
    } else {
      socketToSession.delete(socket.id);
      broadcastOnlineUsers();
      broadcastStats();
    }

    const partnerId = getPartnerId(socket.id);
    if (partnerId) {
      const partner = getLiveSocket(partnerId);
      if (partner) {
        partner.emit('partner-left', {
          reason: 'disconnected',
          partnerId: socket.id,
          temporary: true,
          graceMs: SESSION_GRACE_MS
        });
      }
    }
  });

  socket.on('typing', (data) => {
    const targetId = data && data.targetId;
    if (targetId) {
      const { socket: t } = resolveLiveSocketForTarget(targetId);
      if (t) t.emit('typing', { fromId: socket.id });
      return;
    }
    const partnerId = getPartnerId(socket.id);
    const partner = getLiveSocket(partnerId);
    if (partner) partner.emit('typing', { fromId: socket.id });
  });

  socket.on('stop-typing', (data) => {
    const targetId = data && data.targetId;
    if (targetId) {
      const { socket: t } = resolveLiveSocketForTarget(targetId);
      if (t) t.emit('stop-typing', { fromId: socket.id });
      return;
    }
    const partnerId = getPartnerId(socket.id);
    const partner = getLiveSocket(partnerId);
    if (partner) partner.emit('stop-typing', { fromId: socket.id });
  });
});

const PORT = process.env.PORT || 3000;

function startListening() {
  server.listen(PORT, () => {
    const mailInfo = mail.mailStatus();
    console.log(`\nPineappleChat running on http://localhost:${PORT}`);
    console.log(`Demo users: ${ENABLE_DEMO_USERS ? 'ON' : 'OFF'}`);
    console.log(`Site bot: ON (${SITE_BOT_PROFILE.username})`);
    console.log(`Session grace: ${SESSION_GRACE_MS / 1000}s after disconnect`);
    console.log(`Email: ${mailInfo.configured ? 'CONFIGURED (' + mailInfo.provider + ')' : 'NOT CONFIGURED — set RESEND_API_KEY or SMTP_* to send verification codes'}`);
    console.log(`Owner: ${accounts.ownerEmail()}`);
    console.log(`Backup: ${backup.configured() ? 'Gist (friends + inbox survive deploys)' : 'OFF — friends/inbox reset on Render deploy until DATA_GIST_ID is set'}`);
    console.log('Open that URL in your browser to start chatting!\n');
  });
}

backup
  .restore()
  .then((info) => {
    if (info && info.restored) {
      accounts.reload();
      inbox.reload();
      features.reloadReports();
    }
  })
  .catch((e) => console.warn('[backup] startup:', e.message))
  .finally(startListening);
