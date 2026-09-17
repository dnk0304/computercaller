# KDF layout — P4 PROPOSAL (not frozen)

Owner: forge-backend (P4, android lane). Audience: P2 (web), P3 (service worker), Ken.
Status: **OPEN cross-lane item.** Needs a ruling or a matching `lib/e2e/kdf.mjs` before P2 seals anything.

## The problem

`E2E-SPEC-v1.0` §13 freezes the SAS transcript (13.3), the padding (13.4), the dedupe
parameters (13.5) and the key lifecycle (13.8). It does **not** freeze the key schedule.
P0 published `lib/e2e/sas.mjs` and `lib/e2e/padding.mjs` and no KDF module, so the only
statement of the schedule is the brief's prose:

```
HKDF-SHA-256(info = "cc-e2e-v1" ‖ userId ‖ phoneDeviceId ‖ peerDeviceId ‖ pairEpoch,
             salt = pairingId)
```

That `‖` is bare concatenation of variable-length strings, and it is ambiguous:
user `ab` + phone `cd` produces the same info bytes as user `a` + phone `bcd`. Two
different pairings then derive the same traffic keys. It is a narrow bug, it is invisible
to any test that uses fixed-width ids, and it is the kind of thing that is unfixable once
shipped because fixing it is a breaking protocol change.

By accident of ordering P4 is the first lane to implement this. Implementing it silently
would freeze a cross-lane byte layout from one side, and the failure mode is the worst one
available: P2 reads the same prose differently, the two sides derive different keys, and
the only symptom is *"encrypted mode never pairs"* with every log line reporting success.

## What P4 implemented

The same inputs in the same order, framed the way the **already-frozen** SAS transcript
frames its own inputs (§13.3): a one-byte field tag plus a `u8` length prefix on every
variable-length value.

```
pairContext = 0x11 u8(len) userId
            ‖ 0x12 u8(len) phoneDeviceId
            ‖ 0x13 u8(len) peerDeviceId
            ‖ 0x14 be64(pairEpoch)

salt        = UTF8(pairingId)

KEK_i       = HKDF-SHA-256(salt, ikm = ECDH(epk_priv, K_i),
                info = "cc-e2e-v1/kek" ‖ pairContext ‖ 0x15 u8(65) K_i)      -> 32 bytes
k_p2c       = HKDF-SHA-256(salt, ikm = SK, info = "cc-e2e-v1/p2c" ‖ pairContext)
k_c2p       = HKDF-SHA-256(salt, ikm = SK, info = "cc-e2e-v1/c2p" ‖ pairContext)
```

- Tags are `0x11..0x15`, deliberately disjoint from the SAS's `0x01..0x04`, so a SAS
  transcript can never be reused as a KDF info string or the reverse.
- `K_i` is the recipient's static public key in the Gate 1 wire encoding: uncompressed
  SEC1, `0x04`-prefixed, 65 bytes. Binding it into the KEK info is what stops a wrap made
  for the web page from opening in the service worker.
- `k_p2c` ≠ `k_c2p` so a reflected frame cannot decrypt under the sender's own key.
- `pairEpoch` is `be64`, not a JS number — it must not round above 2^53 on the web side.

## What P2/P3 must do

Implement against `e2e-evidence/kdf-vectors-P4-proposal.json`. It carries the exact
`contextBytesHex`, the exact `infoP2cHex` / `infoC2pHex` / `kekInfoHex` and the exact
derived keys, so a mismatch is caught at the byte that differs rather than at the digit
that does not match. The two fixed recipient points in that file are P-256 `G` and `[2]G`,
independently verifiable from SEC 2 §2.4.2.

`E2eKdfVectorsTest` fails the android build if `E2eKdf`'s framing drifts from the committed
file, so the file cannot silently stop describing the code.

## If Ken rules the other way

Changing the framing is a one-line change in `E2eKdf.pairContextBytes` plus a regeneration
(`gradlew :app:testDebugUnitTest -De2e.writeVectors=true`). Nothing downstream in the
android lane depends on the specific bytes. The cost of changing it after P2 ships is a
protocol version bump.
