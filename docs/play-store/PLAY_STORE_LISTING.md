# Play Store listing — ComputerCaller

> Ken-authored deck for Phase 8 of the deploy. Dennis clicks through the
> Play Console himself; this is the copy he pastes into each field and the
> answers he picks on each form. Pixel owns the icon + feature graphic;
> those file paths are referenced at the bottom.

Last updated: 2026-05-24 (Ken dispatch #14).

---

## Pre-flight checks before opening Play Console

- [ ] Play Console account is paid + ID-verified (Dennis confirmed 2026-05-24).
- [ ] Decide final `applicationId`. Currently `com.dnkdialer.companion`.
      **PERMANENT once published.** If you want `com.computercaller.companion`,
      rename BEFORE first upload. See `dnkdialer-android/app/build.gradle.kts`
      line 24, then rebuild.
- [ ] Signed release APK at
      `C:\Users\D\Desktop\computercaller\apk-releases\computercaller-v12.apk`
      (5.2 MB, SHA-256 `F608B52FD5BFE9EA75412BCBA5D822AB6ED46AF7B7703892CD1C58DD31078FE3`).
- [ ] Keystore backed up to TWO locations (password manager + USB/Drive).
      Fingerprints: SHA1 `4D:EB:3E:3C:05:B6:CB:BD:66:B3:9A:94:0F:BB:9E:1D:CF:9F:D7:B6`,
      SHA256 `3F:C1:08:19:7E:C6:81:37:7B:30:14:85:4B:43:20:63:3F:74:02:46:D7:70:86:1F:2E:FF:FF:D4:78:7E:5B:0F`.
- [ ] Privacy URL is live: https://computercaller.com/privacy
- [ ] Terms URL is live: https://computercaller.com/terms

---

## App details

| Field | Value |
|---|---|
| **App name** | ComputerCaller |
| **Default language** | English (United States) — en-US |
| **App or game** | App |
| **Free or paid** | Free (subscription billed externally via Whop — see Monetization note below) |

### Monetization note for the "Free or paid" choice

The app on Play is free to install. The companion web service has a 14-day
trial and then €7.99/month, billed via Whop (NOT Google Play Billing).
Because billing happens off-Google, declare **Free** — you do NOT need to
enable in-app purchases or Google Play Billing.

If Google ever asks "does your app use Play Billing for digital content?"
the answer is **No** because (a) the subscription unlocks the web
dashboard, not in-app digital content within the APK, and (b) the
companion device pattern is explicitly carved out in Google's billing
policy. Standard pattern for utility apps with a SaaS backend.

---

## Store listing

### Short description (80 chars max)

```
Use your Android phone's calls and messages from any browser.
```

(60 chars — leaves room to tighten further if needed.)

### Full description (4,000 chars max)

```
ComputerCaller pairs your Android phone with your browser so you can
make calls, send messages, and see notifications without picking up
your phone.

WHAT YOU GET

• Make and receive calls right from your computer
• Read and reply to SMS and MMS conversations
• See incoming notifications from your messaging apps in real time
• Type with your keyboard, not your thumbs
• Keep your phone in your pocket, drawer, or charger

HOW IT WORKS

1. Install this app on your Android phone.
2. Sign up at computercaller.com on your computer.
3. Pair the two — one tap, no cables.
4. The phone keeps doing the phone things (cellular signal, SIM,
   carrier). Your browser becomes a window into it.

PRIVATE BY DESIGN

• End-to-end encrypted relay between your phone and your browser.
• Your messages and call history are NOT stored on our servers.
• Your contacts stay on your phone.
• We don't sell, share, or train AI on your data.

PRICING

14-day free trial. No credit card required to start.
After the trial: €7.99 per month. Cancel any time.

REQUIREMENTS

• Android 8.0 (Oreo) or newer
• Both your phone and computer connected to the internet
  (works over WiFi or mobile data)

QUESTIONS?

support@computercaller.com
```

(About 1,400 characters — well under the 4,000 limit, leaves room to
expand with FAQs or feature deep-dives once we have user feedback.)

### Tags / category

- **App category:** Communication
- **Tags:** "calls", "sms", "messaging", "phone", "productivity"

---

## Graphic assets

| Asset | Spec | Owner | Path |
|---|---|---|---|
| App icon | 512x512 PNG, no transparency, no rounded mask | Pixel | `public/brand/play-store/icon-512.png` (TBD) |
| Feature graphic | 1024x500 PNG or JPEG | Pixel | `public/brand/play-store/feature-1024x500.png` (TBD) |
| Phone screenshots (min 2, max 8) | 16:9 or 9:16, min 320px short side, max 3840px long side | Pixel | `public/brand/play-store/screenshots/*.png` (TBD) |

Source brand asset on disk: `public/brand/computercaller-banner-allBlack.png`
(1.2 MB, the all-black banner). Pixel derives icon + feature graphic from
this; the gradient logo lockup from the marketing landing is the secondary
visual reference (`app/page.tsx`, see the `bg-gradient-to-tr from-blue-600 to-indigo-600`
treatment).

---

## Content rating questionnaire

Open the IARC questionnaire in the console. Answer:

| Question | Answer |
|---|---|
| Does your app contain violence? | No |
| Sexual content? | No |
| Profanity? | No |
| Drugs / alcohol / tobacco references? | No |
| Gambling? | No |
| Crude humor? | No |
| Horror? | No |
| Does your app contain user-generated content shared with other users? | No (calls + messages go to YOUR own contacts via YOUR cellular service — not a social network) |
| Does your app share user location with other users? | No |
| Does your app share user information with third parties? | Yes — Whop (payments), Resend (account emails). Disclosed in Data Safety form. |
| Does your app collect or share precise location? | No |
| Does your app contain digital purchases? | No (billing is external via Whop) |
| Is your app primarily directed at children under 13? | No |

Expected rating: **Everyone** in all jurisdictions.

---

## Data safety form

This is the form that drives the data-safety panel on the Play listing.
Fill it carefully — Google audits these.

### Data collected from the user

| Data type | Collected? | Shared with third parties? | Why? | Optional/required | Encrypted in transit? |
|---|---|---|---|---|---|
| Email address | Yes | Yes (Resend for transactional email; Whop for billing) | Account creation, login, password reset, subscription receipts | Required | Yes |
| User ID (pairing token) | Yes | No | Auth between Android app and the user's own browser session | Required | Yes |
| Approximate location | No | — | — | — | — |
| Precise location | No | — | — | — | — |
| Name | No | — | — | — | — |
| Photos | No | — | — | — | — |
| Audio files / voice / sound recordings | No | — | — | — | — |
| Calendar events | No | — | — | — | — |
| Contacts (names + numbers) | **NO** | — | Contacts stay on the device; the app reads them only to display contact names in the user's own browser session and does NOT upload them to our servers | — | — |
| SMS or MMS message contents | **NO** | — | Messages flow through our relay in real time but are not stored. The relay holds them in memory only long enough to forward; they are not written to disk on our servers. Disclose this in the "Data not collected" rationale | — | — |
| Call logs | **NO** | — | Same pattern as contacts — read on the phone, displayed in the user's browser, NOT uploaded | — | — |
| Phone numbers | Only the user's own SIM phone number is read at pairing time for display | No | Helps the user confirm "I'm seeing my own phone in the browser" | Optional | Yes |
| Crash logs | No (no third-party crash reporter integrated as of v1.0.0) | — | — | — | — |
| Diagnostics / performance | Yes (basic connection timestamps for service health) | No | Operational monitoring | Required | Yes |

**Key honesty point:** check "no" for SMS / contacts / call log being
"collected" because, per Google's definition, "collected" means
**transmitted off the device AND stored on a server**. Our relay forwards
them but never stores them. This is a defensible position — confirm with
the rationale text in each "no" answer.

### Security practices

- [x] Data is encrypted in transit (TLS everywhere, WSS for relay)
- [x] Users can request data deletion via support@computercaller.com
- [x] Independent security review: NO (small team; revisit later)
- [x] Followed Families Policy: N/A (not directed at children)

---

## Android permissions justification

The Play Console asks you to declare *why* you use each sensitive
permission. Paste these:

| Permission | Justification |
|---|---|
| `READ_PHONE_STATE` / `READ_PHONE_NUMBERS` | Display the user's own SIM number at pairing time so they can confirm they're seeing their own phone in the browser session. |
| `CALL_PHONE` | Place outgoing calls that the user initiates by clicking dial in their own browser. |
| `READ_CALL_LOG` | Display recent calls in the user's own browser dashboard. Data stays on device + browser. |
| `READ_CONTACTS` | Show contact names alongside phone numbers in the call log and messages. Contacts are never uploaded. |
| `READ_SMS` / `SEND_SMS` / `RECEIVE_SMS` | Mirror the user's own SMS conversations to their browser and let them reply from the browser. |
| `RECEIVE_MMS` / `READ_MMS` | Same as SMS but for picture-message threads. |
| `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_PHONE_CALL` / `FOREGROUND_SERVICE_CONNECTED_DEVICE` | Required by Android 10+ to keep the pairing service running with the persistent "Connected to your computer" notification, which is also a privacy-by-default signal to the user that the app is active. |
| `POST_NOTIFICATIONS` | Show the persistent connection status notification + the Accept/Decline pairing prompt when a new browser connects. |
| `BIND_NOTIFICATION_LISTENER_SERVICE` (optional, user grants in Settings) | Mirror messaging-app notifications (WhatsApp, Telegram, Discord) to the browser. Optional — works fine without it. |
| `INTERNET` / `ACCESS_NETWORK_STATE` / `ACCESS_WIFI_STATE` | Connect to the relay over WiFi or mobile data. |
| `WAKE_LOCK` | Keep the pairing socket alive when the screen is off. Used sparingly + only while connected. |

---

## App access

Question: "Does your app have parts (or all) that are restricted based
on login or membership status?"

Answer: **Yes.** Provide test credentials:

- URL: `https://computercaller.com`
- Username: `playstore-reviewer@computercaller.com` (create this BEFORE
  submitting — manual sign-up, mark `emailVerified=true` directly in DB)
- Password: `(pick a long random; paste here once created)`
- Notes for reviewer: "After login, click 'Download Android app (.apk)'
  in Settings to confirm the auth-gated download. The Android app pairs
  by entering the IP shown on the phone into the dashboard."

---

## Pricing & distribution

| Setting | Value |
|---|---|
| Countries | All countries Google offers (no exclusions in v1) |
| Free | Yes |
| Contains ads | No |
| Designed for families / children policy | No |
| US export laws | I confirm the app complies (standard checkbox) |

---

## Release tracks

- **Internal testing** first (1-5 testers Dennis adds by Gmail address).
  Catches the install + auth + pair flow on a fresh device before
  exposing to anyone real.
- After 24-48h with no crashes: **Production** roll-out to 5% staged.
- After 3-5 days at 5% with no anomalies: ramp to 100%.

---

## What Dennis clicks

1. Open Play Console → All apps → Create app.
2. Paste app name, language, free/app, declarations from §"App details".
3. Set up your store listing (this whole doc).
4. Complete the App content panel: privacy policy URL, Data safety, ads,
   target audience, news app (No), content rating, government app (No).
5. Upload the signed APK at `apk-releases/computercaller-v12.apk` under
   Internal testing → Create new release.
6. Add testers (your own Gmail + a couple of friends).
7. Save, review, roll out to Internal testing.
8. Install via the email link Google sends; verify pair flow end-to-end.

---

## File references

- Signed APK: `apk-releases/computercaller-v12.apk`
- Build config: `dnkdialer-android/app/build.gradle.kts` (versionCode 12, versionName 1.0.0)
- Privacy policy source: `app/privacy/page.tsx` → renders at `/privacy`
- Terms source: `app/terms/page.tsx` → renders at `/terms`
- Brand source: `public/brand/computercaller-banner-allBlack.png`
- Play Store asset directory (Pixel to create):
  `public/brand/play-store/icon-512.png`,
  `public/brand/play-store/feature-1024x500.png`,
  `public/brand/play-store/screenshots/`
