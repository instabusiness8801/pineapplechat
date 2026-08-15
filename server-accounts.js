/**
 * Email accounts, friend requests, presence, and owner/admin for PineappleChat.
 * A real account is created only after the email verification code is confirmed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mail = require(path.join(__dirname, 'server-mail.js'));

const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const PENDING_FILE = path.join(DATA_DIR, 'pending.json');
const TOKENS_FILE = path.join(DATA_DIR, 'auth-tokens.json');

const AUTH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 15 * 60 * 1000;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OWNER = 'instabusiness8801@gmail.com';

/** email(lower) -> account */
const accounts = new Map();
/** email -> pending registration */
const pendingSignups = new Map();
/** sessionToken -> email */
const sessionAccount = new Map();
/** authToken -> { email, expiresAt } */
const authTokens = new Map();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function ownerEmail() {
  return String(process.env.OWNER_EMAIL || DEFAULT_OWNER)
    .trim()
    .toLowerCase();
}

function isOwner(email) {
  return !!email && String(email).trim().toLowerCase() === ownerEmail();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function newAuthToken() {
  return crypto.randomBytes(24).toString('hex');
}

function isActive(acc) {
  return !!(acc && acc.verified);
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch (e) {
    console.warn('[accounts] load', path.basename(file), e.message);
    return fallback;
  }
}

function normalizeAccount(email, acc) {
  return {
    email: email.toLowerCase(),
    passwordHash: acc.passwordHash,
    salt: acc.salt,
    verified: !!acc.verified,
    friends: Array.isArray(acc.friends) ? acc.friends.map((e) => String(e).toLowerCase()) : [],
    incomingRequests: Array.isArray(acc.incomingRequests)
      ? acc.incomingRequests.map((e) => String(e).toLowerCase())
      : [],
    outgoingRequests: Array.isArray(acc.outgoingRequests)
      ? acc.outgoingRequests.map((e) => String(e).toLowerCase())
      : [],
    blocked: Array.isArray(acc.blocked) ? acc.blocked.map((e) => String(e).toLowerCase()) : [],
    displayName: acc.displayName || null,
    createdAt: acc.createdAt || Date.now(),
    lastLoginAt: acc.lastLoginAt || null,
    lastSeenAt: acc.lastSeenAt || acc.lastLoginAt || null
  };
}

function loadAccounts() {
  try {
    ensureDataDir();
    const raw = loadJson(ACCOUNTS_FILE, {});
    for (const [email, acc] of Object.entries(raw)) {
      if (!acc || !acc.passwordHash) continue;
      accounts.set(email.toLowerCase(), normalizeAccount(email, acc));
    }
    const pend = loadJson(PENDING_FILE, {});
    for (const [email, p] of Object.entries(pend)) {
      if (!p || !p.passwordHash) continue;
      pendingSignups.set(email.toLowerCase(), p);
    }
    const toks = loadJson(TOKENS_FILE, {});
    const now = Date.now();
    for (const [token, info] of Object.entries(toks)) {
      if (info && info.email && info.expiresAt > now) {
        authTokens.set(token, { email: String(info.email).toLowerCase(), expiresAt: info.expiresAt });
      }
    }
    console.log(`[accounts] loaded ${accounts.size} account(s), ${pendingSignups.size} pending`);
  } catch (e) {
    console.warn('[accounts] load failed:', e.message);
  }
}

function saveAccounts() {
  try {
    ensureDataDir();
    const obj = {};
    for (const [email, acc] of accounts.entries()) {
      obj[email] = {
        email: acc.email,
        passwordHash: acc.passwordHash,
        salt: acc.salt,
        verified: acc.verified,
        friends: acc.friends || [],
        incomingRequests: acc.incomingRequests || [],
        outgoingRequests: acc.outgoingRequests || [],
        blocked: acc.blocked || [],
        displayName: acc.displayName || null,
        createdAt: acc.createdAt,
        lastLoginAt: acc.lastLoginAt || null,
        lastSeenAt: acc.lastSeenAt || null
      };
    }
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.warn('[accounts] save failed:', e.message);
  }
}

function savePending() {
  try {
    ensureDataDir();
    const obj = {};
    const now = Date.now();
    for (const [email, p] of pendingSignups.entries()) {
      if (p.createdAt && now - p.createdAt > PENDING_TTL_MS) {
        pendingSignups.delete(email);
        continue;
      }
      obj[email] = p;
    }
    fs.writeFileSync(PENDING_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.warn('[accounts] pending save failed:', e.message);
  }
}

function saveTokens() {
  try {
    ensureDataDir();
    const obj = {};
    const now = Date.now();
    for (const [token, info] of authTokens.entries()) {
      if (!info || info.expiresAt <= now) {
        authTokens.delete(token);
        continue;
      }
      obj[token] = info;
    }
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.warn('[accounts] token save failed:', e.message);
  }
}

function displayNameOf(acc) {
  if (!acc) return null;
  if (acc.displayName && String(acc.displayName).trim()) return String(acc.displayName).trim().slice(0, 40);
  return acc.email.split('@')[0];
}

function publicAccount(acc) {
  if (!acc) return null;
  return {
    email: acc.email,
    verified: !!acc.verified,
    friends: (acc.friends || []).slice(),
    incomingRequests: (acc.incomingRequests || []).slice(),
    outgoingRequests: (acc.outgoingRequests || []).slice(),
    blocked: (acc.blocked || []).slice(),
    displayName: displayNameOf(acc),
    lastLoginAt: acc.lastLoginAt || null,
    lastSeenAt: acc.lastSeenAt || null,
    isOwner: isOwner(acc.email)
  };
}

function createAuthToken(email) {
  const token = newAuthToken();
  authTokens.set(token, { email: email.toLowerCase(), expiresAt: Date.now() + AUTH_TTL_MS });
  saveTokens();
  return token;
}

function revokeAuthToken(token) {
  if (token && authTokens.delete(String(token))) saveTokens();
}

function revokeAuthTokensForEmail(email) {
  email = String(email || '').toLowerCase();
  for (const [tok, info] of authTokens.entries()) {
    if (info.email === email) authTokens.delete(tok);
  }
  saveTokens();
}

function restoreAuth(token) {
  if (!token) return { ok: false, message: 'Not signed in.' };
  const info = authTokens.get(String(token));
  if (!info || info.expiresAt <= Date.now()) {
    if (info) {
      authTokens.delete(String(token));
      saveTokens();
    }
    return { ok: false, message: 'Session expired. Please log in again.' };
  }
  const acc = accounts.get(info.email);
  if (!isActive(acc)) return { ok: false, message: 'Account not found.' };
  return { ok: true, account: publicAccount(acc), authToken: token };
}

async function issueCode(email) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  return { code, expiresAt: Date.now() + CODE_TTL_MS };
}

async function deliverCode(email, code) {
  const send = await mail.sendVerificationEmail(email, code);
  if (send.sent) {
    return {
      ok: true,
      sent: true,
      message: 'Verification code sent to your email. Enter the 6-digit code to confirm your account.'
    };
  }
  if (mail.allowDevCodes()) {
    console.log(`[accounts] DEV code for ${email}: ${code}`);
    return {
      ok: true,
      sent: false,
      devMode: true,
      devCode: code,
      message: 'Email is not configured. Dev mode is on — use the demo code shown.'
    };
  }
  return {
    ok: false,
    sent: false,
    message:
      'Could not send the verification email. The site owner needs to set RESEND_API_KEY (or SMTP) on the server.',
    error: send.error
  };
}

async function register(email, password) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  if (!isValidEmail(email)) {
    return { ok: false, message: 'Please enter a valid email address.' };
  }
  if (password.length < 6) {
    return { ok: false, message: 'Password must be at least 6 characters.' };
  }
  const existing = accounts.get(email);
  if (existing && existing.verified) {
    return { ok: false, message: 'This email is already registered. Please log in.' };
  }

  const issued = await issueCode(email);
  const delivered = await deliverCode(email, issued.code);
  if (!delivered.ok) return delivered;

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  pendingSignups.set(email, {
    email,
    passwordHash,
    salt,
    code: issued.code,
    expiresAt: issued.expiresAt,
    createdAt: Date.now(),
    // If they already had an unverified leftover account, keep friends
    friends: existing && existing.friends ? existing.friends : []
  });
  savePending();

  return {
    ok: true,
    message: delivered.message,
    devCode: delivered.devCode,
    emailConfigured: mail.emailConfigured(),
    needsVerification: true
  };
}

