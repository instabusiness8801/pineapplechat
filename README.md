# PineappleChat

Real-time stranger chat app (18+). Node.js + Express + Socket.IO, vanilla HTML/JS frontend.

## Run locally

```bash
npm install
npm start
```

Open **http://localhost:3000**

Optional: show fake demo users on the online list:

```bash
# Windows PowerShell
$env:ENABLE_DEMO_USERS="true"; npm start
```

By default **demo users are off** (correct for production).

## Deploy on Render

1. Push this project to **GitHub** (do not commit `node_modules`).
2. [render.com](https://render.com) → **New** → **Web Service** → connect the repo.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Plan:** Free is fine to start
4. Environment variables:
   - `ENABLE_DEMO_USERS` = `false` (or leave unset)
   - `RESEND_API_KEY` = your Resend API key (**required** so verification codes are emailed)
   - `EMAIL_FROM` = e.g. `PineappleChat <onboarding@resend.dev>`
   - `OWNER_EMAIL` = your login email (sees every member, unlimited inbox messages)
   - Do **not** set `PORT` — Render sets it automatically
5. Deploy → open the URL Render gives you (e.g. `https://your-app.onrender.com`)

### Notes

- Free Render services **sleep** when idle; first load can take ~30–60s.
- Use **two browsers** (or phone + computer) to test real chat — demo users cannot chat.
- Age gate is **18+**; terms agreement required; links/unsafe text are filtered.
- Accounts are created only after the emailed 6-digit code is confirmed.
- Inbox messages between registered users persist (including offline) until deleted.
- Registered members can send up to 5 inbox messages until the other person replies; the count resets after a reply or 48 hours. The owner account has no limit.

## Features

- Multi-chat, filters, block / unblock, report user
- Email register + real verification code
- Friends + friend requests, online / last-seen
- Persistent inbox for registered users (read ticks, offline delivery)
- Registered members directory
- Owner admin list (all users, reports, unlimited messaging)
- Reply to messages, reactions, read receipts
- Mute chat, voice notes, invite links
- Interests on profile, rate limits on spammy actions

## Tech

- Express + Socket.IO
- Vanilla HTML/JS + Tailwind CDN
- Optional Resend email API
