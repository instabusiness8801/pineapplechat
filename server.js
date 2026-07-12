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
const onlineUsers = new Map(); // socketId -> { profile, socket }
const pairs = new Map(); // legacy, kept for backward but not used for exclusive
const blockedUsers = new Map(); // socketId -> Set<blockedSocketIds>

function getPartner(socketId) {
  return pairs.get(socketId) || null;
}

function pairUsers(socketA, socketB) {
  pairs.set(socketA.id, socketB);
  pairs.set(socketB.id, socketA);
}

function unpair(socketId) {
  const partner = pairs.get(socketId);
  if (partner) {
    pairs.delete(partner.id);
  }
  pairs.delete(socketId);
}

function isBlocked(userA, userB) {
  const blockedByA = blockedUsers.get(userA);
  if (blockedByA && blockedByA.has(userB)) return true;
  const blockedByB = blockedUsers.get(userB);
  if (blockedByB && blockedByB.has(userA)) return true;
  return false;
}

// Broadcast current online users (excluding sensitive data)
function broadcastOnlineUsers() {
  const list = [];
  for (const [id, data] of onlineUsers.entries()) {
    if (data.socket && data.socket.connected) {
      list.push({
        id: id,
        profile: data.profile
      });
    }
  }
  // Send to all connected clients
  io.emit('online-users', list);
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  function broadcastStats() {
    // Count only users who completed profile (not bare page connections / extra tabs)
    const online = onlineUsers.size;
    const inChat = pairs.size / 2;
    io.emit('stats', { online, chatting: Math.floor(inChat) });
  }

  // Send accurate counts immediately (usually 0 until someone logs in)
  broadcastStats();
  // Also push current online list so clients don't show stale demos
  broadcastOnlineUsers();

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

    // Add or update in online list
    onlineUsers.set(socket.id, {
      profile: socket.profile,
      socket: socket
    });

    socket.emit('profile-accepted');

    // Broadcast updated list to everyone
    broadcastOnlineUsers();
    broadcastStats();
  });

  // User explicitly chooses someone to chat with (no auto matching)
  socket.on('start-chat-with', (data) => {
    const targetId = data && data.targetId;
    if (!targetId || targetId === socket.id) return;

    const targetData = onlineUsers.get(targetId);
    if (!targetData || !targetData.socket || !targetData.socket.connected) {
      socket.emit('chat-error', { message: 'That user is no longer online.' });
      return;
    }

    const targetSocket = targetData.socket;

    if (isBlocked(socket.id, targetId)) {
      socket.emit('chat-error', { message: 'You have blocked this user or they have blocked you.' });
      return;
    }

    // Support multiple simultaneous chats - do NOT unpair previous chats
    // Notify both sides to open/switch to this specific chat
    const myProfile = socket.profile;
    const theirProfile = targetSocket.profile;

    socket.emit('chat-started', { partnerId: targetId, partnerProfile: theirProfile });
    targetSocket.emit('chat-started', { partnerId: socket.id, partnerProfile: myProfile });

    broadcastStats();
  });

  socket.on('send-message-to', (data) => {
    const targetId = data && data.targetId;
    const text = data && data.text;
    if (!targetId || typeof text !== 'string') return;

    const targetData = onlineUsers.get(targetId);
    const targetSocket = targetData && targetData.socket;
    if (!targetSocket) return;

    if (isBlocked(socket.id, targetId)) return;

    // Links, contact info, and dangerous / prohibited language
    const check = safety.validateChatText(text);
    if (!check.ok) {
      socket.emit('chat-error', { message: check.message || 'Message blocked by safety filters.' });
      return;
    }
    const clean = check.text;

    // Include senderId so client can route message to the correct chat
    targetSocket.emit('receive-message', {
      text: clean,
      fromSelf: false,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      senderId: socket.id
    });

    socket.emit('receive-message', {
      text: clean,
      fromSelf: true,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      senderId: socket.id
    });
  });

  socket.on('send-attachment-to', (data) => {
    const targetId = data && data.targetId;
    const attachment = data && data.attachment; // { data: base64, type: mime, name }
    if (!targetId || !attachment || !attachment.data) return;

    const targetData = onlineUsers.get(targetId);
    const targetSocket = targetData && targetData.socket;
    if (!targetSocket) return;

    if (isBlocked(socket.id, targetId)) return;

    // Only allow image and video
    if (!attachment.type || (!attachment.type.startsWith('image/') && !attachment.type.startsWith('video/'))) {
      socket.emit('chat-error', { message: 'Only image and video files are allowed.' });
      return;
    }

    targetSocket.emit('receive-attachment', {
      attachment,
      fromSelf: false,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      senderId: socket.id
    });

    socket.emit('receive-attachment', {
      attachment,
      fromSelf: true,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      senderId: socket.id
    });
  });

  socket.on('next-stranger', () => {
    // Legacy - for multi-chat we use specific leave
    socket.emit('back-to-browse');
    broadcastStats();
  });

  socket.on('end-chat', () => {
    // Legacy single end
    socket.emit('chat-ended');
    broadcastStats();
  });

  socket.on('leave-chat', (data) => {
    const targetId = data && data.targetId;
    if (!targetId) return;

    const targetData = onlineUsers.get(targetId);
    const targetSocket = targetData && targetData.socket;
    if (targetSocket) {
      targetSocket.emit('chat-left', { by: socket.id, partnerId: socket.id });
    }
    // Notify self too
    socket.emit('chat-left', { by: socket.id, partnerId: targetId });
  });

  socket.on('block-user', (data) => {
    const targetId = data && data.targetId;
    if (!targetId) return;

    if (!blockedUsers.has(socket.id)) {
      blockedUsers.set(socket.id, new Set());
    }
    blockedUsers.get(socket.id).add(targetId);

    // Also leave the chat
    const targetData = onlineUsers.get(targetId);
    if (targetData && targetData.socket) {
      targetData.socket.emit('chat-left', { by: socket.id, partnerId: socket.id, blocked: true });
    }
    socket.emit('chat-left', { by: socket.id, partnerId: targetId, blocked: true });
  });

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);

    // Remove from online list
    onlineUsers.delete(socket.id);

    // Notify others
    broadcastOnlineUsers();

    const partner = getPartner(socket.id);
    if (partner && partner.connected) {
      partner.emit('partner-left', { reason: 'disconnected' });
      unpair(partner.id);
    }
    unpair(socket.id);
    broadcastStats();
  });

  // Typing indicators
  socket.on('typing', () => {
    const partner = getPartner(socket.id);
    if (partner) partner.emit('typing');
  });

  socket.on('stop-typing', () => {
    const partner = getPartner(socket.id);
    if (partner) partner.emit('stop-typing');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\nPineappleChat running on http://localhost:${PORT}`);
  console.log(`Demo users: ${ENABLE_DEMO_USERS ? 'ON (ENABLE_DEMO_USERS=true)' : 'OFF (production default)'}`);
  console.log('Open that URL in your browser to start chatting!\n');
});
