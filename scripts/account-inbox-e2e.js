/**
 * Live e2e against localhost: register → verify → friend request → inbox 5/48h limit.
 */
const { io } = require('socket.io-client');

function connect() {
  return new Promise((resolve, reject) => {
    const s = io('http://localhost:3000', {
      path: '/socket.io',
      transports: ['polling', 'websocket'],
      timeout: 8000
    });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

function emitAck(socket, event, data) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout on ' + event)), 10000);
    socket.emit(event, data, (res) => {
      clearTimeout(t);
      resolve(res);
    });
  });
}

async function main() {
  const stamp = Date.now();
  const aliceEmail = `alice.${stamp}@example.com`;
  const bobEmail = `bob.${stamp}@example.com`;
  const pass = 'secret12';

  const alice = await connect();
  const bob = await connect();

  const regA = await emitAck(alice, 'account-register', { email: aliceEmail, password: pass });
  if (!regA || !regA.ok) throw new Error('alice register failed: ' + JSON.stringify(regA));
  if (!regA.devCode) throw new Error('expected devCode when ALLOW_DEV_CODES=true');
  const verA = await emitAck(alice, 'account-verify', { email: aliceEmail, code: regA.devCode });
  if (!verA || !verA.ok || !verA.account || !verA.account.verified) {
    throw new Error('alice verify failed: ' + JSON.stringify(verA));
  }
  if (!verA.authToken) throw new Error('verify should return authToken');

  const regB = await emitAck(bob, 'account-register', { email: bobEmail, password: pass });
  if (!regB || !regB.ok || !regB.devCode) throw new Error('bob register failed');
  const verB = await emitAck(bob, 'account-verify', { email: bobEmail, code: regB.devCode });
  if (!verB || !verB.ok) throw new Error('bob verify failed: ' + JSON.stringify(verB));

  const people = await emitAck(alice, 'users-list', {});
  if (!people.ok) throw new Error('users-list failed ' + JSON.stringify(people));
  const found = (people.users || []).some((u) => u.email === bobEmail);
  if (!found) throw new Error('bob not in registered users list');

  const req = await emitAck(alice, 'friend-add', { email: bobEmail });
  if (!req.ok || !req.pending) throw new Error('friend request failed ' + JSON.stringify(req));
  const acc = await emitAck(bob, 'friend-accept', { email: aliceEmail });
  if (!acc.ok) throw new Error('friend accept failed ' + JSON.stringify(acc));
  const friends = await emitAck(alice, 'friend-list', {});
  if (!friends.ok || !(friends.friends || []).some((f) => f.email === bobEmail)) {
    throw new Error('alice friends missing bob');
  }

  let last = null;
  for (let i = 1; i <= 5; i++) {
    last = await emitAck(alice, 'inbox-send', { email: bobEmail, text: 'hello ' + i });
    if (!last.ok) throw new Error('inbox send ' + i + ' failed ' + JSON.stringify(last));
  }
  const sixth = await emitAck(alice, 'inbox-send', { email: bobEmail, text: 'too many' });
  if (sixth.ok) throw new Error('6th unanswered message should be blocked');

  const reply = await emitAck(bob, 'inbox-send', { email: aliceEmail, text: 'hi back' });
  if (!reply.ok) throw new Error('bob reply failed ' + JSON.stringify(reply));
  const afterReply = await emitAck(alice, 'inbox-send', { email: bobEmail, text: 'thanks' });
  if (!afterReply.ok) throw new Error('alice should be able to send after reply');

  const thread = await emitAck(bob, 'inbox-open', { email: aliceEmail });
  if (!thread.ok || !thread.messages || thread.messages.length < 6) {
    throw new Error('thread missing persisted messages');
  }
  const unreadAfterOpen = await emitAck(bob, 'inbox-unread', {});
  if (!unreadAfterOpen.ok || unreadAfterOpen.count !== 0) {
    throw new Error('unread should be 0 after open, got ' + JSON.stringify(unreadAfterOpen));
  }

  alice.close();
  bob.close();
  console.log('ACCOUNT + INBOX E2E OK');
}

main().catch((err) => {
  console.error('E2E FAIL:', err.message);
  process.exit(1);
});
