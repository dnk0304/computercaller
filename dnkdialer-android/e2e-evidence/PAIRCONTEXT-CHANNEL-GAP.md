# `pairContext` is not computable by the peer — a channel gap in §13.10.3

Owner: forge-backend (P4, android lane). Audience: Security, Ken, P2, P3.
Status: **CLOSED for P4 — Addendum A3 RATIFIED (A), AMENDED, 2026-09-17.**
(`security/PROJECTS/computercaller/e2e/GATE1-ADDENDUM-A3.md`.)

Reached independently by Ken and by P4 at (w1) — the first time any lane had to *source* these
values on a real device rather than supply them as test fixtures.

**Ratified and implemented on this branch:** the phone emits
`ctx:{pairingId, phoneDeviceId, peerDeviceId, pairEpoch}` (pairEpoch a DECIMAL STRING) inside the
`e2e` block of ACCEPT_PAIRING; the relay forwards it verbatim and re-sends it on resume. `userId`
is NOT transmitted — each side supplies its own authenticated one, so a session-identity mismatch
fails closed instead of the derivation agreeing with the relay. (B) rejected: §13.3's SAS already
contains `pairEpoch` and `pairingId`. Vector I asserts all of it and reproduces byte-exact
(I.1/I.2/I.3 were each re-derived here from the addendum before being committed).

P4-side MUSTs, all landed in (w1):
- emit `ctx` on every mode-on Accept, re-checking the relay's 4 KB cap AFTER attaching it
  (`buildAcceptBlock` enforced the cap before the field existed, and the relay silently DROPS an
  oversized block, which would let the pairing continue in the clear);
- `pairEpoch` phone-owned, monotonic, **persisted with `commit()` before it is emitted**;
- decimal string, no leading zeros, no sign, no whitespace, never a JSON number.

## One correction P4 made to its own reading, worth recording

The epoch counter was first written **per `pairingId`**. That is wrong, and silently so. A3-M2 has
each computer-side device persist its refusal floor as `lastPairEpoch[(userId, phoneDeviceId)]` —
**per phone, not per pairing**. Since the relay mints a fresh random `pairingId` for every pairing,
a per-pairing counter restarts at 1 each time, and every one of those lands at or below a floor set
by an earlier pairing: the peer refuses the pair outright, fails closed, and no log on either side
says why. The two counters must be keyed the same way, or the MUST that defends against replay
becomes a MUST that blocks normal use. It is now a single device-wide monotonic count of Accepts.

## OPEN — a contradiction between A3-M1 and A3-M3 under multi-recipient (for Security/Ken/P3)

Not P4-blocking; P4 is the encoder and emits one `ctx`. It blocks P3.

- **A3-M1** says ctx is *pair-scoped, not device-scoped*: "unlike `wrap`, **every recipient gets
  the identical object**", and requires `derivePairState` to splice that same object into
  `PAIR_STATE` so the extension SW can derive at all.
- **A3-M3** says a receiver "MUST refuse a block whose `ctx.peerDeviceId` is not its own
  `deviceId`", fail closed, no plaintext fallback.

A pairing with two recipients — the page and the SW, which §13.6 names explicitly — gets ONE
identical `ctx` carrying ONE `peerDeviceId`. Whichever device that names, the other MUST refuse
itself under M3. As written, M3 makes multi-recipient pairing impossible, and it refuses precisely
the recipient M1 was added to rescue.

Possible resolutions, for Security to pick:
1. `ctx.peerDeviceId` is the *canonical* peer for key derivation (one value, all recipients derive
   from it) and M3's check applies only to `pairingId`. Simplest; keeps one pairContext, which the
   multi-recipient wrap design in §13.2 already assumes, since all wraps derive KEKs from one
   context.
2. `ctx` becomes device-scoped after all (each recipient gets its own `peerDeviceId`), which means
   a different `pairContext` and therefore different traffic keys per recipient — a real protocol
   change, not a wording fix, and it contradicts M1.

P4 currently emits the canonically lowest recipient `deviceId` — deterministic and
order-independent, so a re-ordered but otherwise identical offer derives the same keys. Under
resolution 1 that is already correct. Under 2, P4 changes in one function.

Same class of defect as the AEAD nonce prefix (Addendum A2), and wants the same kind of ruling.
It is larger: A2 concerned one derived value; this concerns three of the four inputs the whole key
schedule hangs on.

## The gap

§13.10.3 freezes:

```
pairContext = 0x11 u8(len) userId
            ‖ 0x12 u8(len) phoneDeviceId
            ‖ 0x13 u8(len) peerDeviceId
            ‖ 0x14 be64(pairEpoch)

salt        = UTF8(pairingId)
```

