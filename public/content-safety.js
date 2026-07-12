/**
 * PineappleChat content safety helpers (browser + Node).
 * Age gate (18+), link blocking, dangerous-word filter.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.IChatSafety = api;
    root.PineappleChatSafety = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN_AGE = 18;
  const MAX_AGE = 99;

  // Links / contact sharing patterns
  const LINK_PATTERN =
    /https?:\/\/|www\.|\/\/|\b[\w.-]+\.(com|net|org|io|co|me|app|xyz|info|biz|tv|gg|ly|to|cc|ru|cn|in|uk|us|de|fr)\b|bit\.ly|t\.co|tinyurl|goo\.gl|\b\d{1,3}(\.\d{1,3}){3}\b/i;

  // Email / phone (reduce scams & harassment off-platform)
  const CONTACT_PATTERN =
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|\b(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{3,4}\b/i;

  /**
   * Dangerous / prohibited content (threats, exploitation, self-harm, scams, severe abuse).
   * Matched as whole words (case-insensitive). Not exhaustive — server + client enforce.
   */
  const BANNED_WORDS = [
    // Violence / threats
    'kill yourself', 'kys', 'murder', 'bomb threat', 'terrorist', 'shoot up', 'school shooting',
    'i will kill', "i'll kill", 'rape', 'rapist',
    // Exploitation / minors (zero tolerance)
    'child porn', 'childporn', 'cp ', ' underage sex', 'pedo', 'paedo', 'pedophile', 'loli',
    // Self-harm
    'commit suicide', 'kill myself', 'cut myself', 'self harm', 'self-harm',
    // Scams / fraud
    'wire transfer', 'western union', 'send bitcoin', 'crypto giveaway', 'nigerian prince',
    'bank details', 'otp please', 'share otp', 'gift card scam',
    // Hate / extreme abuse (examples)
    'nigger', 'faggot', 'kike', 'chink',
    // Explicit solicitation that often leads to harm
    'onlyfans link', 'sex for money', 'escort service'
  ];

  function normalizeText(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[0@]/g, 'o')
      .replace(/[1!|]/g, 'i')
      .replace(/3/g, 'e')
      .replace(/\$/g, 's')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isValidAge(raw) {
    const n = parseInt(String(raw ?? '').replace(/\D/g, ''), 10);
    return Number.isFinite(n) && n >= MIN_AGE && n <= MAX_AGE;
  }

  function parseAge(raw) {
    const n = parseInt(String(raw ?? '').replace(/\D/g, ''), 10);
    return Number.isFinite(n) ? n : NaN;
  }

  function containsLink(text) {
    return LINK_PATTERN.test(String(text || ''));
  }

  function containsContactInfo(text) {
    return CONTACT_PATTERN.test(String(text || ''));
  }

  function findBannedPhrase(text) {
    const norm = normalizeText(text);
    if (!norm) return null;
    for (let i = 0; i < BANNED_WORDS.length; i++) {
      const phrase = BANNED_WORDS[i];
      if (norm.includes(phrase)) return phrase;
    }
    return null;
  }

  /**
   * @returns {{ ok: true, text: string } | { ok: false, reason: string, message: string }}
   */
  function validateChatText(text) {
    const raw = String(text || '');
    const clean = raw.trim().slice(0, 800);
    if (!clean) {
      return { ok: false, reason: 'empty', message: 'Message cannot be empty.' };
    }
    if (containsLink(clean)) {
      return {
        ok: false,
        reason: 'link',
        message: 'Links are not allowed in chat for safety.'
      };
    }
    if (containsContactInfo(clean)) {
      return {
        ok: false,
        reason: 'contact',
        message: 'Sharing emails or phone numbers is not allowed.'
      };
    }
    const banned = findBannedPhrase(clean);
    if (banned) {
      return {
        ok: false,
        reason: 'banned',
        message: 'Your message contains prohibited or unsafe language and was blocked.'
      };
    }
    return { ok: true, text: clean };
  }

  function validateUsername(name) {
    const u = String(name || '').trim();
    if (!u) return { ok: false, message: 'Username is required.' };
    if (u.length > 24) return { ok: false, message: 'Username is too long.' };
    if (containsLink(u) || findBannedPhrase(u)) {
      return { ok: false, message: 'Username contains prohibited content.' };
    }
    return { ok: true, text: u };
  }

  function validateWhatsOnMind(text) {
    if (!text || !String(text).trim()) return { ok: true, text: '' };
    return validateChatText(text);
  }

  return {
    MIN_AGE,
    MAX_AGE,
    isValidAge,
    parseAge,
    containsLink,
    containsContactInfo,
    findBannedPhrase,
    validateChatText,
    validateUsername,
    validateWhatsOnMind
  };
});
