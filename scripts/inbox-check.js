const inbox = require('../server-inbox.js');

if (inbox.LIMIT !== 5) {
  console.error('LIMIT should be 5');
  process.exit(1);
}
if (inbox.RESET_MS !== 48 * 60 * 60 * 1000) {
  console.error('RESET_MS should be 48h');
  process.exit(1);
}
if (inbox.pairKey('B@x.com', 'a@x.com') !== 'a@x.com|b@x.com') {
  console.error('pairKey sort/lowercase failed');
  process.exit(1);
}

const lim = inbox.limitStatus('nobody@example.com', 'other@example.com', () => false);
if (!lim.ok || lim.remaining !== 5) {
  console.error('empty thread should allow 5', lim);
  process.exit(1);
}
const ownerLim = inbox.limitStatus('owner@example.com', 'other@example.com', (e) => e === 'owner@example.com');
if (!ownerLim.ok || !ownerLim.unlimited) {
  console.error('owner should be unlimited', ownerLim);
  process.exit(1);
}
console.log('INBOX LOGIC OK');
