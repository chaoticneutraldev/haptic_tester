# Haptic Tester

Web app for testing haptic behavior across devices.

Live deployment: `https://boisterous-sundae-56358a.netlify.app`

## Features

- `Device check`: best-effort device profile + haptics support probe.
- `Haptics tester`: preset vibration patterns and custom pattern editing.
- `Haptics pairing`: HOST/GUEST manual WebRTC signaling (compact blobs), instant mode, and pattern timeline mode.

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

### Function endpoints

- `POST /.netlify/functions/turn-ice-config` (or `/api/turn/ice-config` through redirect)
- `GET /.netlify/functions/turn-usage/:username` (or `/api/turn/usage/:username`)

## Notes

- If the TURN function is unavailable, WebRTC falls back to STUN-only.
- Pairing uses manual signaling blobs (compressed when available); the 8-character session code is a human label.
