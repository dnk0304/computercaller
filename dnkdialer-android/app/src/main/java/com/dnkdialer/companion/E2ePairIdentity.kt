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
 * | field           | phone has it?                                        |
 * |-----------------|------------------------------------------------------|
 * | `pairingId`     | yes (PAIRING_REQUEST) — shared, and the HKDF salt     |
 * | `userId`        | yes — [TokenStore], from the authed devicekeys API   |
 * | `phoneDeviceId` | yes (local, [E2eLifecycle])                          |
 * | `peerDeviceId`  | yes (from `recips[]`) — see "multi-recipient" below  |
 * | `pairEpoch`     | yes (minted here)                                    |
 *
 * ## `userId`: R-BH (Ken, 2026-09-21), option B
 *
 * This was the open one, and for the whole of P4–P6.1b it was **not** open in
 * a safe way: it returned a hard-coded `""`. §13.10.3 binds the account id
 * into every KEK, every traffic key and every nonce prefix, the page derives
 * under its real `/api/auth/me` session id, and `lib/e2e/kdf.mjs` REFUSES a
 * zero-length one — so the page could not even represent what this phone was
 * sealing under. No wrap the phone minted could ever open, in any mode. That
 * is A6-P61B-8, attributed in P6.1c part 0.
 *
 * R-BH's channel: the phone learns its account id from the DeviceKey API it
 * already calls, authenticated by `Authorization: Bearer <phoneToken>`, which
 * `lib/deviceKeyAuth.ts` resolves to a `User.id` with the *same* lookup the
 * session path uses. That is the identical string `/api/auth/me` hands the
 * page (`hooks/useE2e.ts:143`) — same trust root, same value, symmetric.
 *
 * SPEC l.934 ("`userId` is deliberately not transmitted. Each side uses its
 * own authenticated session userId and a mismatch fails closed") is satisfied,
 * not bent: nothing about the account id travels over the pairing wire, and no
 * peer or relay proposes it. It is learned once from the account API, persisted
 * beside the token it belongs to, and never overwritten — see
 * [TokenStore.putUserId].
 *
 * Ctx BYTES are unchanged by all of this, and so is every frozen vector A–M:
 * each already carries a non-empty `userId`, and this lane finally makes the
 * production path capable of producing one.
 *
 * ## Fail closed, never `""`
 *
 * When the id is not known — never learned, Keystore unavailable, signed out —
 * [contextFor] THROWS rather than substituting a blank. That mirrors the page,
 * which treats a null session userId as a mode-ON refusal for the same reason
 * (`useE2e.ts:147`): deriving under a guessed identity is the silent divergence
 * §13.10.3 exists to prevent, and this file already refuses every other version
 * of that (see [E2eNegotiation.buildAcceptBlock] refusing an oversized block
 * rather than letting the relay drop it into plaintext).
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
     * The account id for [E2eKdf.PairContext], or **null when this phone does
     * not know it**.
     *
     * R-BH landed here, and the `""` constant that used to be returned is
     * gone. The value comes from [TokenStore], which learned it from the
     * authenticated devicekeys API and persists it once beside the phoneToken.
     *
     * Null is a real answer, and the only honest one when the id has not been
     * learned: it is never papered over with a blank. [contextFor] turns it
     * into a refusal.
     */
    @JvmStatic
    fun userIdForPairContext(ctx: Context): String? = TokenStore.getUserId(ctx)

    /**
     * Pick the peer device id for a multi-recipient offer. Deterministic and
     * order-independent — see the class doc.
     */
    @JvmStatic
    fun peerDeviceIdFor(recipients: List<E2eNegotiation.Recipient>): String =
        canonicalPeerDeviceId(recipients.map { it.deviceId })

    /**
     * GATE1 Addendum A4-R2, FROZEN: the canonical peer is the **byte-wise
     * lexicographically lowest** of the recipients' `deviceId`s, compared as
     * **raw UTF-8 bytes** — not code points, not locale collation, not
     * case-folded.
     *
     * This must not be `minOrNull()`. Kotlin's `String` ordering compares
     * UTF-16 code units, which agrees with UTF-8 byte order for ASCII and
     * **disagrees above the BMP**, because a supplementary character is a
     * surrogate pair beginning `0xD800` in UTF-16 but `0xF0` in UTF-8, while
     * `U+E000..U+FFFF` sit above `0xD800` in UTF-16 and below `0xF0` in UTF-8.
     * Concretely `U+FFFD` vs `U+10000`: UTF-8 puts `U+FFFD` first
     * (`efbfbd` < `f0908080`), UTF-16 puts `U+10000` first
     * (`d800dc00` < `fffd`). Opposite answers, so the two sides would derive
     * different traffic keys and every frame would fail to authenticate for a
     * reason no log explains.
     *
     * Byte comparison rather than "refuse non-ASCII ids": these ids arrive from
     * the peer over the wire, A4 specifies a comparison and not a restriction,
     * and inventing a refusal condition the addendum does not state would
     * reject pairings the spec admits. The comparison is total over every
     * string, so nothing needs to be excluded.
     *
     * Deterministic and order-independent, so a re-ordered but otherwise
     * identical offer derives the same keys.
     */
    @JvmStatic
    fun canonicalPeerDeviceId(deviceIds: List<String>): String {
        var best: String? = null
        var bestBytes: ByteArray? = null
        for (id in deviceIds) {
            val bytes = id.toByteArray(Charsets.UTF_8)
            if (bestBytes == null || compareUnsigned(bytes, bestBytes) < 0) {
                best = id
                bestBytes = bytes
            }
        }
        return best.orEmpty()
    }

    /**
     * Lexicographic comparison of UTF-8 bytes as UNSIGNED. `Byte` is signed in
     * Kotlin, so a naive `a[i] - b[i]` would order every byte >= 0x80 BELOW
     * ASCII — which is the same class of bug as using UTF-16 order, reached by
     * a different route.
     */
    private fun compareUnsigned(a: ByteArray, b: ByteArray): Int {
        val n = minOf(a.size, b.size)
        for (i in 0 until n) {
            val d = (a[i].toInt() and 0xff) - (b[i].toInt() and 0xff)
            if (d != 0) return d
        }
        return a.size - b.size
    }

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
     * transmitted (SPEC l.934) — each side supplies its OWN authenticated
     * account id and a mismatch fails closed. Since R-BH the phone genuinely
     * has one ([userIdForPairContext]), which is what makes that rule work
     * instead of merely hold vacuously.
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
     * @param expectedPairingId when known, A3-M3(a)'s check: a ctx for another
     *        pairing is refused.
     * @param recipientDeviceIds A4-M1. When the caller holds the full
     *        `wraps[]` set, `ctx.peerDeviceId` MUST be the canonical lowest of
     *        it, or a relay could steer the derivation to a peer of its
     *        choosing. When the caller does NOT hold the set — the extension
     *        SW, whose `PAIR_STATE` carries only its own `wrap` — it must pass
     *        null and perform NO peer check, and must never substitute its own
     *        deviceId for the canonical peer. That substitution is the
     *        A3-M1/A3-M3 contradiction A4 exists to delete: it refuses every
     *        recipient except the canonical one and makes multi-recipient
     *        pairing impossible.
     *
     *        Note there is no "peerDeviceId must equal my own deviceId" check
     *        here to remove — P4 never implemented one, because the phone is
     *        the encoder. This parameter is the decoder-side half, present so
     *        vector J.3's refusal is assertable in this lane.
     */
    @JvmStatic
    @JvmOverloads
    fun contextFromWire(
        ctx: com.google.gson.JsonObject?,
        localUserId: String,
        expectedPairingId: String? = null,
        recipientDeviceIds: List<String>? = null,
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

        val peerDeviceId = str("peerDeviceId")
        // A4-M1(c): only where the set is actually held. Checked BEFORE any
        // derivation — a steered peer must be refused, not derived from and
        // then noticed.
        if (recipientDeviceIds != null) {
            val canonical = canonicalPeerDeviceId(recipientDeviceIds)
            if (peerDeviceId != canonical) {
                throw CtxException(
                    "A4-M1: ctx.peerDeviceId '$peerDeviceId' is not the canonical lowest " +
                        "of wraps[].deviceId ('$canonical') — refusing a steered derivation"
                )
            }
        }

        return E2eKdf.PairContext(
            pairingId = pairingId,
            userId = localUserId,
            phoneDeviceId = str("phoneDeviceId"),
            peerDeviceId = peerDeviceId,
            pairEpoch = pairEpoch,
        )
    }

    /**
     * Thrown when the context cannot be assembled from values this phone
     * actually holds. Always fail closed.
     *
     * A [RuntimeException], which is not incidental: [PhoneService]'s Accept
     * path already catches `RuntimeException` and turns it into a DECLINE
     * under mode ON and a plaintext pairing under mode OFF — §13.1's split. A
     * new refusal path here would be a second implementation of a decision
     * that must have exactly one.
     */
    class PairContextUnavailableException(message: String) : IllegalStateException(message)

    /**
     * Assemble the context for one Accept. The only caller is the Accept path
     * in [PhoneService]; everything above is exposed for the unit suite.
     *
     * @throws PairContextUnavailableException when the account id is unknown.
     *         REFUSING is the whole point — feeding `""` here is precisely the
     *         bug this lane exists to delete, and it is unfixable downstream
     *         because by then the bytes are already wrong.
     */
    @JvmStatic
    fun contextFor(
        ctx: Context,
        pairingId: String,
        recipients: List<E2eNegotiation.Recipient>,
        pairEpoch: Long,
    ): E2eKdf.PairContext {
        val userId = userIdForPairContext(ctx)
        if (userId.isNullOrEmpty()) {
            throw PairContextUnavailableException(
                "this phone does not know its account id, so it cannot build a §13.10.3 " +
                    "pairContext the peer could reproduce; refusing rather than deriving " +
                    "under an empty userId (R-BH; SPEC l.934 fails closed on a mismatch)"
            )
        }
        return E2eKdf.PairContext(
            pairingId = pairingId,
            userId = userId,
            phoneDeviceId = E2eLifecycle.deviceId(ctx),
            peerDeviceId = peerDeviceIdFor(recipients),
            pairEpoch = pairEpoch,
        )
    }
}
