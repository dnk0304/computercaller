# AEAD nonce prefix — a gap in GATE1 Addendum A1

Owner: forge-backend (P4, android lane). Audience: Security (A1 signer), Ken, P2, P3.
Status: **OPEN — needs a ruling.** P4 has implemented a resolution; it is reversible in one function.

## The gap

Addendum A1 specifies:

```
nonce (12 B) = sessionPrefix(4 B, random, per (kid,direction)) ‖ be64(seq)
```

A **random** prefix has to be transmitted — the receiver cannot reconstruct a random value.
There is nowhere to transmit it:

- P1's `e2e` block is merged and frozen as `{v, mode, kid, epk, recipKeys[], wraps[]}`
  (server.js @ `96042d0`). No prefix field.
- The envelope is `{e, kid, s, c}`. No prefix field.
- `PAIR_STATE` carries `{kid, epk, mode, recipKeys[], wrap}`. No prefix field.

Taken literally, A1's random prefix produces frames the peer cannot decrypt. The defect is
not in the crypto — it is that the value has no channel.

Adding a field to a frozen, merged frame is a P1 change, and inventing one unilaterally is
exactly what P4 declined to do with the KDF.

## What P4 implemented instead

Both prefixes are **derived** from the session key under their own HKDF labels, so each side
computes both and nothing is transmitted:

```
np2c = HKDF-SHA-256(salt = UTF8(pairingId), ikm = SK,
                    info = "cc-e2e-v1/np2c" ‖ pairContext)[0..4]
nc2p = HKDF-SHA-256(salt = UTF8(pairingId), ikm = SK,
                    info = "cc-e2e-v1/nc2p" ‖ pairContext)[0..4]
```

Same `pairContext` framing as the ratified item (1); two new labels in the existing
`cc-e2e-v1/` namespace, distinct from `/kek`, `/p2c`, `/c2p`.

### Why the security property A1 asked for survives

A1 is explicit about what the prefix is and is not for:

> The 4-byte random `sessionPrefix` is defence in depth against a state-restore bug; it MUST
> NOT be treated as the thing that makes nonces unique.

Uniqueness comes from the counter, and that is untouched — `E2eSeqStore` still enforces
persist-before-emit and fail-closed, and `E2eSeqStoreTest.restore_from_backup_fails_closed`
is green.

For the defence-in-depth property: `SK` is fresh CSPRNG output at every Accept and
`pairEpoch` is bound into `pairContext`, so a new Accept yields a new, unpredictable prefix.
A restored counter therefore still meets a different nonce space whenever the pairing was
re-Accepted. What changes is *unpredictable-but-derived* in place of
*random-and-transmitted*.

### What is genuinely weaker

If an attacker ever learns `SK`, they can compute the prefixes — but knowing `SK` already
gives them both traffic keys, so the prefix adds nothing at that point. Under a threat model
where `SK` is secret, derived and random are equivalent here.

## The three ways to close this

1. **Bless the derivation** (P4's implementation stands; A1 gains a sentence and two labels,
   and the vectors file gains `np2c`/`nc2p`). No wire change, no other lane blocked.
2. **Add `np` to the `e2e` block** — a P1 change to a merged frame, plus P2/P3 work, plus a
   re-freeze. Recovers the literal wording of A1.
3. **Drop the prefix entirely** — `nonce = be64(seq)` zero-padded. Legitimate under A1's own
   reasoning (uniqueness is the counter's job) but loses the defence in depth, so P4 did not
   choose it.

P4 recommends (1). Reversing to (2) or (3) is a change to
`E2eKdf.deriveNoncePrefixes` and the two call sites in `E2eSession`.

## Note on A1 vector A

Unaffected. Vector A pins `sessionPrefix = 11223344` as an explicit input and asserts the
ciphertext; `E2eAeadVectorsTest` reproduces it byte for byte regardless of where a prefix
comes from in production.