function verify(email, code) {
  email = String(email || '').trim().toLowerCase();
  code = String(code || '').trim();
  const pending = pendingSignups.get(email);
  if (!pending) {
    return { ok: false, message: 'No pending registration for this email. Register first.' };
  }
  if (!pending.expiresAt || pending.expiresAt < Date.now()) {
    return { ok: false, message: 'Code expired. Please register again to get a new code.' };
  }
  if (String(pending.code) !== code) {
    return { ok: false, message: 'Invalid verification code.' };
  }

  const leftover = accounts.get(email);
  const now = Date.now();
  const acc = {
    email,
    passwordHash: pending.passwordHash,
    salt: pending.salt,
    verified: true,
    friends: leftover && leftover.friends ? leftover.friends : pending.friends || [],
    incomingRequests: leftover && leftover.incomingRequests ? leftover.incomingRequests : [],
    outgoingRequests: leftover && leftover.outgoingRequests ? leftover.outgoingRequests : [],
    blocked: leftover && leftover.blocked ? leftover.blocked : [],
    displayName: leftover && leftover.displayName ? leftover.displayName : email.split('@')[0],
    createdAt: leftover && leftover.createdAt ? leftover.createdAt : now,
    lastLoginAt: now,
    lastSeenAt: now
  };
  accounts.set(email, acc);
  pendingSignups.delete(email);
  saveAccounts();
  savePending();
  const authToken = createAuthToken(email);
  return {
    ok: true,
    message: 'Email verified. Your account is ready.',
    account: publicAccount(acc),
    authToken
  };
}