`pairContext` feeds every traffic key, every KEK, both nonce prefixes (A2) and the AAD's
`pairEpoch`. **Both sides must compute identical bytes or nothing decrypts** — including the
wraps, so a mismatch is not a degraded pairing, it is no pairing at all.

| field | phone has it? | peer can learn it? |
|---|---|---|
| `pairingId` | yes — `PAIRING_REQUEST` | yes. Shared, and it is the salt. **Fine.** |
| `userId` | **no** | n/a — the phone never learns the account id |
| `phoneDeviceId` | yes — local | **no** — in no frozen frame |
| `peerDeviceId` | yes — from `recips[]` | ambiguous under multi-recipient (below) |
| `pairEpoch` | yes — minted at Accept | **no** — in no frozen frame |

### `userId` — the flat one

Verified from the merged code, not from prose:

- `POST /api/auth/apk-login` returns `{phoneToken, deviceName}` and nothing else
  (`deviceName` is the user's *email*, not the account id).
- `GET /api/devicekeys/list` returns rows under `PUBLIC_SELECT` =
  `{id, deviceId, kind, publicKey, label, createdAt, lastSeen, revokedAt}` — no `userId`, and
  `lib/deviceKeys.ts` is explicit that omitting it is the security property (B8: the id comes from
  the caller's proven identity and is never accepted from, or echoed to, a client).
- No relay frame carries it. `server.js` uses `userId` only for its own socket index.

So there is no value the phone can place in that field that the browser would also compute. This
is not an oversight in P1 — it is B8 working as designed.

### `phoneDeviceId` and `pairEpoch`

Both are values the phone *holds* and the peer cannot see. P1's merged `e2e` block is
`{v, mode, kid, epk, recipKeys[], wraps[]}`; `wraps[].deviceId` names the RECIPIENTS, never the
phone. `PAIR_STATE` is `{kid, epk, mode, recipKeys[], wrap}`. `pairEpoch` appears nowhere at all,
yet it is also inside the AAD of every frame.

### `peerDeviceId` — ambiguous, not merely missing

A pairing can advertise several recipients: the page and the extension service worker are two
devices on one computer, and §13.6 names `kind:'extension'` explicitly. `peerDeviceId` is
singular. Which one? Any choice makes the other recipient's KEK derive from a context naming a
device that is not it. Array order is not a safe tiebreak — a re-ordered but otherwise identical
offer would derive different keys.

## What P4 implemented, and why this choice

`E2ePairIdentity.contextFor()` feeds the context the **real** values this phone holds, with
`userId` empty because there is no value to put there, and `peerDeviceId` = the canonically lowest
recipient deviceId (deterministic and order-independent).

The obvious alternative — blank every unchannelled field so a peer could reproduce the context
from `pairingId` alone — was **rejected**. It would make cross-implementation traffic appear to
work while silently deleting the transcript binding §13.10.3 exists to provide. That is a
downgrade shipped under the appearance of success, and it is the exact shape of failure this
programme has refused every time it has had the choice (`buildAcceptBlock` refuses an oversized
block rather than letting the relay drop the pairing into plaintext; A2 was escalated rather than
papered over).

**Expected consequence, stated so it is not mistaken for a regression:** P2's cross-implementation
harness will FAIL to open a wrap until this is ruled on. That failure is the deliverable of this
flag. P4's own suites are unaffected — they are same-implementation loopbacks in one process, both
halves compute the identical context, and (w5) says so explicitly.

## Options

**(A) Transmit the missing fields.** Add `userId`, `phoneDeviceId` and `pairEpoch` to P1's `e2e`
block (and mirror them into `PAIRING_ACTIVE`/`PAIR_STATE`). A P1.1 relay change plus P2/P3/P4
follow-through. `userId` need not be the account id — any per-account opaque handle the server
already knows serves, and echoing one the *caller proved* does not breach B8.
Cost: a frozen frame reopened. Benefit: §13.10.3 works as written.

**(B) Re-specify `pairContext` over values already on the wire.** The block carries `kid`, `epk`
and the canonical `recipKeys[]` set, and the frame carries `pairingId`. A context built from those
is computable by both sides today with no relay change, binds the transcript at least as tightly
(`recipKeys` is the full static key set), and resolves the multi-recipient ambiguity by
construction. Cost: a §13.10.3 amendment and new vectors; P0.2's frozen file gains rows.
**This is P4's recommendation.**

**(C) Formally blank the unchannelled fields**, with `pairingId` + `pairEpoch`-in-AAD carrying the
binding, and say plainly what is given up. Cheapest. Weakest — and it must be a written ruling,
not a silent implementation detail, which is why P4 did not simply do it.

## Question for Security

Does `peerDeviceId` being singular indicate that §13.10.3 assumed ONE recipient? If so, the
multi-recipient wrap design (§13.2) and this context are describing different protocols, and the
ruling should say which one is authoritative before P2 and P3 write their sealing code.
