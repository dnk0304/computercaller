package com.dnkdialer.companion

import android.content.Context
import androidx.core.content.edit

/**
 * E2E programme, phase P4 Part 2 (w1) — **the one function that decides what
 * goes into a [E2eKdf.PairContext]**, and the single place a ruling on the
 * pairContext channel gap has to change.
 *
 * ## Why this file exists at all
 *
 * §13.10.3 freezes the pair context as
 *
 * ```
 *   pairContext = 0x11 u8(len) userId
 *               ‖ 0x12 u8(len) phoneDeviceId
 *               ‖ 0x13 u8(len) peerDeviceId
 *               ‖ 0x14 be64(pairEpoch)
 *   salt        = UTF8(pairingId)
 * ```
 *
 * Every traffic key, every KEK, every nonce prefix and the AAD's `pairEpoch`
 * are derived through it, so **both sides must compute the same bytes or
 * nothing decrypts.** Wiring this into [PhoneService] is the first time any
 * lane has had to actually *source* those four values on a real device, and
 * three of the four turn out to have no channel to the peer:
 *
 * | field           | phone has it?              | peer can learn it?                        |
 * |-----------------|----------------------------|-------------------------------------------|
 * | `pairingId`     | yes (PAIRING_REQUEST)      | yes — shared, and it is the HKDF salt      |
 * | `userId`        | **no**                     | n/a — the phone never learns it            |
 * | `phoneDeviceId` | yes (local, [E2eLifecycle])| **no** — not in any frozen frame           |
 * | `peerDeviceId`  | yes (from `recips[]`)      | ambiguous — see "multi-recipient" below    |
 * | `pairEpoch`     | yes (minted here)          | **no** — not in any frozen frame           |
 *
 * `userId` is the flat one: `POST /api/auth/apk-login` returns
 * `{phoneToken, deviceName}` and nothing else, `GET /api/devicekeys/list`'s
 * `PUBLIC_SELECT` is `{id, deviceId, kind, publicKey, label, createdAt,
 * lastSeen, revokedAt}`, and no relay frame carries it. The account id is
 * deliberately server-side only (B8). The phone cannot put a value in that
 * field that the browser would also compute.
 *
 * Full write-up, options and a recommendation:
 * `dnkdialer-android/e2e-evidence/PAIRCONTEXT-CHANNEL-GAP.md`. It is the same
 * class of defect as the AEAD nonce prefix (Security Addendum A2) and wants
 * the same kind of ruling.
 *
 * ## What this implementation does, and why it is the safe choice
 *
 * It feeds the context the **real** values this phone holds, and leaves
 * `userId` empty because there is no value to put there.
 *
 * The alternative — blanking every unchannelled field so that a peer could
 * reproduce the context from `pairingId` alone — was rejected. It would make
 * cross-implementation traffic *appear* to work while silently deleting the
 * transcript binding that §13.10.3 exists to provide: a downgrade shipped
 * under the appearance of success. What this file does instead makes the gap
 * fail **loudly** — P2's cross-implementation harness will not be able to open
 * a wrap — which is the failure mode this programme has chosen every time it
 * has had the choice (see [E2eNegotiation.buildAcceptBlock] refusing an
 * oversized block rather than letting the relay drop it into plaintext).
 *
 * P4's own suites are unaffected: they are same-implementation loopbacks, both
 * halves compute the identical context in-process, and they say so.
 *
 * ## Multi-recipient
 *
 * A pairing can advertise several recipients (the page and the extension
 * service worker are two devices on one computer). `peerDeviceId` is singular.
 * We pick the **canonically lowest recipient deviceId**, which is at least
 * deterministic and order-independent, rather than "the first one the relay
 * happened to list" — a context that depended on array order would derive
 * different keys on a re-ordered but otherwise identical offer. That choice is
 * also part of the ruling being asked for.
 *
 * ## pairEpoch
 *
 * §13.8 requires it to be strictly greater at each Accept for a pair. It is a
 * per-pairingId monotonic counter, persisted with `commit()` **before** it is
 * used, so a process death between minting and sealing can never hand the same
 * epoch out twice — the same persist-before-use discipline [E2eSeqStore] uses
 * for the sequence number, and for the same reason.
 */
object E2ePairIdentity {

    private const val PREFS = "e2e_pair_identity"

    /**
     * The epoch counter key. **Device-wide, not per pairing.**
     *
     * This is keyed to match the RECEIVER. A3-M2 has each computer-side device
     * persist its refusal floor as `lastPairEpoch[(userId, phoneDeviceId)]` —
     * per PHONE, not per pairing. A per-pairingId counter would restart at 1
     * for every new pairing (the relay mints a fresh random pairingId each
     * time), and every one of those would land at or below a floor set by an
     * earlier pairing, so the peer would refuse the pair outright and never
     * say why. The two counters must be keyed the same way or the MUST that
     * defends against replay becomes a MUST that blocks normal use.
     *
     * Consequence, which is the correct one: the epoch is a monotonic count of
     * Accepts by THIS phone, and it never goes backwards for any peer.
     */
    private const val EPOCH_KEY = "pair_epoch"

