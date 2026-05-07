# Ad Hoc distribution (small beta, e.g. 4 devices)

Use this when you want **real iOS haptics** via a **native** “thin receiver” app and you have **a handful of testers** (Apple allows up to **100 registered devices per membership year** for Ad Hoc; you only need 4).

**Requirements**

- **Apple Developer Program** membership (paid).
- A **Mac** with **Xcode** (current stable).
- The **native iOS app** project (create in Xcode; not part of the web repo unless you add it).

**What Ad Hoc gives you**

- Testers install a signed **IPA** without a public App Store listing.
- Apps typically run until the **provisioning profile** (and signing certificate) **expires** — often on the order of **one year**, not 7-day sideload refreshes. Plan to re-export before expiry if the beta runs long.

---

## 1. Collect each tester’s device UDID

Each tester sends you their **UDID** (40 hex characters). Common ways:

- **macOS Finder**: connect iPhone → select it in sidebar → click device info until **Identifier (UDID)** appears → copy.
- **Xcode**: **Window → Devices and Simulators** → select device → copy **Identifier**.

Do **not** publish UDIDs in public repos or chat logs you don’t control.

---

## 2. Register devices in Apple Developer

1. Sign in to [Apple Developer](https://developer.apple.com/account).
2. **Certificates, Identifiers & Profiles** → **Devices**.
3. **Register a Device** → add a name + paste **UDID**.
4. Repeat for all **4** devices.

---

## 3. App ID and native app in Xcode

1. **Identifiers** → **App IDs** → register an **Explicit** App ID, e.g. `com.yourorg.hapticreceiver`.
2. In Xcode, create an **iOS App** project with the **same bundle identifier**.
3. Set **Deployment target** to the lowest iOS version you support (match your testers’ phones).

---

## 4. Distribution certificate (if you don’t have one)

1. **Certificates** → **+** → **Apple Distribution**.
2. Follow the CSR flow from **Keychain Access** on your Mac → create CSR → upload → download certificate → install.

Keep the private key backed up securely.

---

## 5. Create an Ad Hoc provisioning profile

1. **Profiles** → **+** → **Distribution** → **Ad Hoc**.
2. Select your **App ID**, your **Distribution** certificate, and **exactly the devices** (your 4 UDIDs).
3. Download the `.mobileprovision` file and **double‑click** it to install in Xcode, or rely on Xcode automatic profile refresh after login.

---

## 6. Configure Xcode signing (Release)

1. Open your app target → **Signing & Capabilities**.
2. For **Release** configuration (and Archive):
   - **Team**: your developer team.
   - **Signing Certificate**: **Apple Distribution**.
   - **Provisioning Profile**: select the **Ad Hoc** profile you created.

Use **Automatically manage signing** only if Xcode resolves the correct Ad Hoc profile; otherwise set profiles **manually** for Release.

---

## 7. Archive and export the IPA

1. Select **Any iOS Device (arm64)** (not a simulator).
2. **Product → Archive**.
3. In the Organizer → **Distribute App** → **Ad Hoc** → export.
4. Save the **`HapticReceiver.ipa`** (name as you prefer).

Verify the exported manifest lists the **four** registered device types/UDIDs (Xcode summarizes eligible devices).

---

## 8. Get the IPA onto each tester device

Pick one channel your testers can follow:

### Option A — You plug in each device (simplest)

- **Apple Configurator 2** (Mac): Add app → select your IPA → install on connected device.

### Option B — Over-the-air link (HTTPS)

Host the IPA (+ optional manifest plist) behind **HTTPS**, or use a **private** install link service your org trusts.

Testers tap the install link **on device** (**Safari**). They must trust your distribution certificate under **Settings → General → VPN & Device Management** the first time.

### Option C — AirDrop / files

Tester opens the IPA on device; iOS often routes to installation if the IPA is correctly signed for that device’s UDID.

---

## 9. Tester checklist (send this verbatim)

1. Confirm your **UDID** was registered **before** the IPA was built.
2. Install the IPA using the steps you provided (link or in-person install).
3. If iOS blocks open: **Settings → General → VPN & Device Management** → trust the **Developer App** / enterprise profile description shown.
4. If install fails with “unable to verify” or similar: the device was **not** in the Ad Hoc profile — recollect UDID, re-register, **re-archive and re-export**.

---

## 10. When you must rebuild

Rebuild and redistribute a **new IPA** when:

- You add a **5th** device (register UDID → new Ad Hoc profile or profile edit → archive again).
- **Provisioning profile** or **distribution certificate** **expires**.
- You change **capabilities** / App ID settings that affect signing.

---

## Limitations vs TestFlight

- **Ad Hoc**: no Apple “beta storefront”; you distribute the binary yourself. Profile maintenance is **on you**.
- **TestFlight**: easier for rotating builds and larger pools; builds expire after ~**90 days** per upload.

For **3–4 users** and **multi‑month** stability, Ad Hoc is reasonable **if** you track profile/cert expiry dates in a calendar.

---

## Relation to this repo

The **web app** stays on Netlify. The native app is optional; when implemented, it should implement the same **pairing / message** semantics as `src/lib/webrtc.ts` (data channel payloads) so HOST in the browser can still drive GUEST hardware on iPhone.
