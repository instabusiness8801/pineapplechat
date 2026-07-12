const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const crypto = require('crypto');
const safety = require(path.join(__dirname, 'public', 'content-safety.js'));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Helpful behind Render / mobile proxies
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

const ENABLE_DEMO_USERS = process.env.ENABLE_DEMO_USERS === 'true';
/** Keep user on the online list & allow seamless rejoin for this long after disconnect */
const SESSION_GRACE_MS = 2 * 60 * 1000;

app.get('/api/config', (req, res) => {
  res.json({
    enableDemoUsers: ENABLE_DEMO_USERS,
    appName: 'PineappleChat',
    minAge: safety.MIN_AGE || 18,
    sessionGraceMs: SESSION_GRACE_MS
  });
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
const blockedUsers = new Map(); // socketId -> Set

function newSessionToken() {
  return crypto.randomBytes(16).toString('hex');
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
  let s = getLiveSocket(targetId);
  if (s) return { socket: s, session: getSessionBySocket(targetId) };
  const sess = getSessionByToken(targetId);
  if (sess && sess.socketId) {
    s = getLiveSocket(sess.socketId);
    if (s) return { socket: s, session: sess };
  }
  // Find session whose socketId matches targetId but briefly disconnected
  for (const sess of sessions.values()) {
    if (sess.socketId === targetId && getLiveSocket(sess.socketId)) {
      return { socket: getLiveSocket(sess.socketId), session: sess };
    }
  }
  return { socket: null, session: sess || null };
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
  const blockedByA = blockedUsers.get(userA);
  if (blockedByA && blockedByA.has(userB)) return true;
  const blockedByB = blockedUsers.get(userB);
  if (blockedByB && blockedByB.has(userA)) return true;
  return false;
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

/** Permanently remove presence for a socket (log off). No 2‑min grace. */
function forceLogoutSocket(socket, reason) {
  const token = resolveSessionTokenForSocket(socket);
  let removed = null;
  if (token) {
    removed = removeSession(token, reason || 'logout');
  }
  // Always clear socket-local state so reconnect without set-profile stays anonymous
  if (socket) {
    socket.profile = null;
    socket.sessionToken = null;
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

function broadcastOnlineUsers() {
  io.emit('online-users', buildOnlineList());
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
  if (!sess || !sess.pending || !sess.pending.length) return;
  const sock = getLiveSocket(sess.socketId);
  if (!sock) return;
  const queue = sess.pending.splice(0, sess.pending.length);
  for (const msg of queue) {
    if (msg.type === 'message') {
      sock.emit('receive-message', msg.payload);
    } else if (msg.type === 'attachment') {
      sock.emit('receive-attachment', msg.payload);
    } else if (msg.type === 'chat-started') {
      sock.emit('chat-started', msg.payload);
    }
  }
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.emit('online-users', buildOnlineList());
  broadcastStats();

  socket.on('request-online-users', () => {
    socket.emit('online-users', buildOnlineList());
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

    const newUsername = (cleanedProfile.username || '').trim().toLowerCase();

    // Resume existing session within grace window
    let token = typeof cleanedProfile.sessionToken === 'string' ? cleanedProfile.sessionToken.trim() : '';
    let sess = token ? sessions.get(token) : null;

    // Unique username among *other* live/grace sessions
    if (newUsername && newUsername !== 'anonymous') {
      for (const [t, other] of sessions.entries()) {
        if (sess && t === token) continue;
        const existing = (other.profile && other.profile.username || '').trim().toLowerCase();
        if (existing === newUsername) {
          // Same session reconnecting is OK; different session takes the name → error
          const otherLive = other.socketId && getLiveSocket(other.socketId);
          const otherGrace =
            other.disconnectedAt && Date.now() - other.disconnectedAt < SESSION_GRACE_MS;
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
      sess.socketId = socket.id;
      sess.disconnectedAt = null;
      sess.profile = cleanedProfile;
      sess.profile.sessionToken = token;
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
      sessionGraceMs: SESSION_GRACE_MS
    });

    flushPending(sess);

    const list = buildOnlineList();
    socket.emit('online-users', list);
    io.emit('online-users', list);
    broadcastStats();
    console.log(`[profile] ${cleanedProfile.username} socket=${socket.id} token=${token.slice(0, 8)}… online=${list.length}`);
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
      if (awaySess && awaySess.disconnectedAt) {
        const myProfile = socket.profile;
        socket.emit('chat-started', {
          partnerId: awaySess.socketId || targetId,
          partnerProfile: awaySess.profile,
          partnerSessionToken: [...sessions.entries()].find(([, s]) => s === awaySess)?.[0]
        });
        awaySess.pending = awaySess.pending || [];
        awaySess.pending.push({
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

    if (isBlocked(socket.id, targetSocket.id)) {
      socket.emit('chat-error', { message: 'You have blocked this user or they have blocked you.' });
      return;
    }

    const myProfile = socket.profile;
    const theirProfile = targetSess.profile;
    const theirToken = socketToSession.get(targetSocket.id);

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

    const check = safety.validateChatText(text);
    if (!check.ok) {
      socket.emit('chat-error', { message: check.message || 'Message blocked by safety filters.' });
      return;
    }
    const clean = check.text;
    const payload = {
      text: clean,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      senderId: socket.id,
      senderSessionToken: socket.sessionToken
    };

    if (isBlocked(socket.id, targetId)) return;

    const { socket: targetSocket, session: targetSess } = resolveLiveSocketForTarget(targetId);

    if (targetSocket) {
      targetSocket.emit('receive-message', { ...payload, fromSelf: false });
      socket.emit('receive-message', { ...payload, fromSelf: true });
      return;
    }

    // Target temporarily disconnected within grace — queue message
    const awaySess =
      targetSess ||
      getSessionByToken(targetId) ||
      [...sessions.values()].find((s) => s.socketId === targetId);

    if (awaySess && awaySess.disconnectedAt && Date.now() - awaySess.disconnectedAt < SESSION_GRACE_MS) {
      awaySess.pending = awaySess.pending || [];
      awaySess.pending.push({ type: 'message', payload: { ...payload, fromSelf: false } });
      if (awaySess.pending.length > 50) awaySess.pending.shift();
      socket.emit('receive-message', { ...payload, fromSelf: true });
      socket.emit('chat-error', {
        message: 'User is reconnecting — message will be delivered when they are back (within 2 min).'
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

    if (!attachment.type || (!attachment.type.startsWith('image/') && !attachment.type.startsWith('video/'))) {
      socket.emit('chat-error', { message: 'Only image and video files are allowed.' });
      return;
    }

    const payload = {
      attachment,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      senderId: socket.id,
      senderSessionToken: socket.sessionToken
    };

    const { socket: targetSocket, session: targetSess } = resolveLiveSocketForTarget(targetId);
    if (targetSocket) {
      targetSocket.emit('receive-attachment', { ...payload, fromSelf: false });
      socket.emit('receive-attachment', { ...payload, fromSelf: true });
      return;
    }

    const awaySess =
      targetSess ||
      getSessionByToken(targetId) ||
      [...sessions.values()].find((s) => s.socketId === targetId);

    if (awaySess && awaySess.disconnectedAt && Date.now() - awaySess.disconnectedAt < SESSION_GRACE_MS) {
      awaySess.pending = awaySess.pending || [];
      awaySess.pending.push({ type: 'attachment', payload: { ...payload, fromSelf: false } });
      if (awaySess.pending.length > 20) awaySess.pending.shift();
      socket.emit('receive-attachment', { ...payload, fromSelf: true });
      return;
    }

    socket.emit('chat-error', { message: 'Attachment not delivered — that user is offline.' });
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

    if (!blockedUsers.has(socket.id)) blockedUsers.set(socket.id, new Set());
    blockedUsers.get(socket.id).add(targetId);

    const { socket: targetSocket } = resolveLiveSocketForTarget(targetId);
    if (targetSocket) {
      targetSocket.emit('chat-left', { by: socket.id, partnerId: socket.id, blocked: true });
    }
    socket.emit('chat-left', { by: socket.id, partnerId: targetId, blocked: true });
  });

  // Explicit log off — remove immediately (no 2‑minute grace)
  socket.on('logout', (ack) => {
    const partnerId = getPartnerId(socket.id);
    const removed = forceLogoutSocket(socket, 'logout');
    const name = removed && removed.profile && removed.profile.username;
    console.log(`[logout] ${name || socket.id} (removed=${!!removed})`);

    // Tell active chat partner this leave is permanent (not the 2‑min grace)
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
