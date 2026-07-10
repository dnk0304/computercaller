---
title: "Call and Text From Your POCO Phone With Your Computer (Setup Guide)"
description: "Control your POCO's calls and texts from any computer browser. ComputerCaller setup + the HyperOS/MIUI autostart and Game Turbo settings POCO owners need."
slug: "call-from-poco-phone-with-computer"
date: "2026-07-10"
keywords: ["call from poco phone with computer", "text from poco on pc", "poco background app killed", "poco autostart battery saver"]
---

# Call and Text From Your POCO Phone With Your Computer

POCO phones are built for performance-per-dollar, and part of how they feel fast is ruthless background management: POCO's MIUI/HyperOS build kills idle apps without asking. That matters here, because ComputerCaller — which puts your POCO's calls and texts in any computer browser, on your own number — depends on a small companion app staying alive in the background. The setup takes 3 minutes; making it *stay* connected takes three specific toggles. Both below.

## Checklist before you start

- Any POCO with Google Play and Android 8+ (X-series, F-series, M-series; MIUI for POCO or HyperOS).
- The SIM must be in the POCO — everything goes out on your real number.
- Gamer? Note the Game Turbo point in the troubleshooting section — it's POCO-specific.

## Step 1: Install the companion app

1. From Google Play, install [DNK Dialer Companion](https://play.google.com/store/apps/details?id=com.dnkdialer.companion).
2. Open it and **sign in with Google** — same account as you'll use on the computer.

## Step 2: Permissions, in the order the app asks

1. **Notifications** — first, so you always see connection status.
2. **Phone and SMS** — the core job. POCO's software shows an extra confirmation for SMS access — approve it too.
3. **Contacts** — names, not numbers, in the browser.
4. **Battery exemption** — last. Accept, then do step 4 anyway: on POCO, the standard exemption alone does not stop the killer.

## Step 3: Pair at computercaller.com

1. On the computer: **[computercaller.com](https://computercaller.com)**, any browser, any OS.
2. Sign in with the **same Google account**, follow the pairing prompt.
3. Connected? Your POCO's calls and texts are now in a browser tab.

## Step 4: The three keep-alive toggles

**1. Autostart on:**

- Settings → **Apps** → **Manage apps** → **DNK Dialer Companion** → **Autostart** on
- Non-negotiable. Without it the app can't restart after POCO's memory manager kills it.

**2. Battery saver → No restrictions:**

- Same app page → **Battery saver** → **No restrictions**

**3. Lock in recents:**

- Open the app, open recents, pull its card down until the padlock shows (or long-press → lock). Locked cards survive "clear all."

## Sync stopped? The POCO checklist

- **Autostart after updates:** MIUI/HyperOS updates occasionally reset it — first thing to re-check.
- **Game Turbo:** POCO's gaming mode restricts background activity while you play. Long sessions can starve the companion app; if sync lags during gaming, open Game Turbo settings and relax background limits, or accept that sync catches up after the session.
- **Security app cleaner:** the built-in "Boost speed" kills background apps. Add DNK Dialer Companion to its exceptions (Security app → Boost speed → settings).
- **Battery Saver / Ultra Battery Saver:** both freeze background apps wholesale — reopen the companion app after using them.
- **Instant fix:** open the companion app once — it reconnects on launch.

Fair warning: POCO ships different MIUI/HyperOS builds by region and model, so a menu name here or there may differ on yours. The Settings search bar ("autostart", "battery saver") finds the real location on every build we've seen — and if in doubt, the companion app's own setup screen flags what's missing.

## POCO FAQ

**Does it slow the phone down?** No — the app idles. POCO kills it because it's idle, not because it's heavy.

**Xiaomi and Redmi guides look similar — same thing?** Same software family, different menu details and defaults: [Xiaomi guide](/guides/call-from-xiaomi-phone-with-computer), [Redmi guide](/guides/call-from-redmi-phone-with-computer).

**Cost?** ComputerCaller is $5 USD/month with a 7-day free trial — test that the keep-alive toggles hold on your POCO for a week before paying. The companion app is free.

**Related guides:**
- [How to text from your computer](/guides/how-to-text-from-computer)
- [6 best ways to call from your computer](/guides/best-ways-to-call-from-computer)
