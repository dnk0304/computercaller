---
title: "Call and Text From Your OnePlus Phone With Your Computer (OxygenOS Setup)"
description: "Use your OnePlus calls and texts from any computer browser. ComputerCaller setup + the OxygenOS battery and auto-launch settings that keep sync alive."
slug: "call-from-oneplus-phone-with-computer"
date: "2026-07-10"
keywords: ["call from oneplus phone with computer", "text from oneplus on pc", "oxygenos battery optimization kills apps", "oneplus allow background activity"]
---

# Call and Text From Your OnePlus Phone With Your Computer

ComputerCaller puts your OnePlus phone's calls and texts in any computer browser — real number, real SIM, phone untouched in your pocket. Setup: 3 minutes. One thing OnePlus veterans already suspect: since OxygenOS merged with OPPO's ColorOS codebase (OxygenOS 12 and later), OnePlus phones inherited ColorOS's aggressive background-app killer. The standard Android battery exemption is not enough on a modern OnePlus — you need "Allow background activity" and auto-launch too. Exact paths below; we test on this software family ourselves, so these are the settings that actually work, not guesses.

## Will it work on my OnePlus?

- Any OnePlus with Google Play and Android 8+ — numbered flagships, R-series, Nord.
- **OxygenOS 11 or older** (OnePlus 8 era and earlier): closer to stock Android, gentler killer — you may only need the standard exemption. **OxygenOS 12+**: assume ColorOS rules and do all of step 4.
- The SIM must be in the OnePlus — calls and texts go out on your number.

## Step 1: Install the companion app

1. From Google Play, install [DNK Dialer Companion](https://play.google.com/store/apps/details?id=com.dnkdialer.companion).
2. Open it and **sign in with Google** — the same account you'll use on the computer.

## Step 2: Permissions, in the order the app asks

1. **Notifications** — first, so you can see connection status.
2. **Phone and SMS** — the app's whole job.
3. **Contacts** — names in the browser.
4. **Battery (ignore optimizations)** — last. Accept it. On OxygenOS 12+ the app follows up with a hint pointing at the extra settings in step 4 — that hint exists because on this software the standard exemption alone doesn't hold.

## Step 3: Pair at computercaller.com

1. Open **[computercaller.com](https://computercaller.com)** on the computer — any browser, any OS.
2. Sign in with the **same Google account**, follow the pairing prompt.
3. Connected → your OnePlus calls and texts are live in the tab.

## Step 4: OxygenOS keep-alive settings

**1. Allow background activity:**

- Settings → **Apps** → **App management** → **DNK Dialer Companion** → **Battery usage**
- Enable **Allow background activity** (enable "Allow foreground activity"/"Don't optimize" too where your version shows them)

**2. Auto-launch:**

- Same app page → enable **Auto-launch**
- This is what lets the app restart itself after OxygenOS kills the process. Skip it and the first kill ends your sync until you manually reopen the app.

**3. (Older OxygenOS 11 and earlier)** Settings → Battery → Battery optimization → DNK Dialer Companion → **Don't optimize** — usually sufficient on its own there.

## Sync stopped? The OnePlus checklist

- **Both step 4 toggles still on?** System updates have reset battery choices before — re-check after every OTA.
- **Battery saver:** OnePlus power-saving modes suspend background apps regardless. Reopen the companion app after heavy battery-saver use.
- **"Clear all" in recents:** on OxygenOS 12+ this can kill exempted apps too. Leave the companion app's card alone, or lock it (long-press the card → Lock).
- **Deep optimization / Phone Manager cleanups:** add the app to any allowed/protected list your version offers.
- **Fastest fix:** open the companion app once — it reconnects on launch.

Menus differ between OxygenOS 12, 13, 14 and regions; if a path doesn't match, search "auto-launch" or "battery usage" in Settings.

## OnePlus FAQ

**My old OnePlus never killed apps — why does my new one?** The OxygenOS/ColorOS merger. Your memory is correct; the software changed underneath you.

**Battery impact?** Minimal — the companion app idles in the background.

**Price?** ComputerCaller is $5 USD/month with a 7-day free trial — long enough to verify the OxygenOS settings hold before you pay. The app download is free.

Have an OPPO or Realme in the family? Same software base, slightly different menus: [OPPO guide](/guides/call-from-oppo-phone-with-computer), [Realme guide](/guides/call-from-realme-phone-with-computer).

**Related guides:**
- [How to text from your computer](/guides/how-to-text-from-computer)
- [6 best ways to call from your computer](/guides/best-ways-to-call-from-computer)
