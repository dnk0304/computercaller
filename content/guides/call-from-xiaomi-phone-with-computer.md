---
title: "Call and Text From Your Xiaomi Phone With Your Computer (MIUI/HyperOS Setup)"
description: "Run your Xiaomi's calls and texts from any computer browser. ComputerCaller setup plus the Autostart and battery settings MIUI/HyperOS demands — honestly explained."
slug: "call-from-xiaomi-phone-with-computer"
date: "2026-07-10"
keywords: ["call from xiaomi phone with computer", "text from xiaomi on pc", "miui autostart app killed", "hyperos background app settings"]
---

# Call and Text From Your Xiaomi Phone With Your Computer

Yes, your Xiaomi can hand its calls and texts to any computer browser — your own number, phone in your pocket. The ComputerCaller setup itself is 3 minutes: install the companion app, sign in with Google, grant permissions, pair at computercaller.com. But let's be honest with each other up front: **MIUI and HyperOS are the most aggressive background-app killers on Android.** Xiaomi's software will kill the companion app unless you flip three specific settings. This guide gives you the setup *and* those three settings — skip them and sync will die within hours, not days.

## Before you start

- Works on any Xiaomi with Google Play and Android 8+ — Mi and Xiaomi numbered series, running MIUI 12/13/14 or HyperOS.
- The SIM must be in this phone — calls and texts go out on your real number.
- Have a Redmi or POCO? Same software family, but the menus differ slightly — we have dedicated guides for [Redmi](/guides/call-from-redmi-phone-with-computer) and [POCO](/guides/call-from-poco-phone-with-computer).

## Step 1: Install the companion app

1. Install [DNK Dialer Companion](https://play.google.com/store/apps/details?id=com.dnkdialer.companion) from Google Play.
2. Open it and **sign in with Google** — the same account you'll use in the browser.

## Step 2: Grant permissions in the order the app asks

Notifications first, battery last:

1. **Notifications** — connection status.
2. **Phone and SMS** — the core: calls and texts on your number. MIUI shows its own extra confirmation dialog for SMS — approve that too.
3. **Contacts** — names in your browser.
4. **Battery (ignore optimizations)** — asked last. Accept it, but know this only covers *stock* Android's battery manager. Xiaomi's own killer is separate — that's step 4.

## Step 3: Pair at computercaller.com

1. On the computer, open **[computercaller.com](https://computercaller.com)** — any browser, any OS.
2. Sign in with the **same Google account** and follow the pairing prompt.
3. When the app shows connected, you're live.

## Step 4: The three Xiaomi settings that decide everything

This is the part that separates "works for an hour" from "works for months." All three, not two:

**1. Autostart — the big one:**

- Settings → **Apps** → **Manage apps** → **DNK Dialer Companion** → enable **Autostart**
- Without this, MIUI/HyperOS won't let the app come back after the system kills it. This single toggle is the most common fix for dead sync on Xiaomi.

**2. Battery saver — No restrictions:**

- Same app page → **Battery saver** → choose **No restrictions**

**3. Lock the app in recents:**

- Open the companion app, tap the recents button, find the app card, **pull it down** (or long-press → padlock icon) so a lock appears
- A locked card survives "clear all" and gets gentler treatment from the killer.

## Sync keeps dying? The Xiaomi app-killer checklist

If sync stops anyway — and on Xiaomi it can — go through this list in order:

- **Autostart got reset:** MIUI/HyperOS updates sometimes reset Autostart. Check it first, every time.
- **Battery Saver / Ultra Battery Saver on:** both suspend background apps wholesale. If you use them daily, expect to reopen the companion app after each session.
- **Security app "Boost speed" / cleaner:** Xiaomi's Security app kills background apps when you run a boost. Open Security → Boost speed → settings → add DNK Dialer Companion to the exceptions list.
- **MIUI Optimization:** on a few MIUI versions, Settings → Additional settings → Developer options → "MIUI optimization" interferes with background services. Only relevant if you have developer options on — most people can ignore this.
- **Quick fix right now:** open the companion app on the phone; it reconnects on launch.

We'll be straight with you: exact menu names vary between MIUI 13, MIUI 14 and HyperOS, and between regions. If a path doesn't match, search "autostart" in the Settings search — it exists on every version, sometimes under App management.

## Xiaomi FAQ

**Is this fighting worth it?** Once the three settings are set, yes — it runs quietly for months. The pain is a one-time cost.

**Battery drain?** Small. The app idles; the irony is that MIUI kills it *because* it's quiet.

**Cost?** ComputerCaller is $5 USD/month with a 7-day free trial — test it against MIUI's killer for a week before paying anything. The app is a free download.

**Related guides:**
- [Call from your Redmi phone with your computer](/guides/call-from-redmi-phone-with-computer)
- [How to text from your computer](/guides/how-to-text-from-computer)
