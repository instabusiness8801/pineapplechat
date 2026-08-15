/**
 * Email delivery for verification codes and inbox notifications.
 * Providers (first match wins):
 *   1. Resend  — RESEND_API_KEY or EMAIL_API_KEY
 *   2. SMTP    — SMTP_HOST + SMTP_USER + SMTP_PASS (nodemailer, optional)
 *
 * ALLOW_DEV_CODES=true lets local testing skip a real send (code logged only).
 */
const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch (e) {
    console.warn('[mail] .env load:', e.message);
  }
}
loadDotEnv();

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  nodemailer = null;
}

function resendKey() {
  return process.env.RESEND_API_KEY || process.env.EMAIL_API_KEY || '';
}

function smtpConfigured() {
  return !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    nodemailer
  );
}

function emailConfigured() {
  return !!(resendKey() || smtpConfigured());
}

function allowDevCodes() {
  return process.env.ALLOW_DEV_CODES === 'true';
}

function fromAddress() {
  return process.env.EMAIL_FROM || 'PineappleChat <onboarding@resend.dev>';
}

function mailStatus() {
  if (resendKey()) return { configured: true, provider: 'resend' };
  if (smtpConfigured()) return { configured: true, provider: 'smtp' };
  return { configured: false, provider: allowDevCodes() ? 'dev' : 'none' };
}

async function sendViaResend({ to, subject, text, html }) {
  const apiKey = resendKey();
  if (!apiKey) return { ok: false, sent: false, error: 'no-resend-key' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: fromAddress(), to: [to], subject, text, html })
  });
  if (!res.ok) {
    const body = await res.text();
    console.warn('[mail] Resend failed:', res.status, body);
    return { ok: false, sent: false, error: body };
  }
  return { ok: true, sent: true, provider: 'resend' };
}

async function sendViaSmtp({ to, subject, text, html }) {
  if (!smtpConfigured()) return { ok: false, sent: false, error: 'no-smtp' };
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
  await transporter.sendMail({
    from: fromAddress(),
    to,
    subject,
    text,
    html
  });
  return { ok: true, sent: true, provider: 'smtp' };
}

async function sendEmail({ to, subject, text, html }) {
  const errors = [];
  if (resendKey()) {
    try {
      const r = await sendViaResend({ to, subject, text, html });
      if (r.sent) {
        console.log(`[mail] sent via Resend to ${to} (${subject})`);
        return r;
      }
      errors.push(r.error || 'resend-failed');
    } catch (e) {
      errors.push(e.message);
      console.warn('[mail] Resend error:', e.message);
    }
  }
  if (smtpConfigured()) {
    try {
      const r = await sendViaSmtp({ to, subject, text, html });
      if (r.sent) {
        console.log(`[mail] sent via SMTP to ${to} (${subject})`);
        return r;
      }
      errors.push(r.error || 'smtp-failed');
    } catch (e) {
      errors.push(e.message);
      console.warn('[mail] SMTP error:', e.message);
    }
  }
  return {
    ok: false,
    sent: false,
    configured: emailConfigured(),
    error: errors.filter(Boolean).join('; ') || 'email-not-configured'
  };
}

function verifyHtml(code) {
  return `
  <div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#fff8e7;border-radius:16px;border:1px solid #f5d76e">
    <div style="font-size:22px;font-weight:700;color:#2d5a27">🍍 PineappleChat</div>
    <p style="color:#3f3a32;font-size:15px">Your verification code is:</p>
    <p style="font-size:32px;font-weight:700;letter-spacing:8px;color:#2d5a27;margin:16px 0">${code}</p>
    <p style="color:#6b6458;font-size:13px">It expires in 15 minutes. If you did not create an account, ignore this email.</p>
  </div>`;
}

function inboxHtml(fromName, preview) {
  const safeFrom = String(fromName || 'Someone').replace(/[<>]/g, '');
  const safePreview = String(preview || '').replace(/[<>]/g, '').slice(0, 160);
  return `
  <div style="font-family:Inter,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#fff8e7;border-radius:16px;border:1px solid #f5d76e">
    <div style="font-size:22px;font-weight:700;color:#2d5a27">🍍 PineappleChat</div>
    <p style="color:#3f3a32;font-size:15px"><strong>${safeFrom}</strong> sent you a message:</p>
    <p style="background:#fff;border-radius:12px;padding:12px 14px;color:#3f3a32;font-size:14px">${safePreview || '(new message)'}</p>
    <p style="color:#6b6458;font-size:13px">Open <a href="https://pineapplechat.com">pineapplechat.com</a>, log in, and check your Inbox to reply.</p>
  </div>`;
}

async function sendVerificationEmail(to, code) {
  const subject = 'Your PineappleChat verification code';
  const text = `Your PineappleChat verification code is: ${code}\n\nIt expires in 15 minutes.\nIf you did not request this, ignore this email.`;
  const html = verifyHtml(code);
  const result = await sendEmail({ to, subject, text, html });
  if (!result.sent) {
    console.log(`[mail] verification code for ${to}: ${code} (not emailed: ${result.error})`);
  }
  return result;
}

async function sendInboxNotification(to, fromName, preview) {
  const subject = `New PineappleChat message from ${fromName || 'someone'}`;
  const text = `${fromName || 'Someone'} sent you a message on PineappleChat:\n\n${String(preview || '').slice(0, 200)}\n\nLog in at https://pineapplechat.com and open Inbox to reply.`;
  const html = inboxHtml(fromName, preview);
  return sendEmail({ to, subject, text, html });
}

module.exports = {
  sendVerificationEmail,
  sendInboxNotification,
  emailConfigured,
  allowDevCodes,
  mailStatus,
  loadDotEnv
};
