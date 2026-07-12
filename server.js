const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const safety = require(path.join(__dirname, 'public', 'content-safety.js'));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// Production: demos off by default. Local testing: set ENABLE_DEMO_USERS=true
const ENABLE_DEMO_USERS = process.env.ENABLE_DEMO_USERS === 'true';

// Public config for the frontend (no secrets)
app.get('/api/config', (req, res) => {
  res.json({
    enableDemoUsers: ENABLE_DEMO_USERS,
    appName: 'PineappleChat',
    minAge: safety.MIN_AGE || 18
  });
});

// Load locked country/city lists (same file the browser uses)
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

// State
// onlineUsers: socketId -> { profile }  (always resolve live socket via io.sockets.sockets)
const onlineUsers = new Map();
const pairs = new Map(); // socketId -> partnerSocketId (legacy pairing ids)
const blockedUsers = new Map(); // socketId -> Set<blockedSocketIds>

function getLiveSocket(socketId) {
  if (!socketId) return null;
  const s = io.sockets.sockets.get(socketId);
  return s && s.connected ? s : null;
}

function getPartnerId(socketId) {
  return pairs.get(socketId) || null;
}

function pairUsers(socketA, socketB) {
  pairs.set(socketA.id, socketB.id);
  pairs.set(socketB.id, socketA.id);
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

// Prune offline entries, then build the public online list
function buildOnlineList() {
  for (const [id] of onlineUsers.entries()) {
    if (!getLiveSocket(id)) onlineUsers.delete(id);
  }
  const list = [];
  for (const [id, data] of onlineUsers.entries()) {
    list.push({ id, profile: data.profile });
  }
  return list;
}

function broadcastOnlineUsers() {
  io.emit('online-users', buildOnlineList());
}

function broadcastStats() {
  buildOnlineList(); // prune first
  const online = onlineUsers.size;
  let chattingPairs = 0;
  const seen = new Set();
  for (const [a, b] of pairs.entries()) {
    if (seen.has(a) || seen.has(b)) continue;
    if (onlineUsers.has(a) && onlineUsers.has(b)) {
      chattingPairs += 1;
      seen.add(a);
      seen.add(b);
    }
  }
  io.emit('stats', { online, chatting: chattingPairs });
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  // Send accurate snapshot immediately so late joiners see who is already online
  socket.emit('online-users', buildOnlineList());
  socket.emit('stats', {
    online: onlineUsers.size,
    chatting: 0
  });
  broadcastStats();

  // Client can pull a fresh list anytime (e.g. after reconnect / opening hub)
  socket.on('request-online-users', () => {
    socket.emit('online-users', buildOnlineList());
    broadcastStats();
  });

  // User sets their profile and becomes visible in the online list
  socket.on('set-profile', (profile) => {
    const cleanedProfile = profile || {
      username: 'Anonymous',
      gender: 'other',
      age: 18,
      location: 'Unknown',
      image: null,
      preference: 'anyone'
    };

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

    // Age: 18+ only (adults only platform)
    if (!safety.isValidAge(cleanedProfile.age)) {
      socket.emit('profile-error', {
        field: 'age',
        message: 'You must be 18 years or older to use PineappleChat.'
      });
      return;
    }
    cleanedProfile.age = safety.parseAge(cleanedProfile.age);

    // Must accept terms / community agreement
    if (!cleanedProfile.agreedToTerms) {
      socket.emit('profile-error', {
        field: 'terms',
        message: 'You must accept the Terms & Safety Agreement to continue.'
      });
      return;
    }
    cleanedProfile.agreedToTerms = true;
    cleanedProfile.agreedAt = new Date().toISOString();

    // Gender lock to allowed values
    if (cleanedProfile.gender !== 'male' && cleanedProfile.gender !== 'female') {
      cleanedProfile.gender = 'male';
    }

    // Username safety
    const nameCheck = safety.validateUsername(cleanedProfile.username);
    if (!nameCheck.ok) {
      socket.emit('profile-error', {
        field: 'username',
        message: nameCheck.message || 'Invalid username.'
      });
      return;
    }
    cleanedProfile.username = nameCheck.text;

    // Optional "what's on your mind" — same content rules as chat
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

    // Enforce unique usernames
    if (newUsername && newUsername !== 'anonymous') {
      for (const [id, data] of onlineUsers.entries()) {
        if (id !== socket.id && data.profile) {
          const existing = (data.profile.username || '').trim().toLowerCase();
          if (existing === newUsername) {
            socket.emit('profile-error', {
              field: 'username',
              message: 'This username is already taken. Please choose a different one.'
            });
            return; // do not add
          }
        }
      }
    }

    socket.profile = cleanedProfile;

    // Add or update in online list (profile only — live socket resolved via id)
    onlineUsers.set(socket.id, {
      profile: socket.profile
    });

    socket.emit('profile-accepted', { id: socket.id });

    // Send full list to this client first, then everyone (fixes late-join / mobile race)
    const list = buildOnlineList();
    socket.emit('online-users', list);
    io.emit('online-users', list);
    broadcastStats();
    console.log(`[profile] ${cleanedProfile.username} (${socket.id}) online=${onlineUsers.size}`);
  });

  // User explicitly chooses someone to chat with (no auto matching)
  socket.on('start-chat-with', (data) => {
    const targetId = data && data.targetId;
    if (!targetId || targetId === socket.id) return;

    if (!onlineUsers.has(socket.id) || !socket.profile) {
      socket.emit('chat-error', { message: 'Please complete your profile first.' });
      return;
    }

    const targetSocket = getLiveSocket(targetId);
    const targetData = onlineUsers.get(targetId);
    if (!targetSocket || !targetData) {
      socket.emit('chat-error', { message: 'That user is no longer online.' });
      broadcastOnlineUsers();
      return;
    }

    if (isBlocked(socket.id, targetId)) {
      socket.emit('chat-error', { message: 'You have blocked this user or they have blocked you.' });
      return;
    }

    const myProfile = socket.profile || (onlineUsers.get(socket.id) && onlineUsers.get(socket.id).profile);
    const theirProfile = targetData.profile;

    socket.emit('chat-started', { partnerId: targetId, partnerProfile: theirProfile });
    targetSocket.emit('chat-started', { partnerId: socket.id, partnerProfile: myProfile });

    broadcastStats();
  });

  socket.on('send-message-to', (data) => {
    const targetId = data && data.targetId;
    const text = data && data.text;
    if (!targetId || typeof text !== 'string') return;

    const targetSocket = getLiveSocket(targetId);
    if (!targetSocket || !onlineUsers.has(targetId)) {
      socket.emit('chat-error', { message: 'Message not delivered — that user is offline.' });
      return;
    }

    if (isBlocked(socket.id, targetId)) return;

    // Links, contact info, and dangerous / prohibited language
    const check = safety.validateChatText(text);
    if (!check.ok) {
      socket.emit('chat-error', { message: check.message || 'Message blocked by safety filters.' });
      return;
    }
    const clean = check.text;
    const payload = {
      text: clean,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      senderId: socket.id
    };

    // Deliver to recipient (fromSelf false) and confirm to sender (fromSelf true)
    targetSocket.emit('receive-message', { ...payload, fromSelf: false });
    socket.emit('receive-message', { ...payload, fromSelf: true });
  });

  socket.on('send-attachment-to', (data) => {
    const targetId = data && data.targetId;
    const attachment = data && data.attachment; // { data: base64, type: mime, name }
    if (!targetId || !attachment || !attachment.data) return;

    const targetSocket = getLiveSocket(targetId);
    if (!targetSocket || !onlineUsers.has(targetId)) {
      socket.emit('chat-error', { message: 'Attachment not delivered — that user is offline.' });
      return;
    }

    if (isBlocked(socket.id, targetId)) return;

    // Only allow image and video
    if (!attachment.type || (!attachment.type.startsWith('image/') && !attachment.type.startsWith('video/'))) {
      socket.emit('chat-error', { message: 'Only image and video files are allowed.' });
      return;
    }

    const payload = {
      attachment,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      senderId: socket.id
    };
    targetSocket.emit('receive-attachment', { ...payload, fromSelf: false });
    socket.emit('receive-attachment', { ...payload, fromSelf: true });
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

    const targetSocket = getLiveSocket(targetId);
    if (targetSocket) {
      targetSocket.emit('chat-left', { by: socket.id, partnerId: socket.id });
    }
    socket.emit('chat-left', { by: socket.id, partnerId: targetId });
  });

  socket.on('block-user', (data) => {
    const targetId = data && data.targetId;
    if (!targetId) return;

    if (!blockedUsers.has(socket.id)) {
      blockedUsers.set(socket.id, new Set());
    }
    blockedUsers.get(socket.id).add(targetId);

    const targetSocket = getLiveSocket(targetId);
    if (targetSocket) {
      targetSocket.emit('chat-left', { by: socket.id, partnerId: socket.id, blocked: true });
    }
    socket.emit('chat-left', { by: socket.id, partnerId: targetId, blocked: true });
  });

  socket.on('disconnect', (reason) => {
    console.log(`[disconnect] ${socket.id} (${reason})`);

    onlineUsers.delete(socket.id);
    blockedUsers.delete(socket.id);

    broadcastOnlineUsers();

    const partnerId = getPartnerId(socket.id);
    if (partnerId) {
      const partner = getLiveSocket(partnerId);
      if (partner) partner.emit('partner-left', { reason: 'disconnected', partnerId: socket.id });
      unpair(partnerId);
    }
    unpair(socket.id);
    broadcastStats();
  });

  // Typing indicators (to active partner id if client sends targetId)
  socket.on('typing', (data) => {
    const targetId = data && data.targetId;
    if (targetId) {
      const t = getLiveSocket(targetId);
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
      const t = getLiveSocket(targetId);
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
  console.log(`Demo users: ${ENABLE_DEMO_USERS ? 'ON (ENABLE_DEMO_USERS=true)' : 'OFF (production default)'}`);
  console.log('Open that URL in your browser to start chatting!\n');
});
