/**
 * Copy accounts + inbox to a secret GitHub Gist so Render deploys
 * do not wipe friends and messages. Set DATA_GIST_ID + DATA_GIST_TOKEN.
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR, ensureDataDir } = require(path.join(__dirname, 'data-dir.js'));

const FILES = ['accounts.json', 'inbox.json', 'reports.json', 'pending.json'];
const META = 'meta.json';

function gistId() {
  return String(process.env.DATA_GIST_ID || '').trim();
}

function gistToken() {
  return String(process.env.DATA_GIST_TOKEN || process.env.GITHUB_TOKEN || '').trim();
}

function configured() {
  return !!(gistId() && gistToken());
}

function localPath(name) {
  return path.join(DATA_DIR, name);
}

function readLocal(name, fallback) {
  try {
    if (!fs.existsSync(localPath(name))) return fallback;
    return fs.readFileSync(localPath(name), 'utf8');
  } catch (e) {
    return fallback;
  }
}

function writeLocal(name, content) {
  ensureDataDir();
  fs.writeFileSync(localPath(name), content, 'utf8');
}

function localSavedAt() {
  try {
    const meta = JSON.parse(readLocal(META, '{}'));
    return Number(meta.savedAt) || 0;
  } catch (e) {
    return 0;
  }
}

function stampLocal() {
  writeLocal(META, JSON.stringify({ savedAt: Date.now() }, null, 2));
}

async function gistRequest(method, body) {
  const res = await fetch('https://api.github.com/gists/' + gistId(), {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + gistToken(),
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    json = null;
  }
  if (!res.ok) {
    const msg = (json && json.message) || text.slice(0, 200) || res.status;
    throw new Error(msg);
  }
  return json;
}

async function pullRemote() {
  const json = await gistRequest('GET');
  const files = json.files || {};
  const out = {};
  for (const name of FILES.concat([META])) {
    if (files[name] && typeof files[name].content === 'string') {
      out[name] = files[name].content;
    }
  }
  return out;
}

function snapshotFiles() {
  const files = {};
  stampLocal();
  for (const name of FILES.concat([META])) {
    const content = readLocal(name, name === META ? JSON.stringify({ savedAt: Date.now() }) : '{}');
    files[name] = { content };
  }
  return files;
}

async function pushRemote() {
  if (!configured()) return { ok: false, skipped: true };
  await gistRequest('PATCH', { files: snapshotFiles() });
  console.log('[backup] saved accounts + inbox to Gist');
  return { ok: true };
}

let pushTimer = null;
function schedulePush() {
  if (!configured()) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushRemote().catch((e) => console.warn('[backup] push failed:', e.message));
  }, 800);
}

function localLooksEmpty() {
  try {
    const raw = JSON.parse(readLocal('accounts.json', '{}'));
    return !raw || Object.keys(raw).length === 0;
  } catch (e) {
    return true;
  }
}

async function restore() {
  if (!configured()) {
    console.log('[backup] off — set DATA_GIST_ID and DATA_GIST_TOKEN so friends/messages survive deploys');
    return { ok: false, skipped: true };
  }
  try {
    const remote = await pullRemote();
    let remoteSaved = 0;
    try {
      remoteSaved = Number(JSON.parse(remote[META] || '{}').savedAt) || 0;
    } catch (e) {
      remoteSaved = 0;
    }
    const localSaved = localSavedAt();
    const empty = localLooksEmpty();
    if (remote.accounts && (empty || remoteSaved > localSaved)) {
      for (const name of FILES.concat([META])) {
        if (remote[name]) writeLocal(name, remote[name]);
      }
      console.log('[backup] restored accounts + inbox from Gist');
      return { ok: true, restored: true };
    }
    if (!empty && remoteSaved < localSaved) {
      await pushRemote();
      return { ok: true, uploaded: true };
    }
    console.log('[backup] Gist in sync');
    return { ok: true };
  } catch (e) {
    console.warn('[backup] restore failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  configured,
  restore,
  schedulePush,
  pushRemote
};
