/**
 * Email accounts + friends for PineappleChat.
 * Verification codes are logged and returned in dev (no real SMTP required).
 * Persist to data/accounts.json so restarts keep accounts.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mail = require(path.join(__dirname, 'server-mail.js'));

const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');

/** email(lower) -> account */
const accounts = new Map();
/** email -> { code, expiresAt } */
const pendingCodes = new Map();
/** sessionToken -> email (logged-in account for live session) */
const sessionAccount = new Map();

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAccounts() {
  try {
    ensureDataDir();
    if (!fs.existsSync(ACCOUNTS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const [email, acc] of Object.entries(raw)) {
        accounts.set(email.toLowerCase(), {
          email: email.toLowerCase(),
          passwordHash: acc.passwordHash,
          salt: acc.salt,
          verified: !!acc.verified,
          friends: Array.isArray(acc.friends) ? acc.friends : [],
          createdAt: acc.createdAt || Date.now()
        });
      }
    }
    console.log(`[accounts] loaded ${accounts.size} account(s)`);
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
        createdAt: acc.createdAt
      };
    }
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.warn('[accounts] save failed:', e.message);
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

function publicAccount(acc) {
  if (!acc) return null;
  return {
    email: acc.email,
    verified: !!acc.verified,
    friends: (acc.friends || []).slice()
  };
}

async function issueCode(email) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  pendingCodes.set(email, { code, expiresAt: Date.now() + 15 * 60 * 1000 });
  console.log(`[accounts] verification code for ${email}: ${code}`);
  const send = await mail.sendVerificationEmail(email, code);
  const devMode = !send.sent;
  return {
    code,
    devMode,
    message: send.sent
      ? 'Verification code sent to your email. Enter the 6-digit code to confirm.'
      : 'Verification code ready. (Email not configured — use the demo code shown.)',
    // Only return code when email was not actually sent
    devCode: devMode ? code : undefined
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

  const salt = crypto.randomBytes(16).toString('hex');
  const passwordHash = hashPassword(password, salt);
  accounts.set(email, {
    email,
    passwordHash,
    salt,
    verified: false,
    friends: existing && existing.friends ? existing.friends : [],
    createdAt: Date.now()
  });
  saveAccounts();

  const issued = await issueCode(email);
  return {
    ok: true,
    message: issued.message,
    devCode: issued.devCode,
    emailConfigured: mail.emailConfigured()
  };
}

function verify(email, code) {
  email = String(email || '').trim().toLowerCase();
  code = String(code || '').trim();
  const acc = accounts.get(email);
  if (!acc) return { ok: false, message: 'No registration found for this email. Register first.' };
  const pending = pendingCodes.get(email);
  if (!pending || pending.expiresAt < Date.now()) {
    return { ok: false, message: 'Code expired. Please register again to get a new code.' };
  }
  if (pending.code !== code) {
    return { ok: false, message: 'Invalid verification code.' };
  }
  acc.verified = true;
  pendingCodes.delete(email);
  saveAccounts();
  return { ok: true, message: 'Email verified! You can now add friends.', account: publicAccount(acc) };
}

async function login(email, password) {
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  const acc = accounts.get(email);
  if (!acc) return { ok: false, message: 'Account not found. Please register first.' };
  const hash = hashPassword(password, acc.salt);
  if (hash !== acc.passwordHash) {
    return { ok: false, message: 'Incorrect password.' };
  }
  if (!acc.verified) {
    const issued = await issueCode(email);
    return {
      ok: false,
      needsVerification: true,
      message: 'Please verify your email first. ' + issued.message,
      devCode: issued.devCode
    };
  }
  return { ok: true, message: 'Logged in.', account: publicAccount(acc) };
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

function addFriend(requesterToken, targetEmailOrToken, resolveTargetEmail) {
  const reqEmail = getEmailForSession(requesterToken);
  if (!reqEmail) {
    return { ok: false, message: 'Register and verify your email before adding friends.' };
  }
  const reqAcc = accounts.get(reqEmail);
  if (!reqAcc || !reqAcc.verified) {
    return { ok: false, message: 'Verify your email before adding friends.' };
  }

  let targetEmail = null;
  if (typeof resolveTargetEmail === 'function') {
    targetEmail = resolveTargetEmail(targetEmailOrToken);
  }
  if (!targetEmail && isValidEmail(targetEmailOrToken)) {
    targetEmail = String(targetEmailOrToken).trim().toLowerCase();
  }
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
  if (!targetAcc || !targetAcc.verified) {
    return { ok: false, message: 'That email is not registered/verified on PineappleChat.' };
  }

  reqAcc.friends = reqAcc.friends || [];
  targetAcc.friends = targetAcc.friends || [];
  if (reqAcc.friends.includes(targetEmail)) {
    return { ok: true, message: 'Already friends.', account: publicAccount(reqAcc) };
  }
  reqAcc.friends.push(targetEmail);
  if (!targetAcc.friends.includes(reqEmail)) {
    targetAcc.friends.push(reqEmail);
  }
  saveAccounts();
  return {
    ok: true,
    message: `You are now friends with ${targetEmail}.`,
    account: publicAccount(reqAcc),
    targetEmail
  };
}

function listFriends(sessionToken) {
  const acc = getAccountForSession(sessionToken);
  if (!acc || !acc.verified) return { ok: false, friends: [], message: 'Not logged in with a verified email.' };
  return { ok: true, friends: (acc.friends || []).slice(), email: acc.email };
}

/**
 * Enrich friends with online status using a callback:
 * isEmailOnline(email) -> { online, username, sessionToken, socketId } | null
 */
function listFriendsWithPresence(sessionToken, isEmailOnline) {
  const base = listFriends(sessionToken);
  if (!base.ok) return base;
  const enriched = (base.friends || []).map((email) => {
    const presence = typeof isEmailOnline === 'function' ? isEmailOnline(email) : null;
    return {
      email,
      online: !!(presence && presence.online),
      away: !!(presence && presence.away),
      username: (presence && presence.username) || null,
      sessionToken: (presence && presence.sessionToken) || null,
      socketId: (presence && presence.socketId) || null
    };
  });
  // Online friends first
  enriched.sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0));
  return { ok: true, friends: enriched, email: base.email };
}

async function resendCode(email) {
  email = String(email || '').trim().toLowerCase();
  const acc = accounts.get(email);
  if (!acc) return { ok: false, message: 'No account for this email.' };
  if (acc.verified) return { ok: false, message: 'Email already verified. You can log in.' };
  const issued = await issueCode(email);
  return { ok: true, message: issued.message, devCode: issued.devCode };
}

function findSessionTokenForEmail(email) {
  email = String(email || '').toLowerCase();
  for (const [token, em] of sessionAccount.entries()) {
    if (em === email) return token;
  }
  return null;
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
  addFriend,
  listFriends,
  listFriendsWithPresence,
  resendCode,
  publicAccount,
  findSessionTokenForEmail,
  emailConfigured: mail.emailConfigured
};