async function login(email, password) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  const acc = accounts.get(email);
  const pending = pendingSignups.get(email);

  if (pending && (!acc || !acc.verified)) {
    const hash = hashPassword(password, pending.salt);
    if (hash !== pending.passwordHash) {
      return { ok: false, message: 'Incorrect password.' };
    }
    const issued = await issueCode(email);
    pending.code = issued.code;
    pending.expiresAt = issued.expiresAt;
    savePending();
    const delivered = await deliverCode(email, issued.code);
    return {
      ok: false,
      needsVerification: true,
      message: 'Please verify your email first. ' + delivered.message,
      devCode: delivered.devCode
    };
  }

  if (!acc) return { ok: false, message: 'Account not found. Please register first.' };
  const hash = hashPassword(password, acc.salt);
  if (hash !== acc.passwordHash) {
    return { ok: false, message: 'Incorrect password.' };
  }
  if (!acc.verified) {
    const issued = await issueCode(email);
    pendingSignups.set(email, {
      email,
      passwordHash: acc.passwordHash,
      salt: acc.salt,
      code: issued.code,
      expiresAt: issued.expiresAt,
      createdAt: Date.now(),
      friends: acc.friends || []
    });
    savePending();
    const delivered = await deliverCode(email, issued.code);
    return {
      ok: false,
      needsVerification: true,
      message: 'Please verify your email first. ' + delivered.message,
      devCode: delivered.devCode
    };
  }

  acc.lastLoginAt = Date.now();
  acc.lastSeenAt = acc.lastLoginAt;
  saveAccounts();
  const authToken = createAuthToken(email);
  return { ok: true, message: 'Logged in.', account: publicAccount(acc), authToken };
}

