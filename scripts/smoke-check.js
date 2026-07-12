const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Parse main page script
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const marker = 'world-locations.js';
const idx = html.indexOf(marker);
const scriptStart = html.indexOf('<script>', idx) + 8;
const scriptEnd = html.lastIndexOf('</script>');
const code = html.slice(scriptStart, scriptEnd);
try {
  // eslint-disable-next-line no-new-func
  new Function(code);
  console.log('PARSE OK');
} catch (err) {
  console.error('PARSE FAIL:', err.message);
  process.exit(1);
}

// Age helpers (must match client)
function sanitizeAgeDigits(raw) {
  return String(raw ?? '').replace(/\D/g, '').slice(0, 2);
}
function parseAgeValue(raw) {
  const n = parseInt(sanitizeAgeDigits(raw), 10);
  return Number.isFinite(n) ? n : NaN;
}
function isValidAge(raw) {
  const n = parseAgeValue(raw);
  return Number.isFinite(n) && n >= 13 && n <= 99;
}

// Prefer shared safety module (18+)
const safety = require(path.join(__dirname, '..', 'public', 'content-safety.js'));
const ageCases = [
  ['24', true],
  ['18', true],
  ['17', false],
  ['13', false],
  ['99', true],
  ['', false]
];
let ageOk = true;
for (const [raw, valid] of ageCases) {
  const v = safety.isValidAge(raw);
  if (v !== valid) {
    console.log('AGE FAIL', { raw, v, expectedValid: valid });
    ageOk = false;
  }
}
console.log(ageOk ? 'AGE 18+ OK' : 'AGE 18+ FAIL');
if (!ageOk) process.exit(1);

const linkBlock = safety.validateChatText('see https://evil.com');
const okMsg = safety.validateChatText('hello there');
if (linkBlock.ok || !okMsg.ok) {
  console.error('CHAT SAFETY FAIL', linkBlock, okMsg);
  process.exit(1);
}
console.log('CHAT SAFETY OK');

// Feature / regression guards
const ageMatch = html.match(/id="age"[^>]*>/);
const ageTag = ageMatch ? ageMatch[0] : '';
console.log('age tag:', ageTag);
const ageIsNumber = /id="age"[^>]*type="number"|type="number"[^>]*id="age"/.test(html);
const ageHasMin = /id="age"[^>]*\smin=/.test(html);
if (ageIsNumber) {
  console.error('REGRESSION: #age should not be type=number');
  process.exit(1);
}
if (ageHasMin) {
  console.error('REGRESSION: #age should not have min= (causes browser clamp to 13)');
  process.exit(1);
}

const required = [
  ['world-locations.js', 'country list script'],
  ['AVATAR_PRESETS', 'avatar presets'],
  ['Upload your photo', 'photo upload'],
  ['setAttribute(\'inert\'', 'inert hidden screens'],
  ['isValidLocation', 'location validation'],
  ['selectPresetAvatar', 'preset avatars'],
  ['5/5 messages', 'spam limit UI'],
  ['block-user', 'block user'],
  ['leave-chat', 'leave chat'],
  ['whats-on-mind', 'whats on mind'],
  ['sidebar-country-filter', 'country filter'],
  ['EMOJI_CATEGORIES', 'emoji picker'],
  ['country-iso.js', 'country flag ISO map'],
  ['formatLocationWithFlagHtml', 'flag in online lists'],
  ['flagcdn.com', 'flag image CDN'],
  ['theme-toggle', 'dark mode toggle'],
  ['pineapplechat-theme', 'theme localStorage key'],
  ['PineappleChat', 'site brand name'],
  ['data-theme', 'theme attribute'],
  ['agree-terms', 'terms checkbox'],
  ['content-safety.js', 'content safety script'],
  ['Terms & Safety', 'agreement section'],
  ['18–99', 'age gate copy'],
  ['pineapplechat-session', 'session restore key'],
  ['age-datalist', 'typeable age list'],
  ['country-datalist', 'typeable country list']
];
for (const [needle, label] of required) {
  if (!html.includes(needle)) {
    console.error('MISSING FEATURE:', label, '(', needle, ')');
    process.exit(1);
  }
}

// Locations file loads
const locSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'world-locations.js'), 'utf8');
const sandbox = { window: {} };
vm.runInNewContext(locSrc, sandbox);
const wl = sandbox.window.WORLD_LOCATIONS || {};
const countries = Object.keys(wl).length;
console.log('Countries:', countries);
if (countries < 150) {
  console.error('Too few countries');
  process.exit(1);
}
if (!wl.India || wl.India.length < 20) {
  console.error('India cities incomplete');
  process.exit(1);
}

// Server syntax
const serverPath = path.join(__dirname, '..', 'server.js');
try {
  require('child_process').execFileSync(process.execPath, ['--check', serverPath], { stdio: 'pipe' });
  console.log('SERVER SYNTAX OK');
} catch (e) {
  console.error('SERVER SYNTAX FAIL', e.stderr && e.stderr.toString());
  process.exit(1);
}

console.log('SMOKE CHECK PASSED');
