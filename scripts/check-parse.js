const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const marker = 'world-locations.js';
const idx = html.indexOf(marker);
const scriptStart = html.indexOf('<script>', idx) + 8;
const scriptEnd = html.lastIndexOf('</script>');
const code = html.slice(scriptStart, scriptEnd);
try {
  // eslint-disable-next-line no-new-func
  new Function(code);
  console.log('PARSE OK', code.length, 'chars');
} catch (err) {
  console.error('PARSE FAIL:', err.message);
  process.exit(1);
}

// Simulate dropdown fill
const locSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'world-locations.js'), 'utf8');
const sandbox = { window: {} };
require('vm').runInNewContext(locSrc, sandbox);
const WL = sandbox.window.WORLD_LOCATIONS;
console.log('Countries available:', Object.keys(WL).length);
console.log('India cities sample:', (WL.India || []).slice(0, 5).join(', '));
