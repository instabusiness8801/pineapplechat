/**
 * Optional real email for verification codes.
 * Set RESEND_API_KEY + EMAIL_FROM (e.g. PineappleChat <onboarding@resend.dev>)
 * Falls back to console + devCode when not configured.
 */
async function sendVerificationEmail(to, code) {
  const apiKey = process.env.RESEND_API_KEY || process.env.EMAIL_API_KEY || '';
  const from = process.env.EMAIL_FROM || 'PineappleChat <onboarding@resend.dev>';
  const subject = 'Your PineappleChat verification code';
  const text = `Your PineappleChat verification code is: ${code}\n\nIt expires in 15 minutes.\nIf you did not request this, ignore this email.`;
  const html = `<p>Your PineappleChat verification code is:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p><p>It expires in 15 minutes.</p>`;

  if (!apiKey) {
    console.log(`[mail] RESEND_API_KEY not set — code for ${to}: ${code}`);
    return { ok: true, sent: false, devMode: true };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ from, to: [to], subject, text, html })
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn('[mail] Resend failed:', res.status, body);
      return { ok: false, sent: false, error: body };
    }
    console.log(`[mail] verification email sent to ${to}`);
    return { ok: true, sent: true, devMode: false };
  } catch (e) {
    console.warn('[mail] send error:', e.message);
    return { ok: false, sent: false, error: e.message };
  }
}

function emailConfigured() {
  return !!(process.env.RESEND_API_KEY || process.env.EMAIL_API_KEY);
}

module.exports = { sendVerificationEmail, emailConfigured };
