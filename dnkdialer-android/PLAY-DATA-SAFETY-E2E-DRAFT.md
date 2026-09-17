# Play Data Safety — what changes when Encrypted mode ships

DRAFT for Pilot. Author: Forge (E2E programme, phase P4 (s6), 2026-09-17).
Ken forwards. Nothing here has been entered into Play Console.

Scope: the Android app only (`com.dnkdialer.companion`, versionCode 58 /
1.0.34 is the scaffold build; the shipping build is later). Source of truth
for the current declarations is `docs/play-store/PLAY_STORE_LISTING.md`
§"Data safety form", which this draft amends rather than replaces.

---

## 0. BLOCKER — the listing already makes the claim, and it is not true yet

`docs/play-store/PLAY_STORE_LISTING.md` line 90, under "PRIVATE BY DESIGN",
currently reads:

> • End-to-end encrypted relay between your phone and your browser.

**This is live listing copy and it is false today.** Traffic is TLS/WSS to the
relay and the relay can read every frame — that is precisely the property the
E2E programme exists to remove. It is also the exact wording the programme has
banned from in-app copy (P4 (s5) enforces that with a test).

This is not a new risk introduced by encrypted mode; it is an existing
misstatement that encrypted mode will eventually make true, **but only for
mode-ON pairs**. Two things Pilot needs to decide, and neither waits for us:

1. Whether this line is corrected NOW, ahead of the feature. Forge's
   recommendation is yes — a Data Safety form that says "encrypted in
   transit" while the listing says "end-to-end" is the kind of gap Google
   audits, and it is a consumer-protection exposure independent of Play.
2. What it becomes AFTER ship. It cannot go back to an unqualified
   "end-to-end" claim, because the default is OFF and mixed-mode pairs are
   supported indefinitely (there is never a hard cutover). Suggested:
   "Optional encrypted mode: when enabled, our relay cannot read your
   messages or call details."

Flagged to Ken for the P8 claim review as well.

---

## 1. Does anything in the Data Safety form actually change?

**Almost nothing, and that is the honest answer.** The form asks what is
collected and shared, not how well it is protected.

| Form question | Today | With Encrypted mode | Changed? |
|---|---|---|---|
| Data types collected | Email, user ID (pairing token), own SIM number, diagnostics | identical | **no** |
| SMS/MMS contents "collected" | No | No | **no** |
| Contacts "collected" | No | No | **no** |
| Call logs "collected" | No | No | **no** |
| Shared with third parties | Email → Resend, Whop | identical | **no** |
| Data encrypted in transit | Yes | Yes | **no** |
| Users can request deletion | Yes | Yes | **no** |

The existing "no" answers for SMS / contacts / call logs rest on Google's
definition of *collected* = transmitted off device **and stored on a server**.
Our relay forwards without storing. Encrypted mode does not change that
answer — it strengthens the rationale behind it, because for mode-ON pairs
the relay could not store readable content even if it tried.

**Net: no new data type, no new sharing, and NO NEW PERMISSIONS.** The
AndroidKeyStore is not permission-gated; the 21 declared permissions are
byte-identical to v57. Nothing in the restricted-permission story
(READ_SMS / READ_CALL_LOG) moves, so the Permissions Declaration Form does
not need re-filing on account of this feature.

---

## 2. What Pilot can newly claim, and the exact limits

Available after ship, **only** where both ends have the capability and at
least one side has the setting ON:

- Message and call-detail payloads are encrypted so that **we cannot read
  them** — not merely encrypted in transit to us.
- Keys are generated and held in Android hardware (TEE, or StrongBox where
  the device has it) and never leave the device.

Limits Pilot must not lose, because each one makes an unqualified claim false:

1. **Default is OFF.** The user opts in. Most installs will not be in
   encrypted mode.
2. **Both ends must support it.** A phone on v58 paired with an older
   computer runs in plaintext (and says so in the UI).
3. **Mixed mode is permanent.** There is no flag day; plaintext pairs remain
   supported indefinitely.
4. **Metadata is NOT covered.** The relay still sees who is connected, when,
   how often, and frame sizes. Any claim must be about *content*.
5. **Some frames stay plaintext by design.** The bulk history fetches
   (`GET_MESSAGES`, `GET_CALL_LOGS`, `GET_CONTACTS`) remain readable at the
   relay because they are the subscription tier-gate chokepoint, and call
   *state* is clear while the number and name are sealed. So "nothing is
   readable" is false even at mode ON. Final frame list is frozen at Gate 1;
   Pilot should re-read it before writing copy.
6. **Not independently audited.** The existing form says "Independent
   security review: NO" and that does not change here. Do not imply one.

Wording that is safe today: *"Optional encrypted mode for message and call
details, using keys held in your phone's hardware."*
Wording that is not: *"end-to-end encrypted"* unqualified, *"we can never see
your data"*, *"zero knowledge"*, *"private by design"* as an absolute.

---

## 3. Store-listing surfaces that will need Pilot's edit

- The "PRIVATE BY DESIGN" bullet above (§0) — needed regardless.
- "What's new" for the shipping release — must not overstate; default is OFF.
- Any screenshot showing the Settings screen will now contain an
  **Encrypted mode** row. At ship it is a working toggle; in the v58 scaffold
  build it is greyed with "Waiting for a computer that supports encrypted
  mode." Do not ship a marketing screenshot of the greyed state — it reads as
  a broken feature.

---

## 4. Open questions for Pilot

1. Does correcting the §0 line before the feature ships require a listing
   review cycle that could collide with the release, and should it therefore
   go in the same submission or a separate earlier one?
2. Does Google's Data Safety "encrypted in transit" checkbox have any stronger
   variant worth claiming, or is the distinction purely marketing copy? Forge's
   reading is the latter — the form has no E2E-specific field — but Pilot owns
   that call.
3. Anything in the Whop / Resend third-party disclosures that should be
   revisited at the same time, since the form is being reopened anyway?

---

## 5. What is NOT in scope of this note

Signing, versionCode consumption, upload, and the release track are human
steps and are not affected by anything above. versionCode 58 is consumed
exactly once by the eventual signed release; a rejection means 59, never a
re-signed 58.
