---
title: "Call and Text From Your Honor Phone With Your Computer (MagicOS Setup)"
description: "Use your Honor phone's calls and texts from any computer browser. ComputerCaller setup + the MagicOS app-launch and battery settings that keep sync alive."
slug: "call-from-honor-phone-with-computer"
date: "2026-07-10"
keywords: ["call from honor phone with computer", "text from honor on pc", "magicos app launch management", "honor background app killed"]
---

# Call and Text From Your Honor Phone With Your Computer

Your Honor phone can hand its calls and texts to any computer browser through ComputerCaller — your own number, your own SIM. Setup takes about 3 minutes. One important note first: this guide is for **Honor phones sold after the split from Huawei** (roughly 2021 onward — Honor 50 and newer, Magic series), which ship with full Google services. Those work perfectly. If your device is an older Huawei-era Honor without Google Play, read the [Huawei guide](/guides/call-from-huawei-phone-with-computer) instead — the situation there is different.

Honor's MagicOS has its own background-app management (a leftover habit from its Huawei DNA), so after the basic setup there's one settings screen — App launch — that decides whether sync stays alive. Covered in step 4.

## Before you start

- Honor 50 / Magic series or newer with Google Play and Android 8+.
- The SIM must be in the Honor — calls and texts go out on your real number.

## Step 1: Install the companion app

1. From Google Play, install [DNK Dialer Companion](https://play.google.com/store/apps/details?id=com.dnkdialer.companion).
2. Open it and **sign in with Google** — same account you'll use on the computer.

## Step 2: Permissions, in the order the app asks

1. **Notifications** — first; your connection indicator.
2. **Phone and SMS** — the core function: calls and texts on your number.
3. **Contacts** — names in the browser.
4. **Battery (ignore optimizations)** — last. Accept it, then continue to step 4 — MagicOS keeps its own launch manager on top of the standard exemption.

## Step 3: Pair at computercaller.com

1. On the computer, open **[computercaller.com](https://computercaller.com)** — any browser, any OS.
2. Sign in with the **same Google account** and follow the pairing prompt.
3. App shows connected → calls and texts are live in the browser tab.

## Step 4: MagicOS App launch — the setting that matters on Honor

MagicOS "manages apps automatically" by default, which in practice means it decides when to kill them. Take that decision away for the companion app:

1. Settings → **Battery** → **App launch** (on some versions: Settings → Apps → App launch)
2. Find **DNK Dialer Companion** and switch it from *Manage automatically* to **Manage manually**
3. In the dialog, enable all three: **Auto-launch**, **Secondary launch**, and **Run in background**

All three, not just one — "Run in background" keeps it alive, "Auto-launch"/"Secondary launch" let it come back after a kill.

## Sync stopped? The Honor checklist

- **App launch reset:** MagicOS updates can flip apps back to "Manage automatically." Re-check step 4 after every update.
- **Power saving modes:** Power saving and Ultra power saving suspend background apps. Reopen the companion app after using them.
- **Phone Manager / cleanup:** if you run Honor's optimizer, add the app to its protected list so cleanups skip it.
- **Permission auto-revoke:** Settings → Apps → DNK Dialer Companion → make sure "Remove permissions if app is unused" is off.
- **Quick fix:** open the companion app once — it reconnects on launch.

MagicOS menu layouts vary between versions 6, 7 and 8 — if a path doesn't match your phone, search "App launch" in Settings; that screen exists on every recent Honor.

## Honor FAQ

**My Honor has no Google Play — what now?** Then it's a Huawei-era device without Google services, and the standard setup won't work. The honest details are in our [Huawei guide](/guides/call-from-huawei-phone-with-computer).

**Battery impact?** Small — the app idles in the background.

**Price?** ComputerCaller is $5 USD/month with a 7-day free trial — try it on your Honor for a week before paying anything. The companion app is free to download.

**Related guides:**
- [How to text from your computer](/guides/how-to-text-from-computer)
- [How to make a phone call from your computer](/guides/how-to-make-a-phone-call-from-computer)