async function resendCode(email) {
  email = String(email || '').trim().toLowerCase();
  const pending = pendingSignups.get(email);
  const acc = accounts.get(email);
  if (acc && acc.verified) return { ok: false, message: 'Email already verified. You can log in.' };
  if (!pending && !acc) return { ok: false, message: 'No account for this email. Register first.' };

  const target = pending || {
    email,
    passwordHash: acc.passwordHash,
    salt: acc.salt,
    friends: acc.friends || [],
    createdAt: Date.now()
  };
  const issued = await issueCode(email);
  target.code = issued.code;
  target.expiresAt = issued.expiresAt;
  pendingSignups.set(email, target);
  savePending();
  const delivered = await deliverCode(email, issued.code);
  if (!delivered.ok) return delivered;
  return { ok: true, message: delivered.message, devCode: delivered.devCode };
}

function bindSession(sessionToken, email) {
  if (!sessionToken || !email) return;
  sessionAccount.set(sessionToken, email.toLowerCase());
}

function unbindSession(sessionToken) {
  if (sessionToken) sessionAccount.delete(sessionToken);
}

function getEmailForSession(sessionToken) {
  return sessionToken ? sessionAccount.get(sessionToken) || null : null;
}

function getAccountForSession(sessionToken) {
  const email = getEmailForSession(sessionToken);
  return email ? accounts.get(email) || null : null;
}

function getAccountByEmail(email) {
  if (!email) return null;
  return accounts.get(String(email).trim().toLowerCase()) || null;
}

function findSessionTokenForEmail(email) {
  email = String(email || '').toLowerCase();
  for (const [token, em] of sessionAccount.entries()) {
    if (em === email) return token;
  }
  return null;
}

function findAllSessionTokensForEmail(email) {
  email = String(email || '').toLowerCase();
  const out = [];
  for (const [token, em] of sessionAccount.entries()) {
    if (em === email) out.push(token);
  }
  return out;
}

function touchLastSeen(email) {
  const acc = getAccountByEmail(email);
  if (!acc) return;
  acc.lastSeenAt = Date.now();
  saveAccounts();
}

function touchLastLogin(email) {
  const acc = getAccountByEmail(email);
  if (!acc) return;
  acc.lastLoginAt = Date.now();
  acc.lastSeenAt = acc.lastLoginAt;
  saveAccounts();
}

function setDisplayName(email, name) {
  const acc = getAccountByEmail(email);
  if (!acc) return;
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) return;
  if (acc.displayName !== clean) {
    acc.displayName = clean;
    saveAccounts();
  }
}

function uniquePush(arr, value) {
  if (!arr.includes(value)) arr.push(value);
}

function stripFrom(arr, value) {
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1);
}

function resolveTargetEmail(targetEmailOrToken, resolveFn) {
  if (typeof resolveFn === 'function') {
    const resolved = resolveFn(targetEmailOrToken);
    if (resolved) return String(resolved).trim().toLowerCase();
  }
  if (isValidEmail(targetEmailOrToken)) {
    return String(targetEmailOrToken).trim().toLowerCase();
  }
  return null;
}

