/**
 * Local e2e for bans + auto-blocks. Run against a SAFE local server started with TRUST_PROXY=true
 * (so x-forwarded-for simulates different visitor IPs), OWNER_EMAIL=owner.test@example.com, ALLOW_DEV_CODES=true.
 *   node scripts/moderation-e2e.js <phase> [baseUrl]
 * phase: main | after-restart | after-expiry
 */
const { io } = require('socket.io-client');

const PHASE = process.argv[2] || 'main';
const BASE = process.argv[3] || 'http://localhost:3917';
const OWNER = 'owner.test@example.com';
const PASS = 'secret12';
let failed = 0;
let total = 0;
function check(name, cond, info) {
  total += 1;
  if (!cond) failed += 1;
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (info ? '  — ' + info : ''));
  return !!cond;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let devSeq = 0;
function newDev(tag) { devSeq += 1; return (tag + 'dev' + Date.now().toString(36) + devSeq).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40); }

function connect(ip, deviceId) {
  return new Promise((resolve) => {
    const s = io(BASE, {
      path: '/socket.io', transports: ['websocket'], forceNew: true, reconnection: false, timeout: 8000,
      extraHeaders: ip ? { 'x-forwarded-for': ip + ', 10.0.0.1' } : {},
      auth: deviceId ? { deviceId } : {}
    });
    s.__events = [];
    s.__ip = ip;
    s.__dev = deviceId;
    s.onAny((ev, p) => s.__events.push({ ev, p }));
    s.on('disconnect', (reason) => s.__events.push({ ev: '__disconnect', p: reason }));
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => resolve(Object.assign(s, { __connectError: e.message })));
  });
}
function ack(s, ev, data, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), ms || 6000);
    s.emit(ev, data, (r) => { clearTimeout(t); resolve(r); });
  });
}
function waitFor(s, ev, pred, ms) {
  return new Promise((resolve) => {
    const f = s.__events.find((e) => e.ev === ev && (!pred || pred(e.p)));
    if (f) return resolve(f.p);
    const t = setTimeout(() => { clearInterval(iv); resolve(null); }, ms || 4000);
    const iv = setInterval(() => {
      const g = s.__events.find((e) => e.ev === ev && (!pred || pred(e.p)));
      if (g) { clearTimeout(t); clearInterval(iv); resolve(g.p); }
    }, 25);
  });
}
const profile = (name, gender) => ({ username: name, gender: gender || 'male', age: 25, country: 'India', city: 'Mumbai', agreedToTerms: true });

async function joinGuest(name, ip, dev) {
  const s = await connect(ip, dev || newDev(name));
  s.emit('set-profile', profile(name));
  const acc = await waitFor(s, 'profile-accepted', null, 3000);
  s.__token = acc && acc.sessionToken;
  s.__accepted = !!acc;
  return s;
}
async function registerMember(name, email, ip, dev) {
  const s = await connect(ip, dev || newDev(name));
  const reg = await ack(s, 'account-register', { email, password: PASS, displayName: name, gender: 'female', age: 27, country: 'India', city: 'Mumbai' });
  if (!reg || !reg.ok || !reg.devCode) throw new Error('register failed ' + email + ' ' + JSON.stringify(reg));
  const ver = await ack(s, 'account-verify', { email, code: reg.devCode });
  if (!ver || !ver.ok) throw new Error('verify failed ' + JSON.stringify(ver));
  s.emit('set-profile', Object.assign(profile(name, 'female'), { fromAccount: true }));
  const acc = await waitFor(s, 'profile-accepted', null, 3000);
  s.__token = acc && acc.sessionToken;
  return s;
}
async function loginMember(name, email, ip, dev) {
  const s = await connect(ip, dev || newDev(name));
  const r = await ack(s, 'account-login', { email, password: PASS });
  s.__login = r;
  if (r && r.ok) {
    s.emit('set-profile', Object.assign(profile(name, 'female'), { fromAccount: true }));
    await waitFor(s, 'profile-accepted', null, 3000);
  }
  return s;
}
async function isBlockedOnConnect(ip, dev, name) {
  const s = await joinGuest(name || ('Probe' + Math.floor(Math.random() * 1e5)), ip, dev);
  const banned = await waitFor(s, 'banned', null, 1200);
  const disc = await waitFor(s, '__disconnect', null, 1500);
  s.close();
  return { banned, accepted: s.__accepted, disconnected: !!disc };
}
const closeAll = (...ss) => ss.forEach((s) => { try { s.close(); } catch (e) { /* ignore */ } });