    /**
     * The account id for [E2eKdf.PairContext].
     *
     * **Returns the empty string, because the phone has no account id.** See
     * the class doc: this is the single function a ruling changes. When the
     * ruling lands — whether it adds `userId` to P1's `e2e` block, returns it
     * from `apk-login`, or formally blanks the field — this body changes and
     * nothing else does.
     */
    @JvmStatic
    fun userIdForPairContext(@Suppress("UNUSED_PARAMETER") ctx: Context): String = ""

    /**
     * Pick the peer device id for a multi-recipient offer. Deterministic and
     * order-independent — see the class doc.
     */
    @JvmStatic
    fun peerDeviceIdFor(recipients: List<E2eNegotiation.Recipient>): String =
        recipients.map { it.deviceId }.minOrNull().orEmpty()

    /**
     * Mint the next epoch for [pairingId]. Strictly increasing, persisted
     * before it is returned.
     *
     * @throws IllegalStateException when the write did not commit. Failing here
     *         is correct: an epoch we could not record is an epoch we might
     *         re-issue, and a re-issued epoch under a fresh session key is a
     *         nonce-space collision waiting for a restore.
     */
    @JvmStatic
    fun nextPairEpoch(ctx: Context): Long {
        val p = ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val next = p.getLong(EPOCH_KEY, 0L) + 1L
        // commit(), not apply(): A3-M2 is persist-before-emit. An epoch that
        // reached a peer but not the disk is an epoch this phone can re-issue,
        // and a re-issued epoch under a fresh SK is the replay A3-M2's floor
        // exists to refuse — from the peer's side it would look like an attack.
        val ok = p.edit().putLong(EPOCH_KEY, next).commit()
        check(ok) { "could not persist pairEpoch — refusing to mint one" }
        return next
    }

    /**
     * Reset the counter. **Sign-out / key rotation only**, never on Reset lobby
     * or a terminated pair: the peer's floor is cleared only by an explicit
     * unpair / revoke / sign-out (A3-M2), so a phone that reset its counter on
     * any lighter event would start proposing epochs the peer must refuse.
     */
    @JvmStatic
    fun clearPairEpoch(ctx: Context) {
        ctx.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit(commit = true) { remove(EPOCH_KEY) }
    }

    /**
     * Ken's Addendum A3 proposal (A): the phone carries the context it minted
     * inside the existing `e2e` block, so the browser and the SW can rebuild
     * §13.10.3's `pairContext` byte-for-byte. `userId` is deliberately NOT
     * transmitted — B8 keeps the account id server-side, and [contextFor]
     * feeds that field empty on both sides.
     *
     * ```
     *   ctx: { pairingId, phoneDeviceId, peerDeviceId, pairEpoch }
     * ```
     *
     * `pairEpoch` is a DECIMAL STRING, per A3. JSON numbers are IEEE-754 in
     * every JS runtime that will read this, and a 64-bit epoch is not a value
     * to hand to a double — the same reason P1's `s` is read as a long here
     * and not inferred.
     *
     * **A3 has not been ruled on.** This emits (A). If Security instead rules
     * (B) — the ctx additionally bound under the SAS transcript — that is a
     * change to [E2eSas]'s input framing and to this one function, and to
     * nothing else; the block shape is identical either way. A peer that does
     * not understand `ctx` ignores it, and the relay forwards the block
     * verbatim, so emitting it early costs nothing and unblocks P2/P3.
     */
    @JvmStatic
    fun ctxBlockFor(pairContext: E2eKdf.PairContext): com.google.gson.JsonObject =
        com.google.gson.JsonObject().apply {
            addProperty("pairingId", pairContext.pairingId)
            addProperty("phoneDeviceId", pairContext.phoneDeviceId)
            addProperty("peerDeviceId", pairContext.peerDeviceId)
            addProperty("pairEpoch", pairContext.pairEpoch.toString())
        }

    /**
     * Attach [ctxBlockFor] to an Accept block and re-check the relay's size cap.
     *
     * The cap is re-checked because [E2eNegotiation.buildAcceptBlock] enforced
     * it before this field existed, and the relay silently DROPS an oversized
     * block — which would let the pairing continue in plaintext. Returns null
     * on overflow so the caller aborts rather than discovers it later.
     */
    @JvmStatic
    fun withCtx(
        block: com.google.gson.JsonObject,
        pairContext: E2eKdf.PairContext,
    ): com.google.gson.JsonObject? {
        block.add("ctx", ctxBlockFor(pairContext))
        val size = block.toString().toByteArray(Charsets.UTF_8).size
        return if (size > E2eNegotiation.MAX_BLOCK_BYTES) null else block
    }

    /** Thrown when a wire `ctx` cannot be accepted. Always fail closed. */
    class CtxException(message: String) : IllegalArgumentException(message)

