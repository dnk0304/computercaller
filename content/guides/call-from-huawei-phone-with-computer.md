---
title: "Call and Text From Your Huawei Phone With Your Computer (Honest Guide)"
description: "Can your Huawei's calls and texts run from a computer browser? Yes on Google-service Huaweis, no on newer HMS-only models — the honest breakdown + full setup."
slug: "call-from-huawei-phone-with-computer"
date: "2026-07-10"
keywords: ["call from huawei phone with computer", "text from huawei on pc", "huawei google services app", "emui app launch background"]
---

# Call and Text From Your Huawei Phone With Your Computer

Straight answer first, because Huawei owners deserve one: **it depends on which Huawei you have.** ComputerCaller signs you in with Google and installs from Google Play — so it works on Huawei phones that have Google services (roughly the P30/Mate 20 generation and everything before the 2019 US sanctions), and it does **not** work on the newer HMS-only models (P40 and later, anything running HarmonyOS with AppGallery instead of Play Store). We'd rather tell you that in the first paragraph than after you've read the whole guide.

## Which group is your phone in? 30-second check

Open your app drawer and look for the **Google Play Store**:

- **Play Store is there and working** (P30, P30 Pro, Mate 20, P20, P smart and older): you're in the supported group — the full setup below applies.
- **No Play Store, only AppGallery** (P40, P50, P60, Mate 30 and later, nova 8+): ComputerCaller can't run on this phone today. The companion app needs both Google Play and Google sign-in, and workarounds like sideloading with unofficial Google-service layers are fragile — we don't recommend or support them. If you also own any other Android (even an old one in a drawer) with your SIM in it, that phone can be the bridge instead.

Have an Honor? Post-split Honors ship *with* Google services — see the [Honor guide](/guides/call-from-honor-phone-with-computer).

## Setup for Google-service Huaweis (P30 generation and older)

### Step 1: Install the companion app

1. From Google Play, install [DNK Dialer Companion](https://play.google.com/store/apps/details?id=com.dnkdialer.companion).
2. Open it and **sign in with Google** — the same account you'll use in the browser.

### Step 2: Permissions, in the order the app asks

1. **Notifications** — first; shows the connection is alive.
2. **Phone and SMS** — the core: calls and texts on your number. The SIM must be in this phone.
3. **Contacts** — names in the browser.
4. **Battery (ignore optimizations)** — last. Accept, then do step 4 — EMUI keeps its own launch manager on top.

### Step 3: Pair at computercaller.com

1. On the computer, open **[computercaller.com](https://computercaller.com)** — any browser, any OS.
2. Sign in with the **same Google account**, follow the pairing prompt.
3. Connected → your Huawei's calls and texts are in the browser tab.

### Step 4: EMUI App launch — the Huawei keep-alive setting

EMUI pioneered aggressive background management; on these older models it's still very much active:

1. Settings → **Battery** → **App launch**
2. Find **DNK Dialer Companion** → switch from *Manage automatically* to **Manage manually**
3. Enable all three: **Auto-launch**, **Secondary launch**, **Run in background**

All three. "Run in background" keeps the app alive; the launch toggles let it recover after EMUI kills the process.

## Sync stopped? The Huawei checklist

- **App launch reset:** re-check step 4 after any system update — EMUI likes flipping apps back to automatic.
- **Power saving / Ultra power saving:** both suspend background apps. Reopen the companion app afterwards.
- **Phone Manager cleanups:** add the app to the protected list in Huawei's Phone Manager (Optimizer) so cleanup sweeps skip it.
- **These are older phones:** batteries age; if the phone aggressively throttles when the battery is low, sync gets flaky at low charge. Nothing app-side fixes chemistry.
- **Quick fix:** open the companion app once — it reconnects on launch.

## Huawei FAQ

**Will HMS-only Huawei support come?** Not on the current roadmap — the app is built on Google sign-in and Play distribution, and we'd rather be honest about that than promise a maybe.

**My P30 works — for how long?** As long as it gets Play Store apps and has internet, it works. The P30 generation remains fully usable for this.

**Price?** ComputerCaller is $5 USD/month with a 7-day free trial — so you can confirm it runs well on your older Huawei before paying anything. The companion app is free to install.

**Related guides:**
- [Call from your Honor phone with your computer](/guides/call-from-honor-phone-with-computer)
- [How to text from your computer](/guides/how-to-text-from-computer)
