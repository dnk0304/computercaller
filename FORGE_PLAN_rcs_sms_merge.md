# FORGE_PLAN — RCS↔SMS thread merge (ComputerCaller v41 sideload)

## Goal
Inbound (and sent) RCS messages from number X must merge into the SAME conversation thread
as SMS from X. Today RCS only reaches the notification strip (`phoneNotifications`), never the
SMS `messages` store, because it never gets a canonical phone-number thread key. Fix: resolve
the RCS sender → canonical number on Android, synthesize an `SMS_RECEIVED` frame keyed on that
number, and suppress the duplicate notification card when conversion succeeds.

## Architecture (current → fixed)
- Pipeline A (SMS): SmsReceiver → SMS_RECEIVED{from=number} → messages store → grouped by normalizeNumber. WORKS.
- Pipeline B (RCS): notif listener → PHONE_NOTIFICATION → phoneNotifications strip. BROKEN (separate structure).
- Fix: notif listener surfaces Person `tel:` URI → PhoneService resolves number (a→d) → SMS_RECEIVED{from=number, source:"rcs"} → merges into Pipeline A. Suppress PHONE_NOTIFICATION on success.

## Number-resolution priority chain (Layer 1)
- (a) MessagingStyle Person URI — EXTRA_MESSAGES last message → `Person.uri` of form `tel:+47…`. Strip `tel:`.
- (b) title is a number — digits(title) ≥ 7 → use title.
- (c) Contacts reverse-lookup by name — existing `resolveContactNumber(title)` via ContactsContract.
- (d) Fallback — no number resolves → keep PHONE_NOTIFICATION only (do NOT inject a name-keyed SMS row).

## Task Breakdown
- TASK-001 NotificationListenerService — surface Person tel: URI (+senderPersonUri param). ~30 lines. SAFE.
- TASK-002 PhoneService — RCS branch resolves number (a→d), routes as SMS, suppresses card; replaces L2288 name-keyed sent-hack. ~70 lines. SAFE.
- TASK-003 versionCode 40→41 / versionName 1.0.17→1.0.18; assembleRelease; verify cert SHA-256 3FC10819…
- TASK-004 Web verify (no code change expected): tsc --noEmit 0, next build 0, eslint baseline.

## Execution order
001 → 002 (signature dependency) → 003 → 004.

## Risk flags
- Person URI present only on MessagingStyle notifs (API 28+); usually set by Google Messages. (b)/(c) cover the rest; (d) preserves old behavior.
- Web 10s content-window dedupe covers the real-SMS-row + RCS-notif overlap.
- Manifest permission set MUST NOT change (v40 Play track in flight). No new perms.