function sendFriendRequest(requesterToken, targetEmailOrToken, resolveFn) {
  const reqEmail = getEmailForSession(requesterToken);
  if (!reqEmail) {
    return { ok: false, message: 'Register and verify your email before adding friends.' };
  }
  const reqAcc = accounts.get(reqEmail);
  if (!isActive(reqAcc)) {
    return { ok: false, message: 'Verify your email before adding friends.' };
  }

  const targetEmail = resolveTargetEmail(targetEmailOrToken, resolveFn);
  if (!targetEmail) {
    return {
      ok: false,
      message: 'That person has not linked a verified email account yet. They need to register first.'
    };
  }
  if (targetEmail === reqEmail) {
    return { ok: false, message: 'You cannot add yourself as a friend.' };
  }
  const targetAcc = accounts.get(targetEmail);
  if (!isActive(targetAcc)) {
    return { ok: false, message: 'That email is not registered/verified on PineappleChat.' };
  }
  if ((reqAcc.blocked || []).includes(targetEmail) || (targetAcc.blocked || []).includes(reqEmail)) {
    return { ok: false, message: 'You cannot send a friend request to this user.' };
  }

  reqAcc.friends = reqAcc.friends || [];
  targetAcc.friends = targetAcc.friends || [];
  reqAcc.incomingRequests = reqAcc.incomingRequests || [];
  reqAcc.outgoingRequests = reqAcc.outgoingRequests || [];
  targetAcc.incomingRequests = targetAcc.incomingRequests || [];
  targetAcc.outgoingRequests = targetAcc.outgoingRequests || [];

  if (reqAcc.friends.includes(targetEmail)) {
    return { ok: true, alreadyFriends: true, message: 'Already friends.', account: publicAccount(reqAcc), targetEmail };
  }
  // They already requested us — accept
  if (reqAcc.incomingRequests.includes(targetEmail)) {
    return acceptFriendRequest(requesterToken, targetEmail);
  }
  if (reqAcc.outgoingRequests.includes(targetEmail)) {
    return { ok: true, pending: true, message: 'Friend request already sent.', account: publicAccount(reqAcc), targetEmail };
  }

  uniquePush(reqAcc.outgoingRequests, targetEmail);
  uniquePush(targetAcc.incomingRequests, reqEmail);
  saveAccounts();
  return {
    ok: true,
    pending: true,
    message: `Friend request sent to ${displayNameOf(targetAcc)}.`,
    account: publicAccount(reqAcc),
    targetEmail
  };
}

function acceptFriendRequest(sessionToken, fromEmail) {
  const me = getEmailForSession(sessionToken);
  if (!me) return { ok: false, message: 'Please log in first.' };
  const acc = accounts.get(me);
  const otherEmail = String(fromEmail || '').trim().toLowerCase();
  const other = accounts.get(otherEmail);
  if (!isActive(acc) || !isActive(other)) {
    return { ok: false, message: 'Account not found.' };
  }
  acc.incomingRequests = acc.incomingRequests || [];
  acc.outgoingRequests = acc.outgoingRequests || [];
  other.incomingRequests = other.incomingRequests || [];
  other.outgoingRequests = other.outgoingRequests || [];
  acc.friends = acc.friends || [];
  other.friends = other.friends || [];

  if (!acc.incomingRequests.includes(otherEmail) && !acc.outgoingRequests.includes(otherEmail)) {
    // Allow accept if they sent us one; otherwise still friend if owner
    if (!isOwner(me)) {
      return { ok: false, message: 'No friend request from that user.' };
    }
  }

  uniquePush(acc.friends, otherEmail);
  uniquePush(other.friends, me);
  stripFrom(acc.incomingRequests, otherEmail);
  stripFrom(acc.outgoingRequests, otherEmail);
  stripFrom(other.incomingRequests, me);
  stripFrom(other.outgoingRequests, me);
  saveAccounts();
  return {
    ok: true,
    message: `You are now friends with ${displayNameOf(other)}.`,
    account: publicAccount(acc),
    targetEmail: otherEmail
  };
}

function declineFriendRequest(sessionToken, fromEmail) {
  const me = getEmailForSession(sessionToken);
  if (!me) return { ok: false, message: 'Please log in first.' };
  const acc = accounts.get(me);
  const otherEmail = String(fromEmail || '').trim().toLowerCase();
  const other = accounts.get(otherEmail);
  if (!acc) return { ok: false, message: 'Not logged in.' };
  stripFrom(acc.incomingRequests || [], otherEmail);
  stripFrom(acc.outgoingRequests || [], otherEmail);
  if (other) {
    stripFrom(other.incomingRequests || [], me);
    stripFrom(other.outgoingRequests || [], me);
  }
  saveAccounts();
  return { ok: true, message: 'Request updated.', account: publicAccount(acc) };
}

