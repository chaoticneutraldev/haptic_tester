# Haptic Tester

Web app for testing haptic behavior across devices.

Live deployment: `https://haptics-tester.netlify.app`

## Features

- `Device check`: best-effort device profile + haptics support probe.
- `Haptics tester`: preset vibration patterns and custom pattern editing.
- `Haptics pairing`: HOST/GUEST shortcode signaling (8-char code), manual blob fallback, instant mode, and pattern timeline mode.

## Quick testing instructions

### Test haptics solo (`Haptics Tester`)

1. Open the app and go to `Haptics Tester`.
2. Start in `Instant` mode and tap a preset to confirm your device can vibrate.
3. Try `Pattern` mode to build a short timeline and press `Play`.
4. Try `Sustained` mode and move the level slider up/down (set to `0` to stop).
5. Use `Stop all` any time to immediately stop local playback/sustain.

### Test haptics with another person (`Pairing`)

1. Person A opens `Pairing` and selects `I am HOST`.
2. Person B opens `Pairing` and selects `I am GUEST`.
3. HOST taps `Generate offer` and shares the pair code.
4. GUEST enters the pair code, taps `Create answer`, then waits for connect.
5. Once connected, HOST sends `Instant`, `Pattern`, or `Sustained` actions; GUEST feels them.
6. Use `Stop all` (HOST footer) to halt guest actions immediately, and `End connection` when done.

## Local development

```bash
npm install
npm run dev
```

`npm install` enables a **Husky** `pre-push` hook (see *Versioning & releases*). The app footer shows **`v` + `package.json` `version`**, baked in at build time.

## Versioning & releases

- **Display version:** `package.json` → `version` (`0.24.0`). The UI footer shows **`v0.24.0`** (same string Vite injects as `__APP_VERSION__`).
- **Git tag:** Release commits on `main` should have tag **`v` + that version** (e.g. `v0.24.0`) on **HEAD**.
- **Pre-push (main only):** Pushing while on branch `main` runs `scripts/verify-version-push.mjs`. It fails if `package.json` says `0.24.0` but `v0.24.0` is not among the tags on `HEAD`. Feature branches are not checked.
- **Override (emergencies):** `SKIP_VERSION_CHECK=1 git push …`

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
- Shortcode signaling uses Redis-backed state with 2-hour host/guest match TTL, then 12-hour active TTL after answer is posted. Reconnect handoff stores an optional `nextShortcode` on the prior matched session.
