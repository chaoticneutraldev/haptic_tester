# Haptic Tester

Web app for testing haptic behavior across devices.

Live deployment: `https://haptics-tester.netlify.app`

## Features

- `Device check`: best-effort device profile + haptics support probe.
- `Haptics tester`: preset vibration patterns and custom pattern editing.
- `Haptics pairing`: HOST/GUEST shortcode signaling (8-char code), manual blob fallback, instant mode, and pattern timeline mode.

## Local development

```bash
npm install
npm run dev
```

## Deploy (Netlify)

This repo is configured for Netlify in `netlify.toml`.

- Build command: `npm run build`
- Publish directory: `dist`
- Netlify Functions directory: `netlify/functions`

### SPA + API routing

`netlify.toml` routes:

- `/api/turn/ice-config` -> Netlify Function `turn-ice-config`
- `/api/turn/usage/:username` -> Netlify Function `turn-usage`
- `/api/signal/session` -> Netlify Function `signal-session`
- `/api/signal/state/:code` -> Netlify Function `signal-state`
- everything else -> `/index.html` (SPA fallback)

## TURN relay via Metered (server-side only)

The frontend requests ICE config from `/api/turn/ice-config`. The function:

- creates a Metered TURN credential,
- sets auto-expiry (default 24h),
- returns ICE servers to the client,
- keeps your Metered `secretKey` off the frontend.

### Netlify environment variables

- `METERED_APP_NAME` (example: `haptic-test-cndev.metered.live`)
- `METERED_SECRET_KEY`
- `DEFAULT_EXPIRY_SECONDS` (optional, default `86400`)
- `UPSTASH_REDIS_REST_URL` (for shortcode signaling state)
- `UPSTASH_REDIS_REST_TOKEN` (for shortcode signaling state)

### Function endpoints

- `POST /.netlify/functions/turn-ice-config` (or `/api/turn/ice-config` through redirect)
- `GET /.netlify/functions/turn-usage/:username` (or `/api/turn/usage/:username`)
- `POST /.netlify/functions/signal-session` (or `/api/signal/session`)
- `GET/POST /.netlify/functions/signal-state/:code` (or `/api/signal/state/:code`)

## Notes

- If the TURN function is unavailable, WebRTC falls back to STUN-only.
- Pairing is shortcode-first (5-character code) with manual blob signaling as fallback.
- Shortcode signaling uses Redis-backed state with 15-minute host/guest match TTL, then 12-hour active TTL after answer is posted.