function removeFriend(sessionToken, friendEmail) {
  const me = getEmailForSession(sessionToken);
  if (!me) return { ok: false, message: 'Please log in first.' };
  const acc = accounts.get(me);
  const otherEmail = String(friendEmail || '').trim().toLowerCase();
  const other = accounts.get(otherEmail);
  if (!acc) return { ok: false, message: 'Not logged in.' };
  stripFrom(acc.friends || [], otherEmail);
  if (other) stripFrom(other.friends || [], me);
  saveAccounts();
  return { ok: true, message: 'Friend removed.', account: publicAccount(acc) };
}

function addFriend(requesterToken, targetEmailOrToken, resolveTargetEmailFn) {
  return sendFriendRequest(requesterToken, targetEmailOrToken, resolveTargetEmailFn);
}

function listFriends(sessionToken) {
  const acc = getAccountForSession(sessionToken);
  if (!isActive(acc)) return { ok: false, friends: [], message: 'Not logged in with a verified email.' };
  return { ok: true, friends: (acc.friends || []).slice(), email: acc.email };
}

function presencePayload(email, isEmailOnline) {
  const acc = getAccountByEmail(email);
  const presence = typeof isEmailOnline === 'function' ? isEmailOnline(email) : null;
  return {
    email,
    displayName: displayNameOf(acc) || email.split('@')[0],
    online: !!(presence && presence.online),
    away: !!(presence && presence.away),
    username: (presence && presence.username) || (acc && acc.displayName) || null,
    sessionToken: (presence && presence.sessionToken) || null,
    socketId: (presence && presence.socketId) || null,
    lastLoginAt: acc ? acc.lastLoginAt : null,
    lastSeenAt: acc ? acc.lastSeenAt : null
  };
}

function listFriendsWithPresence(sessionToken, isEmailOnline) {
  const base = listFriends(sessionToken);
  if (!base.ok) return base;
  const acc = getAccountForSession(sessionToken);
  const enriched = (base.friends || []).map((email) => presencePayload(email, isEmailOnline));
  enriched.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  return {
    ok: true,
    friends: enriched,
    email: base.email,
    incomingRequests: acc ? acc.incomingRequests || [] : [],
    outgoingRequests: acc ? acc.outgoingRequests || [] : []
  };
}

function listFriendRequests(sessionToken, isEmailOnline) {
  const acc = getAccountForSession(sessionToken);
  if (!isActive(acc)) return { ok: false, message: 'Not logged in with a verified email.' };
  return {
    ok: true,
    incoming: (acc.incomingRequests || []).map((email) => presencePayload(email, isEmailOnline)),
    outgoing: (acc.outgoingRequests || []).map((email) => presencePayload(email, isEmailOnline))
  };
}

function isBlockedAccount(aEmail, bEmail) {
  const a = getAccountByEmail(aEmail);
  const b = getAccountByEmail(bEmail);
  const ae = String(aEmail || '').toLowerCase();
  const be = String(bEmail || '').toLowerCase();
  if (a && (a.blocked || []).includes(be)) return true;
  if (b && (b.blocked || []).includes(ae)) return true;
  return false;
}

function blockAccount(sessionToken, targetEmail) {
  const me = getEmailForSession(sessionToken);
  if (!me) return { ok: false, message: 'Please log in first.' };
  const acc = accounts.get(me);
  const target = String(targetEmail || '').trim().toLowerCase();
  if (!acc || !target) return { ok: false, message: 'Could not block that user.' };
  if (target === me) return { ok: false, message: 'You cannot block yourself.' };
  acc.blocked = acc.blocked || [];
  uniquePush(acc.blocked, target);
  stripFrom(acc.friends || [], target);
  stripFrom(acc.incomingRequests || [], target);
  stripFrom(acc.outgoingRequests || [], target);
  const other = accounts.get(target);
  if (other) {
    stripFrom(other.friends || [], me);
    stripFrom(other.incomingRequests || [], me);
    stripFrom(other.outgoingRequests || [], me);
  }
  saveAccounts();
  return { ok: true, message: 'User blocked.', account: publicAccount(acc), targetEmail: target };
}

