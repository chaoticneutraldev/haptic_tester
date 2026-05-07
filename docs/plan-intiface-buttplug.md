# Plan: Optional Intiface / Buttplug output path

This document records how we could add an **optional** local hardware output path using [Intiface Central](https://intiface.com/docs/intiface-central/quickstart) and the [Buttplug client API](https://buttplug.io/docs/dev-guide/writing-buttplug-applications/api-basics), without replacing the existing WebRTC pairing stack.

## Goals

- Let testers produce **physical vibration** on supported peripherals (e.g. Xbox-compatible gamepad rumble, Buttplug-supported BLE devices) when the phone’s built-in Taptic / `navigator.vibrate` is missing or insufficient.
- Keep the **Netlify-hosted web app** the source of truth for UX; Intiface remains an **optional** install on the user’s machine or phone.
- Avoid implying that Buttplug drives **iOS Taptic Engine** — it does not; it drives **devices Intiface manages**.

## Non-goals

- Replacing WebRTC HOST/GUEST signaling with Buttplug.
- Guaranteeing parity between pattern timing and every toy’s firmware semantics.
- Requiring Intiface for basic app use.

## Architecture sketch

1. **Intiface Central** runs locally: Engine on default WebSocket (commonly `ws://127.0.0.1:12345` per docs/examples).
2. **Web app** optionally instantiates a **Buttplug client** (e.g. `buttplug` npm / browser bundle) and connects via **`ButtplugBrowserWebsocketClientConnector`** to that URL when the user enables “External device output” and the server is reachable.
3. **Mapping**: Map existing pattern abstractions (instant preset, timeline event, sustained level) → Buttplug **`DeviceOutput.Vibrate.percent(...)`** (or appropriate outputs per device capability) on **selected** devices after `startScanning` / device enumeration.
4. **Lifecycle**: On disconnect, stop outputs; surface errors per Buttplug error classes (connector, handshake, device, ping).

## UX / product

- Settings panel: “Intiface (optional)” — toggle, server URL (default localhost), status (disconnected / connected / scanning / devices listed), **Connect** / **Disconnect**, short link to Intiface install docs.
- Clear copy: **Physical phone buzz** may still be unavailable on iOS Safari; **external rumble** requires IC + supported hardware.
- Privacy: WebSocket stays **local** unless user points to another host — document risks if using non-localhost.

## Technical tasks (rough order)

1. Spike: add `buttplug` (or CDN build) in dev, connect to IC on desktop Chrome, enumerate devices, send one vibrate pulse from a dev-only page.
2. Abstract a small **`IntifaceOutputAdapter`** module: `connect()`, `disconnect()`, `setVibratePercent(0–1)`, `stopAll()`, map from our pattern ticks → time-sliced percent commands or short pulses (document limitations vs true motor control).
3. Wire adapter from **Haptics Tester** (local modes) first; only then consider **GUEST** path (optional “mirror to Intiface when connected”).
4. Feature flag or env: e.g. `VITE_INTIFACE_ENABLED` so production can ship UI off until stable.
5. Tests: manual matrix — macOS + IC + gamepad; iPhone + IC app + gamepad if supported; failure modes when IC off.

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Browser WebSocket to localhost on mobile | Document “IC on same device”; test iOS IC app + Safari; optional LAN URL for desktop-only advanced users. |
| Version skew client vs server | Show handshake errors; link to Intiface / buttplug version notes in UI. |
| Complexity for casual testers | Keep behind toggle; default off. |

## References

- [Intiface Central — Quick(ish)start](https://intiface.com/docs/intiface-central/quickstart)
- [Buttplug — API Basics](https://buttplug.io/docs/dev-guide/writing-buttplug-applications/api-basics)

## Relation to existing docs

- [ios/ADHOC-DISTRIBUTION.md](../ios/ADHOC-DISTRIBUTION.md) remains the path for **native iPhone Taptic** via a thin receiver; Intiface is complementary for **external** actuators.