async function ownerSocket() {
  // owner on 198.51.100.1
  let s = await loginMember('Owner', OWNER, '198.51.100.1', 'ownerdevice0001');
  if (!s.__login || !s.__login.ok) {
    s.close();
    s = await registerMember('Owner', OWNER, '198.51.100.1', 'ownerdevice0001');
  }
  return s;
}

async function main() {
  const stamp = Date.now() % 100000;
  const owner = await ownerSocket();
  const st = await ack(owner, 'account-status', {});
  check('owner logged in (isOwner)', st && st.isOwner === true);

  if (PHASE === 'main') {
    // ---- owner-only enforcement ----
    const rando = await registerMember('Rando' + stamp, `rando.${stamp}@example.com`, '198.51.100.77');
    const g0 = await joinGuest('Guesty' + stamp, '198.51.100.78');
    const r1 = await ack(rando, 'admin-ban', { email: OWNER });
    check('non-owner member cannot ban', r1 && r1.ok === false && /owner/i.test(r1.message || ''), JSON.stringify(r1));
    const r2 = await ack(g0, 'admin-ban', { targetId: rando.id });
    check('guest cannot ban', r2 && r2.ok === false);
    const r3 = await ack(g0, 'admin-unban', { banId: 'x' });
    check('guest cannot unban', r3 && r3.ok === false && /owner/i.test(r3.message || ''));
    const r4 = await ack(rando, 'admin-bans', {});
    check('non-owner cannot list bans', r4 && r4.ok === false);
    const self = await ack(owner, 'admin-ban', { email: OWNER });
    check('owner cannot ban the owner account', self && self.ok === false);
    const botBan = await ack(owner, 'admin-ban', { targetId: 'bot:pineapplechat' });
    check('bot cannot be banned', botBan && botBan.ok === false);
    check('rando still connected (no accidental kick)', rando.connected && g0.connected);

    // ---- manual ban from a report (guest) ----
    const trollDev = newDev('troll');
    const troll = await joinGuest('Troll' + stamp, '203.0.113.10', trollDev);
    const partner = await joinGuest('Partner' + stamp, '198.51.100.21');
    partner.emit('start-chat-with', { targetId: troll.id });
    await waitFor(troll, 'chat-started', null, 3000);
    const rep = await ack(partner, 'report-user', { targetId: troll.id, reason: 'harassment', details: 'test' });
    check('report submitted', rep && rep.ok, JSON.stringify(rep));
    const au = await ack(owner, 'admin-users', {});
    const report = au && au.reports && au.reports.find((r) => r.id === rep.id);
    check('admin sees report with target IP', report && report.targetIp === '203.0.113.10', report && report.targetIp);
    check('admin-users includes bans list', au && au.bans && Array.isArray(au.bans.active));
    const ban = await ack(owner, 'admin-ban', { reportId: rep.id });
    check('owner bans reported guest', ban && ban.ok && ban.kicked >= 1, JSON.stringify(ban && { ok: ban.ok, kicked: ban.kicked, msg: ban.message }));
    check('ban covers IP + device', ban.ban && ban.ban.ips.includes('203.0.113.10') && ban.ban.deviceIds.includes(trollDev));
    check('ban does not include owner IP', ban.ban && !ban.ban.ips.includes('198.51.100.1'));
    const bmsg = await waitFor(troll, 'banned', null, 2000);
    check('troll receives ban message', bmsg && bmsg.message === 'You have been banned for violating the rules.', bmsg && bmsg.message);
    check('troll force-disconnected', !!(await waitFor(troll, '__disconnect', null, 2000)));
    partner.__events = [];
    partner.emit('request-online-users');
    const ol = await waitFor(partner, 'online-users', (l) => Array.isArray(l), 2000);
    check('banned user gone from partner\'s People list', ol && !ol.some((u) => u.socketId === troll.id || (u.username || '').startsWith('Troll')));
    check('partner still connected', partner.connected);
    let p = await isBlockedOnConnect('203.0.113.10', newDev('x'));
    check('troll rejoin same IP, new device → blocked', p.banned && p.disconnected && !p.accepted);
    p = await isBlockedOnConnect('203.0.113.11', trollDev);
    check('troll rejoin new IP, same device → blocked', p.banned && !p.accepted);
    p = await isBlockedOnConnect('203.0.113.12', newDev('y'));
    check('unrelated new IP + device → allowed', !p.banned && p.accepted);

    // ---- manual ban of a registered member (from the users list) ----
    const malEmail = `mallory.${stamp}@example.com`;
    const mal = await registerMember('Mallory' + stamp, malEmail, '203.0.113.20');
    const mal2 = await loginMember('Mallory' + stamp, malEmail, '203.0.113.21');
    check('mallory logged in on two connections', mal2.__login && mal2.__login.ok);
    const mban = await ack(owner, 'admin-ban', { email: malEmail });
    check('owner bans member by email', mban && mban.ok && mban.kicked >= 2, JSON.stringify(mban && { ok: mban.ok, kicked: mban.kicked }));
    check('both mallory sockets got banned', !!(await waitFor(mal, 'banned', null, 2000)) && !!(await waitFor(mal2, 'banned', null, 2000)));
    const ml = await loginMember('M', malEmail, '203.0.113.99', newDev('m'));
    check('banned member login from fresh IP/device refused', ml.__login && ml.__login.ok === false && ml.__login.banned === true, JSON.stringify(ml.__login));
    closeAll(ml);
    const sign = await connect('203.0.113.20', newDev('s'));
    check('signup from banned IP blocked at connect', !!(await waitFor(sign, 'banned', null, 1500)));
    closeAll(sign);
    const sign2 = await connect('203.0.113.98', newDev('s2'));
    const reg2 = await ack(sign2, 'account-register', { email: malEmail, password: PASS, displayName: 'Mal2', gender: 'female', age: 27, country: 'India', city: 'Mumbai' });
    check('signup with banned email refused', reg2 && reg2.ok === false && reg2.banned === true, JSON.stringify(reg2));
    closeAll(sign2);

    // ---- auto-block ----
    const victimIp = '203.0.113.30';
    const tgt = await joinGuest('Target' + stamp, victimIp);
    // 3 different devices behind ONE IP (one household / one person with several browsers)
    for (let i = 0; i < 3; i += 1) {
      const nat = await joinGuest('Nat' + i + stamp, '198.51.100.41', newDev('nat' + i));
      await ack(nat, 'report-user', { targetId: tgt.id, reason: 'spam' });
      closeAll(nat);
    }
    await sleep(300);
    check('3 reports from one IP (3 devices) do NOT auto-block', tgt.connected && !tgt.__events.some((e) => e.ev === 'banned'));
    // one person (same IP + device) reporting 3 times, then again from new sockets
    const solo = await joinGuest('Solo' + stamp, '198.51.100.40', 'solodevice00001');
    for (let i = 0; i < 3; i += 1) await ack(solo, 'report-user', { targetId: tgt.id, reason: 'spam' });
    for (let i = 0; i < 2; i += 1) {
      const again = await joinGuest('SoloB' + i + stamp, '198.51.100.40', 'solodevice00001');
      await ack(again, 'report-user', { targetId: tgt.id, reason: 'spam' });
      closeAll(again);
    }
    await sleep(300);
    check('same reporter x5 (+ 1 other IP) = 2 distinct → NOT auto-blocked', tgt.connected && !tgt.__events.some((e) => e.ev === 'banned'));
    const rep2 = solo;
    const rep3 = await joinGuest('RepC' + stamp, '198.51.100.43');
    const t0 = Date.now();
    await ack(rep3, 'report-user', { targetId: tgt.id, reason: 'spam' });
    const auto = await waitFor(tgt, 'banned', null, 2000);
    check('3rd distinct reporter → auto-block + kick', auto && auto.kind === 'auto', JSON.stringify(auto));
    const fiveDays = 5 * 24 * 3600 * 1000;
    check('auto-block lasts 5 days', auto && Math.abs(auto.until - (t0 + fiveDays)) < 60000, auto && new Date(auto.until).toISOString());
    check('auto-block message says temporary + until', auto && /temporarily blocked/i.test(auto.message) && /lifts automatically/i.test(auto.message));
    check('target disconnected', !!(await waitFor(tgt, '__disconnect', null, 2000)));
    check('reporters unaffected', rep2.connected && rep3.connected && solo.connected);
    p = await isBlockedOnConnect(victimIp, newDev('v'));
    check('auto-blocked IP cannot rejoin', p.banned && p.banned.kind === 'auto' && !p.accepted);
    const lb = await ack(owner, 'admin-bans', {});
    const autoEntry = lb && lb.bans && lb.bans.active.find((b) => b.kind === 'auto' && b.ips.includes(victimIp));
    check('admin sees auto-block entry', !!autoEntry, autoEntry && autoEntry.reason);

    // ---- owner never auto-blocked ----
    for (let i = 0; i < 3; i += 1) {
      const r = await joinGuest('OwnRep' + i + stamp, '198.51.100.5' + i);
      await ack(r, 'report-user', { targetId: owner.id, reason: 'spam' });
      closeAll(r);
    }
    await sleep(300);
    check('owner not auto-blocked after 3 distinct reports', owner.connected && !owner.__events.some((e) => e.ev === 'banned'));
    const lb2 = await ack(owner, 'admin-bans', {});
    check('no ban on owner IP', !lb2.bans.active.some((b) => b.ips.includes('198.51.100.1')));

    // ---- unban (manual ban of troll) ----
    const un = await ack(owner, 'admin-unban', { banId: ban.ban.id });
    check('owner unbans troll', un && un.ok);
    p = await isBlockedOnConnect('203.0.113.10', trollDev, 'TrollBack' + stamp);
    check('troll can rejoin after unban (same IP + device)', !p.banned && p.accepted);
    const un2 = await ack(owner, 'admin-unban', { banId: ban.ban.id });
    check('double unban is rejected cleanly', un2 && un2.ok === false);
    // unban + re-ban cycle on a fresh auto-block should not instantly re-trigger from old reports
    closeAll(owner, rando, g0, partner, solo, rep2, rep3);
    require('fs').writeFileSync(require('path').join(require('os').tmpdir(), 'pcban-state.json'),
      JSON.stringify({ malEmail, victimIp, trollDev, autoId: autoEntry && autoEntry.id }));
  }

  if (PHASE === 'after-restart' || PHASE === 'after-expiry') {
    const stt = JSON.parse(require('fs').readFileSync(require('path').join(require('os').tmpdir(), 'pcban-state.json'), 'utf8'));
    const lb = await ack(owner, 'admin-bans', {});
    if (PHASE === 'after-restart') {
      check('bans survived restart (member ban)', lb.bans.active.some((b) => b.email === stt.malEmail));
      check('bans survived restart (auto-block)', lb.bans.active.some((b) => b.kind === 'auto' && b.ips.includes(stt.victimIp)));
      check('lifted ban stays lifted', lb.bans.recent.some((b) => b.status === 'lifted'));
      const ml = await loginMember('M', stt.malEmail, '203.0.113.97', newDev('m'));
      check('banned member still refused after restart', ml.__login && ml.__login.banned === true);
      closeAll(ml);
      let p = await isBlockedOnConnect(stt.victimIp, newDev('v'));
      check('auto-blocked IP still blocked after restart', !!p.banned);
      p = await isBlockedOnConnect('203.0.113.10', stt.trollDev, 'TrollAgain');
      check('unbanned troll still allowed after restart', !p.banned && p.accepted);
    } else {
      let p = await isBlockedOnConnect(stt.victimIp, newDev('v'), 'Freed');
      check('expired auto-block lifts automatically', !p.banned && p.accepted);
      check('expired block listed as expired', lb.bans.recent.some((b) => b.kind === 'auto' && b.status === 'expired'));
      // unban the member via the admin action and check login works again
      const mb = lb.bans.active.find((b) => b.email === stt.malEmail);
      const un = await ack(owner, 'admin-unban', { banId: mb && mb.id });
      check('unban member', un && un.ok);
      const ml = await loginMember('MalBack', stt.malEmail, '203.0.113.20', newDev('m'));
      check('unbanned member can log in again (old IP too)', ml.__login && ml.__login.ok === true, JSON.stringify(ml.__login && ml.__login.message));
      closeAll(ml);
    }
    closeAll(owner);
  }
  console.log(`RESULT ${PHASE}: ${total - failed}/${total} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('ERROR', e); process.exit(1); });