function unblockAccount(sessionToken, targetEmail) {
  const me = getEmailForSession(sessionToken);
  if (!me) return { ok: false, message: 'Please log in first.' };
  const acc = accounts.get(me);
  const target = String(targetEmail || '').trim().toLowerCase();
  if (!acc) return { ok: false, message: 'Not logged in.' };
  stripFrom(acc.blocked || [], target);
  saveAccounts();
  return { ok: true, message: 'User unblocked.', account: publicAccount(acc) };
}

function listBlockedAccounts(sessionToken) {
  const acc = getAccountForSession(sessionToken);
  if (!isActive(acc)) return { ok: false, blocked: [] };
  return {
    ok: true,
    blocked: (acc.blocked || []).map((email) => ({
      email,
      displayName: displayNameOf(getAccountByEmail(email)) || email.split('@')[0]
    }))
  };
}

function listRegisteredUsers(sessionToken, isEmailOnline) {
  const meAcc = getAccountForSession(sessionToken);
  if (!isActive(meAcc)) {
    return { ok: false, users: [], message: 'Log in with a verified email to see registered members.' };
  }
  const me = meAcc.email;
  const owner = isOwner(me);
  const users = [];
  for (const acc of accounts.values()) {
    if (!isActive(acc)) continue;
    if (!owner && acc.email === me) continue;
    if (!owner && isBlockedAccount(me, acc.email)) continue;
    const p = presencePayload(acc.email, isEmailOnline);
    p.isFriend = (meAcc.friends || []).includes(acc.email);
    p.requestIncoming = (meAcc.incomingRequests || []).includes(acc.email);
    p.requestOutgoing = (meAcc.outgoingRequests || []).includes(acc.email);
    p.isOwner = isOwner(acc.email);
    if (!owner) {
      // Regular members see display name, not a needless extra field
    } else {
      p.createdAt = acc.createdAt;
      p.verified = acc.verified;
      p.friendsCount = (acc.friends || []).length;
    }
    users.push(p);
  }
  users.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || String(a.displayName).localeCompare(String(b.displayName)));
  return { ok: true, users, isOwner: owner };
}

function listAllUsersAdmin(sessionToken, isEmailOnline) {
  const meAcc = getAccountForSession(sessionToken);
  if (!meAcc || !isOwner(meAcc.email)) {
    return { ok: false, message: 'Owner access only.' };
  }
  const users = [];
  for (const acc of accounts.values()) {
    const p = presencePayload(acc.email, isEmailOnline);
    p.verified = !!acc.verified;
    p.createdAt = acc.createdAt;
    p.friends = (acc.friends || []).slice();
    p.friendsCount = (acc.friends || []).length;
    p.blockedCount = (acc.blocked || []).length;
    p.incomingRequests = (acc.incomingRequests || []).slice();
    p.isOwner = isOwner(acc.email);
    users.push(p);
  }
  const pending = [];
  for (const p of pendingSignups.values()) {
    pending.push({
      email: p.email,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt
    });
  }
  users.sort((a, b) => (b.lastLoginAt || 0) - (a.lastLoginAt || 0));
  return { ok: true, users, pending, ownerEmail: ownerEmail() };
}

loadAccounts();

module.exports = {
  register,
  verify,
  login,
  bindSession,
  unbindSession,
  getEmailForSession,
  getAccountForSession,
  getAccountByEmail,
  addFriend,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  removeFriend,
  listFriends,
  listFriendsWithPresence,
  listFriendRequests,
  listRegisteredUsers,
  listAllUsersAdmin,
  resendCode,
  publicAccount,
  findSessionTokenForEmail,
  findAllSessionTokensForEmail,
  restoreAuth,
  createAuthToken,
  revokeAuthToken,
  revokeAuthTokensForEmail,
  touchLastSeen,
  touchLastLogin,
  setDisplayName,
  isOwner,
  ownerEmail,
  isBlockedAccount,
  blockAccount,
  unblockAccount,
  listBlockedAccounts,
  emailConfigured: mail.emailConfigured,
  mailStatus: mail.mailStatus
};
