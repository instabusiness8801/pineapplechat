/**
 * Group Rooms (in-memory).
 * - Only verified (registered + logged-in) accounts can CREATE a room.
 * - Anyone with a completed 18+ profile (guest or member) can JOIN a room.
 * - The site bot is never a room member.
 * - Rooms live in memory only: a server restart / deploy clears them.
 */
const crypto = require('crypto');

const MAX_ROOMS_PER_CREATOR = 3;
const MAX_MEMBERS_PER_ROOM = 50;
const MAX_ROOMS_TOTAL = 200;
const ROOM_NAME_MIN = 3;
const ROOM_NAME_MAX = 40;
const RECENT_MESSAGES = 30;
const MSG_RATE_MAX = 20; // messages per window per socket
const MSG_RATE_WINDOW_MS = 60 * 1000;
const EMPTY_TTL_MS = Math.max(1000, Number(process.env.ROOMS_EMPTY_TTL_MS) || 10 * 60 * 1000);
const SWEEP_MS = Math.max(250, Number(process.env.ROOMS_SWEEP_MS) || 30 * 1000);

function createRooms(deps) {
  const { io, safety, features, accounts } = deps;
  /** roomId -> room */
  const rooms = new Map();
  /** socketId -> roomId (a socket is in at most one room at a time) */
  const socketRoom = new Map();
  const keySecret = crypto.randomBytes(16);

  function ioRoomName(roomId) {
    return 'room:' + roomId;
  }

  function memberKeyFor(roomId, identity) {
    return crypto.createHmac('sha256', keySecret).update(roomId + '|' + identity).digest('hex').slice(0, 16);
  }

  function nowTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function verifiedEmailOf(socket) {
    const email = deps.accountEmailOf(socket);
    if (!email) return null;
    const acc = accounts.getAccountByEmail(email);
    if (!acc || !acc.verified) return null;
    return String(acc.email).toLowerCase();
  }

  /** 18+ gate: the socket must have an accepted profile (set-profile enforces age + terms). */
  function profileOk(socket) {
    const token = deps.sessionTokenOf(socket);
    return !!(token && deps.getSessionByToken(token) && socket.profile && socket.profile.username);
  }

  function displayNameOf(socket) {
    return String((socket.profile && socket.profile.username) || 'Guest').slice(0, 24);
  }

  function canModerate(room, socket) {
    const email = verifiedEmailOf(socket);
    if (!email) return false;
    return email === room.creatorEmail || accounts.isOwner(email);
  }

  function blockedBetween(a, b) {
    if (!a || !b) return false;
    if (deps.isBlockedBetween(a.socketId, b.socketId, a.token, b.token)) return true;
    if (a.email && b.email && accounts.isBlockedAccount(a.email, b.email)) return true;
    return false;
  }

  function publicSummary(room) {
    return {
      id: room.id,
      name: room.name,
      isPublic: room.isPublic,
      memberCount: room.members.size,
      maxMembers: MAX_MEMBERS_PER_ROOM,
      creatorName: room.creatorName,
      createdAt: room.createdAt
    };
  }

  function listPublic() {
    const out = [];
    for (const room of rooms.values()) {
      if (room.isPublic) out.push(publicSummary(room));
    }
    out.sort((a, b) => b.memberCount - a.memberCount || b.createdAt - a.createdAt);
    return out;
  }

  function roomsCreatedBy(email) {
    let n = 0;
    for (const room of rooms.values()) if (room.creatorEmail === email) n += 1;
    return n;
  }

  function myRoomsFor(email) {
    if (!email) return [];
    const out = [];
    for (const room of rooms.values()) if (room.creatorEmail === email) out.push(publicSummary(room));
    return out;
  }

  function membersFor(room, viewer) {
    const seen = new Set();
    const out = [];
    for (const m of room.members.values()) {
      if (seen.has(m.key)) continue; // same session in two tabs
      if (viewer && m.socketId !== viewer.socketId && blockedBetween(viewer, m)) continue;
      seen.add(m.key);
      out.push({
        key: m.key,
        name: m.name,
        registered: !!m.email,
        isCreator: !!(m.email && m.email === room.creatorEmail),
        self: !!(viewer && m.key === viewer.key)
      });
    }
    out.sort((a, b) => (b.isCreator ? 1 : 0) - (a.isCreator ? 1 : 0) || a.name.localeCompare(b.name));
    return out;
  }

  function emitMembers(room) {
    for (const m of room.members.values()) {
      const s = deps.getLiveSocket(m.socketId);
      if (s) s.emit('room-members', { roomId: room.id, members: membersFor(room, m), count: room.members.size });
    }
  }

  let listTimer = null;
  function broadcastListChanged() {
    if (listTimer) return;
    listTimer = setTimeout(() => {
      listTimer = null;
      io.emit('rooms-changed', { rooms: listPublic() });
    }, 300);
  }

  function roomStateFor(room, socket) {
    const viewer = room.members.get(socket.id) || null;
    const recent = room.recent.filter((msg) => {
      if (!viewer) return true;
      const sender = { socketId: msg._socketId, token: msg._token, email: msg._email };
      return !blockedBetween(viewer, sender);
    }).map(publicMessage);
    return {
      id: room.id,
      name: room.name,
      isPublic: room.isPublic,
      creatorName: room.creatorName,
      isCreator: verifiedEmailOf(socket) === room.creatorEmail,
      canModerate: canModerate(room, socket),
      maxMembers: MAX_MEMBERS_PER_ROOM,
      members: membersFor(room, viewer),
      myKey: viewer ? viewer.key : null,
      recent
    };
  }

  function publicMessage(msg) {
    return {
      roomId: msg.roomId,
      msgId: msg.msgId,
      text: msg.text,
      time: msg.time,
      at: msg.at,
      from: msg.from
    };
  }

  function removeMember(room, socketId, reason) {
    const m = room.members.get(socketId);
    if (!m) return null;
    room.members.delete(socketId);
    if (socketRoom.get(socketId) === room.id) socketRoom.delete(socketId);
    const s = deps.getLiveSocket(socketId);
    if (s) s.leave(ioRoomName(room.id));
    if (room.members.size === 0) room.emptySince = Date.now();
    room.lastActiveAt = Date.now();
    emitMembers(room);
    broadcastListChanged();
    return m;
  }

  function closeRoom(room, reason) {
    if (!rooms.has(room.id)) return;
    rooms.delete(room.id);
    for (const socketId of [...room.members.keys()]) {
      if (socketRoom.get(socketId) === room.id) socketRoom.delete(socketId);
      const s = deps.getLiveSocket(socketId);
      if (s) {
        s.leave(ioRoomName(room.id));
        s.emit('room-closed', { roomId: room.id, name: room.name, reason: reason || 'closed' });
      }
    }
    room.members.clear();
    console.log(`[rooms] closed "${room.name}" (${reason || 'closed'})`);
    broadcastListChanged();
  }

  function leaveCurrent(socket, reason) {
    const roomId = socketRoom.get(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    socketRoom.delete(socket.id);
    if (room) removeMember(room, socket.id, reason);
  }

  // Auto-close rooms that stayed empty for EMPTY_TTL_MS.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      // Drop members whose sockets are gone (defensive)
      for (const socketId of [...room.members.keys()]) {
        if (!deps.getLiveSocket(socketId)) removeMember(room, socketId, 'gone');
      }
      if (room.members.size === 0 && room.emptySince && now - room.emptySince >= EMPTY_TTL_MS) {
        closeRoom(room, 'idle');
      }
    }
  }, SWEEP_MS);
  if (sweeper.unref) sweeper.unref();

  function ackFn(a, b) {
    if (typeof a === 'function') return a;
    if (typeof b === 'function') return b;
    return () => {};
  }

  function findMemberByKey(room, key) {
    const out = [];
    for (const m of room.members.values()) if (m.key === key) out.push(m);
    return out;
  }

  function attach(socket) {
    socket.on('rooms-list', (data, ack) => {
      const reply = ackFn(data, ack);
      const email = verifiedEmailOf(socket);
      reply({
        ok: true,
        rooms: listPublic(),
        myRooms: myRoomsFor(email),
        canCreate: !!email,
        currentRoomId: socketRoom.get(socket.id) || null,
        limits: {
          maxRoomsPerCreator: MAX_ROOMS_PER_CREATOR,
          maxMembers: MAX_MEMBERS_PER_ROOM,
          nameMax: ROOM_NAME_MAX
        }
      });
    });

    socket.on('room-create', (data, ack) => {
      const reply = ackFn(data, ack);
      if (deps.enforceBan && deps.enforceBan(socket)) { reply({ ok: false, code: 'banned', message: 'You are blocked from PineappleChat.' }); return; }
      const email = verifiedEmailOf(socket);
      if (!email) {
        reply({ ok: false, code: 'register-required', message: 'Register and log in to create rooms.' });
        return;
      }
      if (!profileOk(socket)) {
        reply({ ok: false, code: 'profile-required', message: 'Please finish joining (18+ profile) first.' });
        return;
      }
      const rawName = String((data && data.name) || '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if (rawName.length < ROOM_NAME_MIN || rawName.length > ROOM_NAME_MAX) {
        reply({ ok: false, code: 'name-length', message: `Room name must be ${ROOM_NAME_MIN}–${ROOM_NAME_MAX} characters.` });
        return;
      }
      const check = safety.validateChatText(rawName);
      if (!check.ok) {
        reply({ ok: false, code: 'name-blocked', message: 'That room name is not allowed (no links, contact details or unsafe words).' });
        return;
      }
      if (String(check.text).toLowerCase().includes('pineapplechat bot')) {
        reply({ ok: false, code: 'name-blocked', message: 'That room name is reserved.' });
        return;
      }
      if (roomsCreatedBy(email) >= MAX_ROOMS_PER_CREATOR) {
        reply({ ok: false, code: 'room-limit', message: `You can have up to ${MAX_ROOMS_PER_CREATOR} open rooms. Close one first.` });
        return;
      }
      if (rooms.size >= MAX_ROOMS_TOTAL) {
        reply({ ok: false, code: 'site-limit', message: 'Too many rooms are open right now. Please try again later.' });
        return;
      }
      // Count only otherwise-valid creations toward the anti-spam limit.
      const rl = features.rateLimit('room-create:' + email, 10, 10 * 60 * 1000);
      if (!rl.ok) { reply(rl); return; }
      let id;
      do { id = crypto.randomBytes(5).toString('hex'); } while (rooms.has(id));
      const room = {
        id,
        name: check.text,
        isPublic: !(data && data.isPublic === false),
        creatorEmail: email,
        creatorName: displayNameOf(socket),
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
        emptySince: Date.now(),
        members: new Map(),
        kicked: new Set(),
        recent: []
      };
      rooms.set(id, room);
      console.log(`[rooms] created "${room.name}" by ${room.creatorName}`);
      const joined = joinRoom(socket, room);
      if (!joined.ok) { reply(joined); return; }
      reply({ ok: true, room: roomStateFor(room, socket) });
    });

    function joinRoom(socket, room) {
      if (!profileOk(socket)) {
        return { ok: false, code: 'profile-required', message: 'Please finish joining (18+ profile) first.' };
      }
      const token = deps.sessionTokenOf(socket);
      const email = verifiedEmailOf(socket);
      if (room.kicked.has('t:' + token) || (email && room.kicked.has('e:' + email))) {
        return { ok: false, code: 'kicked', message: 'You were removed from this room.' };
      }
      if (room.members.has(socket.id)) return { ok: true, already: true };
      if (room.members.size >= MAX_MEMBERS_PER_ROOM) {
        return { ok: false, code: 'room-full', message: 'This room is full.' };
      }
      leaveCurrent(socket, 'switched');
      const identity = email ? 'e:' + email : 't:' + token;
      const member = {
        socketId: socket.id,
        token,
        email,
        name: displayNameOf(socket),
        key: memberKeyFor(room.id, identity),
        joinedAt: Date.now()
      };
      room.members.set(socket.id, member);
      room.emptySince = null;
      room.lastActiveAt = Date.now();
      socketRoom.set(socket.id, room.id);
      socket.join(ioRoomName(room.id));
      emitMembers(room);
      broadcastListChanged();
      return { ok: true };
    }

    socket.on('room-join', (data, ack) => {
      const reply = ackFn(data, ack);
      if (deps.enforceBan && deps.enforceBan(socket)) { reply({ ok: false, code: 'banned', message: 'You are blocked from PineappleChat.' }); return; }
      const room = rooms.get(String((data && data.roomId) || ''));
      if (!room) { reply({ ok: false, code: 'not-found', message: 'Room not found or already closed.' }); return; }
      const rl = features.rateLimit('room-join:' + socket.id, 30, 60 * 1000);
      if (!rl.ok) { reply(rl); return; }
      const res = joinRoom(socket, room);
      if (!res.ok) { reply(res); return; }
      reply({ ok: true, room: roomStateFor(room, socket) });
    });

    socket.on('room-leave', (data, ack) => {
      const reply = ackFn(data, ack);
      const roomId = String((data && data.roomId) || socketRoom.get(socket.id) || '');
      const room = rooms.get(roomId);
      if (room) removeMember(room, socket.id, 'left');
      reply({ ok: true });
    });

    socket.on('room-send', (data, ack) => {
      const reply = ackFn(data, ack);
      const room = rooms.get(String((data && data.roomId) || ''));
      const me = room && room.members.get(socket.id);
      if (!room || !me) { reply({ ok: false, code: 'not-member', message: 'Join the room first.' }); return; }
      if (typeof (data && data.text) !== 'string') { reply({ ok: false, message: 'Message cannot be empty.' }); return; }
      const rl = features.rateLimit('room-msg:' + socket.id, MSG_RATE_MAX, MSG_RATE_WINDOW_MS);
      if (!rl.ok) { reply({ ok: false, code: 'rate-limit', message: 'Slow down — too many messages. Wait a moment.' }); return; }
      const check = safety.validateChatText(data.text);
      if (!check.ok) { reply({ ok: false, code: 'filtered', message: check.message || 'Message blocked by safety filters.' }); return; }
      const clientId = data.msgId != null ? String(data.msgId) : '';
      const msgId = /^[a-zA-Z0-9_-]{8,40}$/.test(clientId) ? clientId : crypto.randomBytes(8).toString('hex');
      me.name = displayNameOf(socket);
      const msg = {
        roomId: room.id,
        msgId,
        text: check.text,
        time: nowTime(),
        at: Date.now(),
        from: { key: me.key, name: me.name, registered: !!me.email, isCreator: !!(me.email && me.email === room.creatorEmail) },
        _socketId: socket.id,
        _token: me.token,
        _email: me.email
      };
      room.recent.push(msg);
      while (room.recent.length > RECENT_MESSAGES) room.recent.shift();
      room.lastActiveAt = Date.now();
      const out = publicMessage(msg);
      for (const m of room.members.values()) {
        if (m.socketId === socket.id) continue;
        if (blockedBetween(me, m)) continue; // blocked users never see each other's messages
        const s = deps.getLiveSocket(m.socketId);
        if (s) s.emit('room-message', out);
      }
      reply({ ok: true, message: out });
    });

    socket.on('room-kick', (data, ack) => {
      const reply = ackFn(data, ack);
      const room = rooms.get(String((data && data.roomId) || ''));
      if (!room) { reply({ ok: false, code: 'not-found', message: 'Room not found.' }); return; }
      if (!canModerate(room, socket)) { reply({ ok: false, code: 'forbidden', message: 'Only the room creator can remove people.' }); return; }
      const key = String((data && data.memberKey) || '');
      const targets = findMemberByKey(room, key);
      if (!targets.length) { reply({ ok: false, code: 'not-member', message: 'That person is not in the room.' }); return; }
      const me = room.members.get(socket.id);
      if (me && me.key === key) { reply({ ok: false, message: 'You cannot remove yourself — use Leave.' }); return; }
      if (targets.some((t) => t.email && t.email === room.creatorEmail)) {
        reply({ ok: false, message: 'The room creator cannot be removed.' });
        return;
      }
      for (const t of targets) {
        if (t.token) room.kicked.add('t:' + t.token);
        if (t.email) room.kicked.add('e:' + t.email);
        const s = deps.getLiveSocket(t.socketId);
        removeMember(room, t.socketId, 'kicked');
        if (s) s.emit('room-kicked', { roomId: room.id, name: room.name });
      }
      reply({ ok: true });
    });

    socket.on('room-close', (data, ack) => {
      const reply = ackFn(data, ack);
      const room = rooms.get(String((data && data.roomId) || ''));
      if (!room) { reply({ ok: false, code: 'not-found', message: 'Room not found.' }); return; }
      if (!canModerate(room, socket)) { reply({ ok: false, code: 'forbidden', message: 'Only the room creator can close this room.' }); return; }
      closeRoom(room, 'closed-by-creator');
      reply({ ok: true });
    });

    socket.on('room-report', (data, ack) => {
      const reply = ackFn(data, ack);
      const room = rooms.get(String((data && data.roomId) || ''));
      if (!room || !room.members.get(socket.id)) { reply({ ok: false, message: 'Join the room first.' }); return; }
      const rl = features.rateLimit('report:' + socket.id, 10, 60 * 60 * 1000); // same limit as report-user
      if (!rl.ok) { reply(rl); return; }
      const key = String((data && data.memberKey) || '');
      const target = findMemberByKey(room, key)[0] || null;
      let msg = null;
      if (data && data.msgId) msg = room.recent.find((x) => x.msgId === String(data.msgId)) || null;
      const tSocketId = target ? target.socketId : (msg ? msg._socketId : null);
      const tToken = target ? target.token : (msg ? msg._token : null);
      const tName = target ? target.name : (msg ? msg.from.name : null);
      if (!tSocketId && !tToken) { reply({ ok: false, message: 'That person already left the room.' }); return; }
      const extra = String((data && data.details) || '').slice(0, 300);
      const details = `[Room "${room.name}" ${room.id}]` + (msg ? ` msg: "${String(msg.text).slice(0, 120)}"` : '') + (extra ? ' — ' + extra : '');
      const result = features.addReport({
        reporterId: socket.id,
        reporterToken: deps.sessionTokenOf(socket),
        reporterName: socket.profile && socket.profile.username,
        targetId: tSocketId,
        targetToken: tToken,
        targetName: tName,
        reason: data && data.reason,
        details
      });
      reply(result);
    });

    socket.on('room-block', (data, ack) => {
      const reply = ackFn(data, ack);
      const room = rooms.get(String((data && data.roomId) || ''));
      const me = room && room.members.get(socket.id);
      if (!room || !me) { reply({ ok: false, message: 'Join the room first.' }); return; }
      const target = findMemberByKey(room, String((data && data.memberKey) || ''))[0];
      if (!target) { reply({ ok: false, message: 'That person is not in the room.' }); return; }
      if (target.key === me.key) { reply({ ok: false, message: 'You cannot block yourself.' }); return; }
      deps.blockUser(socket, { targetId: target.socketId, targetSessionToken: target.token });
      emitMembers(room);
      reply({ ok: true, message: 'Blocked. You will not see each other in rooms or People.' });
    });
  }

  function handleDisconnect(socket) {
    leaveCurrent(socket, 'disconnect');
  }

  function stats() {
    let members = 0;
    for (const r of rooms.values()) members += r.members.size;
    return { rooms: rooms.size, members };
  }

  return {
    attach,
    handleDisconnect,
    leaveCurrent,
    listPublic,
    stats,
    limits: { MAX_ROOMS_PER_CREATOR, MAX_MEMBERS_PER_ROOM, ROOM_NAME_MAX, EMPTY_TTL_MS }
  };
}

module.exports = { createRooms };
