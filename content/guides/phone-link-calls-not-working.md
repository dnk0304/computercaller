---
title: "Phone Link Calls Not Working? 8 Fixes That Actually Help (2026)"
description: "Phone Link calls not working, ringing but not answering, or choppy? Work through these 8 real fixes — Bluetooth, pairing, permissions — in order."
slug: "phone-link-calls-not-working"
date: "2026-07-06"
keywords: ["phone link calls not working", "phone link can't make calls", "phone link call audio", "phone link not answering calls"]
---

# Phone Link Calls Not Working? 8 Fixes That Actually Help

Microsoft Phone Link's calling feature breaks in a handful of predictable ways: calls won't set up at all, calls ring on the PC but can't be answered there, audio is choppy or one-sided, or the phone shows as "connected" while calls insist it isn't.

Almost all of these trace back to one root cause: **unlike messaging, Phone Link routes calls over a Bluetooth connection between your phone and PC** — and that Bluetooth link is the fragile part. The fixes below attack it in order, from fastest to most drastic. Work down the list; most people are fixed by step 4 or 5.

## Fix 1: Restart Bluetooth on both devices

Cheap and surprisingly effective, because the problem is often a stale Bluetooth session.

1. On the PC: Settings → Bluetooth & devices → toggle Bluetooth **off**, wait 10 seconds, back **on**.
2. On the phone: same — Bluetooth off, wait, on.
3. Close and reopen Phone Link, then try a test call.

If calls work now but the problem returns every few days, that's typical — Bluetooth session rot is chronic with Phone Link. Keep the rest of this list handy.

## Fix 2: Check the call permissions on your phone

Calls fail silently if the Link to Windows app has lost permissions (Android revokes them from unused apps by default).

1. On the phone: Settings → Apps → **Link to Windows**.
2. Open **Permissions** and confirm **Phone** and **Contacts** are allowed.
3. Also check Settings → Apps → Link to Windows → make sure **"Pause app activity if unused"** (or "Remove permissions if app is unused") is **off**.
4. In Phone Link on the PC, go to the Calls tab and re-grant anything it asks for.

## Fix 3: Set up calling again inside Phone Link

Phone Link treats calling as a separate setup step from messaging, and it can lose it independently.

1. In Phone Link: **Settings → Features → Calls** (or the Calls tab if it shows a setup prompt).
2. Click **Set up** / **Manage devices** and accept the Bluetooth pairing request that appears on the phone.
3. Confirm the PIN matches on both screens.

If the pairing request never arrives on the phone, or Phone Link says your phone is already paired when it isn't, go to Fix 4 — you have a ghost pairing.

## Fix 4: Remove the ghost Bluetooth pairing (the big one)

The most common serious failure: old, half-dead pairings confuse both devices. Clear them completely on **both sides**.

1. On the PC: Settings → Bluetooth & devices → Devices → find your phone → **Remove device**.
2. On the phone: Bluetooth settings → find your PC → **Forget**.
3. Restart both devices. (Yes, actually restart — the Bluetooth stack caches pairings in memory.)
4. Reopen Phone Link and run call setup again (Fix 3) so a fresh pairing is created.

## Fix 5: Fix choppy or one-sided call audio

If calls connect but sound terrible, the audio is being mangled on the Bluetooth path.

1. On the PC: Settings → System → Sound → make sure the phone's **Hands-Free** device is the default for calls, not your speakers pretending to be a headset.
2. Disconnect other Bluetooth audio devices (headphones, speakers) during a test call — multiple simultaneous Bluetooth audio streams are a classic cause of choppiness.
3. Move the phone physically closer to the PC and away from USB 3.0 hubs and Wi-Fi routers (2.4 GHz interference is real).
4. Update the PC's Bluetooth driver: Device Manager → Bluetooth → your adapter → Update driver, or better, get it from the laptop manufacturer's site.

## Fix 6: Update everything

Phone Link breaks after updates — and gets fixed by them — regularly.

1. Update **Phone Link** and **Link to Windows** (Microsoft Store on PC, Play Store on phone).
2. Install pending **Windows updates**, including optional driver updates.
3. Check for an Android system update on the phone.

## Fix 7: Unlink the phone and start over

The scorched-earth option inside the app:

1. In Phone Link: Settings → My devices → remove your phone.
2. On the phone: open Link to Windows → sign out / unlink, and clear the app's storage (Settings → Apps → Link to Windows → Storage → Clear data).
3. Remove the Bluetooth pairings on both sides (Fix 4) if you haven't already.
4. Set the whole connection up again from scratch, including call setup.

This takes 10–15 minutes and resolves most of what the earlier fixes don't.

## Fix 8: Check whether a recent update broke it for everyone

Sometimes it isn't you. Phone Link has shipped updates that broke calling outright for large numbers of users (a .NET-related update in 2025 was a notable one). Search "[phone link calls] site:learn.microsoft.com" with the current month, or check r/PhoneLink on Reddit — if the same failure appeared for many people in the last week, your only real options are waiting for the patch or using something else in the meantime.

## If you're done fighting it

A fair question at this point: how many times have you run this list?

Phone Link is free, and when it works it's good — but its calling feature is structurally tied to Bluetooth pairing, which is why the same failures keep coming back. If your calls matter enough that "re-pair everything again" is costing you real time, there's a different architecture worth knowing about.

**ComputerCaller** (our product) does the same job — calls and SMS from your computer, on your own number — without Bluetooth anywhere in the chain. A small companion app on your Android phone connects to your browser over the internet: setup is just signing in with your email and tapping Connect, it reconnects itself, and it works on any OS, including the Macs, Linux machines, and Chromebooks Phone Link doesn't support. Your phone stays in your pocket; you handle everything from a browser tab. It's $5/month with a [7-day free trial](/) — enough time to find out whether a week without pairing loops is worth it to you.

And if fix #4 got Phone Link working again — genuinely, great. Bookmark this page for next time.

**Related guides:**
- [ComputerCaller vs Phone Link: honest comparison](/guides/computercaller-vs-phone-link)
- [6 best ways to call from your computer](/guides/best-ways-to-call-from-computer)