    /**
     * A3's `pairEpoch` grammar, enforced rather than assumed:
     * `^(0|[1-9][0-9]{0,19})$`, and <= 2^64-1.
     */
    private val EPOCH_GRAMMAR = Regex("^(0|[1-9][0-9]{0,19})$")

    /**
     * Rebuild a [E2eKdf.PairContext] from a transmitted `ctx` plus the LOCAL
     * userId — A3's ratified shape, and the assertion vector I exists to pin:
     * *wire ctx + local userId == the frozen local context, byte for byte.*
     *
     * P4 is the encoder, so strictly it only needs [ctxBlockFor]. This decoder
     * is here anyway because a round-trip through it is the only way P4's own
     * suite can prove the encoding is *readable* rather than merely stable —
     * a self-consistent encoder passes any test written against itself.
     *
     * Every A3 parser negative (I.4) is refused here rather than coerced:
     *
     * - `pairEpoch` as a JSON number — the case the decimal-string rule exists
     *   for, since `JSON.parse` yields a double and A1 forbids rounding above
     *   2^53. Gson would happily hand us `42` and we would never notice.
     * - `"042"`, `" 42"`, `"-1"`, `"4.2"`, `""`, absent — all refused by the
     *   grammar, none normalised. A parser that trims whitespace here is a
     *   parser that disagrees with the peer about the bytes it hashed.
     * - any id over 255 UTF-8 bytes — A1's u8 cap, re-asserted on the DECODE
     *   side so an oversized id is refused before it can throw deeper in.
     *
     * @param expectedPairingId when known, A3-M3's check: a ctx for another
     *        pairing is refused.
     */
    @JvmStatic
    @JvmOverloads
    fun contextFromWire(
        ctx: com.google.gson.JsonObject?,
        localUserId: String,
        expectedPairingId: String? = null,
    ): E2eKdf.PairContext {
        if (ctx == null) {
            // A3-M4: a mode=1 block with no ctx is REFUSED, never derived from
            // a local guess — a guess is the silent divergence A3 exists to
            // kill, and it would let a stripping relay force both sides into one.
            throw CtxException("no ctx on the block — A3-M4 refuses, never derives from local")
        }

        fun str(name: String): String {
            val el = ctx.get(name) ?: throw CtxException("ctx.$name is absent")
            if (!el.isJsonPrimitive || !el.asJsonPrimitive.isString) {
                throw CtxException("ctx.$name must be a JSON string")
            }
            val v = el.asString
            if (v.toByteArray(Charsets.UTF_8).size > 255) {
                throw CtxException("ctx.$name exceeds the u8 length cap")
            }
            return v
        }

        val pairingId = str("pairingId")
        if (expectedPairingId != null && pairingId != expectedPairingId) {
            throw CtxException(
                "A3-M3: ctx.pairingId '$pairingId' is not the pairing we are party to"
            )
        }

        val epochEl = ctx.get("pairEpoch") ?: throw CtxException("ctx.pairEpoch is absent")
        if (!epochEl.isJsonPrimitive || !epochEl.asJsonPrimitive.isString) {
            throw CtxException(
                "ctx.pairEpoch must be a DECIMAL STRING — a JSON number is parsed as a " +
                    "double by every JS runtime that will read this block"
            )
        }
        val epochText = epochEl.asString
        if (!EPOCH_GRAMMAR.matches(epochText)) {
            throw CtxException("ctx.pairEpoch '$epochText' does not match A3's grammar")
        }
        // A3 rejects above 2^64-1. This rejects above 2^63-1, which is
        // STRICTER and deliberately so: pairEpoch counts Accepts by one phone,
        // so 2^63 is unreachable, whereas anything above it would have to be
        // carried as a negative Long and every downstream be64 and AAD
        // assertion would then be reasoning about a sign bit. Refusing is fail
        // closed; coercing would not be.
        val pairEpoch = epochText.toLongOrNull()
            ?: throw CtxException(
                "ctx.pairEpoch '$epochText' exceeds this implementation's 2^63-1 ceiling"
            )

        return E2eKdf.PairContext(
            pairingId = pairingId,
            userId = localUserId,
            phoneDeviceId = str("phoneDeviceId"),
            peerDeviceId = str("peerDeviceId"),
            pairEpoch = pairEpoch,
        )
    }

    /**
     * Assemble the context for one Accept. The only caller is the Accept path
     * in [PhoneService]; everything above is exposed for the unit suite.
     */
    @JvmStatic
    fun contextFor(
        ctx: Context,
        pairingId: String,
        recipients: List<E2eNegotiation.Recipient>,
        pairEpoch: Long,
    ): E2eKdf.PairContext = E2eKdf.PairContext(
        pairingId = pairingId,
        userId = userIdForPairContext(ctx),
        phoneDeviceId = E2eLifecycle.deviceId(ctx),
        peerDeviceId = peerDeviceIdFor(recipients),
        pairEpoch = pairEpoch,
    )
}
