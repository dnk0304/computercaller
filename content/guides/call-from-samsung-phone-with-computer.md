---
title: "Call and Text From Your Samsung Phone With Your Computer (One UI Setup)"
description: "Make calls and send texts from your Samsung Galaxy using any computer browser. 3-minute ComputerCaller setup + the One UI battery settings that keep it alive."
slug: "call-from-samsung-phone-with-computer"
date: "2026-07-10"
keywords: ["call from samsung phone with computer", "text from samsung on pc", "samsung galaxy calls from computer", "one ui sleeping apps"]
---

# Call and Text From Your Samsung Phone With Your Computer

You can run your Samsung Galaxy's calls and texts from any computer browser — your own number, your own SIM, phone in your pocket. The setup with ComputerCaller takes about 3 minutes: install the companion app from Google Play, sign in with Google, grant permissions, open computercaller.com, pair. On a Samsung there's one extra job: two One UI battery settings that stop Samsung from putting the app to sleep. This guide covers all of it, exact menu paths included.

## Will this work on my Galaxy?

**S-series, A-series, Z Fold/Flip, Note:** yes — anything running Android 8 or newer. Samsung is the most common phone among ComputerCaller users.

**Company phone with a work profile:** usually, but IT admins can block SMS permissions. If a toggle is greyed out, that's the admin, not you.

**Galaxy Tab without a SIM:** no — calls and texts go through your real number, so the app must live on the phone with the SIM.

## Step 1: Install the companion app

1. On the Galaxy, install [DNK Dialer Companion](https://play.google.com/store/apps/details?id=com.dnkdialer.companion) from Google Play — that's ComputerCaller's phone-side app.
2. Open it and **sign in with Google**. Use the account you'll also sign in with on the computer — that's how the two ends find each other.

## Step 2: Grant permissions in the order the app asks

Notifications first, battery last — just approve them as they come:

1. **Notifications** — so you can see the app is running and connected.
2. **Phone and SMS** — the point of the whole thing: placing calls and sending texts on your number.
3. **Contacts** — names instead of raw numbers in your browser.
4. **Battery (ignore optimizations)** — asked last. Accept it. This handles stock Android's battery manager. Samsung adds its own layer on top — that's step 4 below.

## Step 3: Open computercaller.com and pair

1. On the computer, open **[computercaller.com](https://computercaller.com)** — any browser, any OS (Windows, Mac, Linux, Chromebook).
2. Sign in with the **same Google account**.
3. Follow the pairing prompt. When the app shows connected, your calls and messages are live in the browser tab.

## Step 4: The two One UI settings that keep it running

One UI has its own app-sleeping system, and by default it will eventually put the companion app to sleep — and a sleeping app can't sync. Two minutes of settings:

**1. Put the app on the never-sleep list:**

- Settings → **Battery** (or Battery and device care → Battery) → **Background usage limits**
- Check **Sleeping apps** and **Deep sleeping apps** — remove DNK Dialer Companion if it's there
- Add it to **Never auto sleeping apps**. On Samsung, this is the setting that matters most.

**2. Set battery mode to Unrestricted:**

- Settings → **Apps** → **DNK Dialer Companion** → **Battery** → **Unrestricted**

Menu names shift a bit between One UI 5, 6 and 7 — if a path doesn't match word for word, type "sleeping apps" into the Settings search bar and Samsung will take you straight there.

## Sync stopped after a few days? Samsung's app-killer checklist

If it worked and then quietly went dead, One UI put the app to sleep anyway. Top to bottom:

- **Sleeping list again:** One UI can re-add apps after updates. Confirm the app is still in "Never auto sleeping apps."
- **"Put unused apps to sleep":** Settings → Battery → Adaptive battery section. Since you never open the companion app on the phone (that's the point!), One UI may flag it as unused. Turn this toggle off if the problem keeps returning.
- **Permission auto-revoke:** Settings → Apps → DNK Dialer Companion → make sure "Pause app activity if unused" is **off** — Android silently pulling the SMS permission looks exactly like broken sync.
- **After a One UI update:** big updates can reset battery settings; re-run step 4.
- **Quick fix right now:** open the companion app once on the phone — it reconnects on launch.

## Samsung FAQ

**Does the phone screen need to be on?** No — locked in your pocket is fine, it just needs internet.

**Does it drain the battery?** The app idles in the background; on a Galaxy the drain is small. (Ironically, that low activity is why One UI thinks it's safe to kill.)

**What does it cost?** ComputerCaller is $5 USD/month with a 7-day free trial — enough time to see the One UI settings hold before you pay anything. The companion app download is free.

**Is this the same as Samsung's own Link to Windows / Phone Link?** No — Phone Link needs a Windows PC and a Bluetooth pairing for calls. ComputerCaller works over the internet in any browser on any OS. [Full comparison here](/guides/computercaller-vs-phone-link).

**Related guides:**
- [How to text from your computer](/guides/how-to-text-from-computer)
- [How to make a phone call from your computer](/guides/how-to-make-a-phone-call-from-computer)
