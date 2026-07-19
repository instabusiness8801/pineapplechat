const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const safety = require(path.join(__dirname, 'public', 'content-safety.js'));
const accounts = require(path.join(__dirname, 'server-accounts.js'));
const features = require(path.join(__dirname, 'server-features.js'));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Helpful behind Render / mobile proxies
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ENABLE_DEMO_USERS = process.env.ENABLE_DEMO_USERS === 'true';
/** Keep user on the online list & allow seamless rejoin for this long after disconnect */
const SESSION_GRACE_MS = 15 * 60 * 1000;

app.get('/api/config', (req, res) => {
  res.json({
    enableDemoUsers: ENABLE_DEMO_USERS,
    appName: 'PineappleChat',
    minAge: safety.MIN_AGE || 18,
    sessionGraceMs: SESSION_GRACE_MS,
    emailConfigured: accounts.emailConfigured(),
    features: {
      block: true,
      friends: true,
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
  // targetId may be current socket id OR a session token
  if (!targetId) return { socket: null, session: null };

  let s = getLiveSocket(targetId);
  if (s) return { socket: s, session: getSessionBySocket(targetId) };

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

    // Prefer live socket id; during grace keep last socket id so clients can match chats
    const id = live ? sess.socketId : sess.socketId || token;
    list.push({
      id,
      sessionToken: token,
      profile: sess.profile,
      away: !live && !!inGrace
    });
  }
  return list;
}

function buildOnlineListForViewer(viewerSocketId, viewerToken) {
  const list = buildOnlineList();
  if (!viewerSocketId && !viewerToken) return list;
  return list.filter((u) => {
    if (!u) return false;
    if (viewerSocketId && u.id === viewerSocketId) return true; // keep self out client-side anyway
    if (viewerToken && u.sessionToken === viewerToken) return true;
    return !viewerBlocksTarget(viewerSocketId, viewerToken, u.id, u.sessionToken);
  });
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
  const list = buildOnlineList();
  const online = list.length;
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

    socket.emit('profile-accepted', {
      id: socket.id,
      sessionToken: token,
      sessionGraceMs: SESSION_GRACE_MS,
      pendingCount: (sess.pending && sess.pending.length) || 0
    });

    // Deliver queued messages after client finishes profile-accepted / hub restore
    flushPendingSoon(sess);

    broadcastOnlineUsers();
    broadcastStats();
    console.log(`[profile] ${cleanedProfile.username} socket=${socket.id} token=${token.slice(0, 8)}…`);
  });

  socket.on('start-chat-with', (data) => {
    const targetId = data && data.targetId;
    if (!targetId || targetId === socket.id) return;

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

    socket.emit('chat-started', {
      partnerId: targetSocket.id,
      partnerProfile: theirProfile,
      partnerSessionToken: theirToken
    });
    targetSocket.emit('chat-started', {
      partnerId: socket.id,
      partnerProfile: myProfile,
      partnerSessionToken: socket.sessionToken
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

    const payload = {
      msgId,
      text: clean,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      senderId: socket.id,
      senderSessionToken: socket.sessionToken,
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

    const { socket: targetSocket, session: targetSess } = resolveLiveSocketForTarget(targetId);
    const targetTok = targetSess ? sessionTokenOf(targetSess) : null;
    if (isBlockedBetween(socket.id, targetId, socket.sessionToken, targetTok)) return;

    // Always queue when target is in grace (even if a zombie socket still looks "connected")
    if (targetSess && isSessionInGrace(targetSess)) {
      queuePending(targetSess, { type: 'message', payload: { ...payload, fromSelf: false } });
      socket.emit('receive-message', { ...payload, fromSelf: true });
      // Soft notice once-style (non-blocking for sender UI)
      socket.emit('delivery-status', {
        targetId,
        queued: true,
        message: 'User is reconnecting — message will be delivered when they are back (within 15 min).'
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
        message: 'User is reconnecting — message will be delivered when they are back (within 15 min).'
      });
      return;
    }

    socket.emit('chat-error', { message: 'Message not delivered — that user is offline.' });
  });

  socket.on('send-attachment-to', (data) => {
    const targetId = data && data.targetId;
    const attachment = data && data.attachment;
    if (!targetId || !attachment || !attachment.data) return;

    if (isBlocked(socket.id, targetId)) return;

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
    const payload = {
      msgId: attMsgId,
      attachment,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      senderId: socket.id,
      senderSessionToken: socket.sessionToken,
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

    const { socket: targetSocket, session: targetSess } = resolveLiveSocketForTarget(targetId);

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
    const { socket: targetSocket } = resolveLiveSocketForTarget(targetId);
    if (targetSocket) {
      targetSocket.emit('chat-left', { by: socket.id, partnerId: socket.id });
    }
    socket.emit('chat-left', { by: socket.id, partnerId: targetId });
  });

  socket.on('block-user', (data) => {
    const targetId = data && data.targetId;
    if (!targetId) return;

    const { socket: targetSocket, session: targetSess } = resolveLiveSocketForTarget(targetId);
    const myToken = socket.sessionToken || socketToSession.get(socket.id);
    const theirToken = targetSess ? sessionTokenOf(targetSess) : (data.targetSessionToken || null);

    blockPair(socket.id, myToken, targetId, theirToken);
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

  // ---- Email account + friends ----
  socket.on('account-register', async (data, ack) => {
    const rl = features.rateLimit('reg:' + (socket.handshake.address || socket.id), 8, 15 * 60 * 1000);
    if (!rl.ok) {
      if (typeof ack === 'function') ack(rl);
      return;
    }
    const result = await accounts.register(data && data.email, data && data.password);
    if (typeof ack === 'function') ack(result);
    else socket.emit('account-result', { action: 'register', ...result });
  });

  socket.on('account-verify', (data, ack) => {
    const result = accounts.verify(data && data.email, data && data.code);
    if (result.ok) {
      const token = socket.sessionToken || socketToSession.get(socket.id);
      if (token) accounts.bindSession(token, data.email);
      socket.accountEmail = String(data.email || '').trim().toLowerCase();
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
      const token = socket.sessionToken || socketToSession.get(socket.id);
      if (token) accounts.bindSession(token, data.email);
      socket.accountEmail = String(data.email || '').trim().toLowerCase();
    }
    if (typeof ack === 'function') ack(result);
    else socket.emit('account-result', { action: 'login', ...result });
  });

  socket.on('account-resend-code', async (data, ack) => {
    const result = await accounts.resendCode(data && data.email);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('account-status', (ack) => {
    const token = socket.sessionToken || socketToSession.get(socket.id);
    const acc = accounts.getAccountForSession(token);
    const payload = {
      ok: !!acc,
      account: acc ? accounts.publicAccount(acc) : null,
      emailConfigured: accounts.emailConfigured()
    };
    if (typeof ack === 'function') ack(payload);
    else socket.emit('account-status', payload);
  });

  socket.on('friend-add', (data, ack) => {
    const token = socket.sessionToken || socketToSession.get(socket.id);
    const targetId = data && (data.targetId || data.targetSessionToken);
    const result = accounts.addFriend(token, targetId, (idOrTok) => {
      const { session: tSess } = resolveLiveSocketForTarget(idOrTok);
      if (!tSess) {
        const s = getSessionByToken(idOrTok);
        if (s) {
          const t = sessionTokenOf(s);
          return accounts.getEmailForSession(t);
        }
        return null;
      }
      const t = sessionTokenOf(tSess);
      return accounts.getEmailForSession(t);
    });
    if (result.ok && result.targetEmail) {
      for (const sock of io.sockets.sockets.values()) {
        if (!sock.connected) continue;
        const t = sock.sessionToken || socketToSession.get(sock.id);
        if (accounts.getEmailForSession(t) === result.targetEmail) {
          sock.emit('friend-added', {
            email: accounts.getEmailForSession(token),
            message: 'Someone added you as a friend.'
          });
        }
      }
    }
    if (typeof ack === 'function') ack(result);
    else socket.emit('friend-result', result);
  });

  function friendPresenceForEmail(email) {
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

  socket.on('friend-list', (ack) => {
    const token = socket.sessionToken || socketToSession.get(socket.id);
    const result = accounts.listFriendsWithPresence(token, friendPresenceForEmail);
    if (typeof ack === 'function') ack(result);
    else socket.emit('friend-list', result);
  });

  // ---- Report ----
  socket.on('report-user', (data, ack) => {
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

  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} (${reason})`);

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
server.listen(PORT, () => {
  console.log(`\nPineappleChat running on http://localhost:${PORT}`);
  console.log(`Demo users: ${ENABLE_DEMO_USERS ? 'ON' : 'OFF'}`);
  console.log(`Session grace: ${SESSION_GRACE_MS / 1000}s after disconnect`);
  console.log('Open that URL in your browser to start chatting!\n');
});
