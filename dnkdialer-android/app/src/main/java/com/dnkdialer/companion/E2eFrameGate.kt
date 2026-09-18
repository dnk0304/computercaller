package com.dnkdialer.companion

/**
 * E2E programme, phase P4 (w3) — **the chokepoint**. One outbound wrapper, one
 * inbound decoder, and the §13.7 frame list that decides which frames go
 * through them.
 *
 * ## The wire form, and why it keeps the type prefix
 *
 * The relay protocol is `"<TYPE>:<json>"` ([PhoneClient.sendResponse]), not
 * bare JSON. A sealed frame keeps the type and replaces the BODY:
 *
 * ```
 *   PHONE_NOTIFICATION:{"title":"…"}          plaintext
 *   PHONE_NOTIFICATION:{"e":1,"kid":…,"s":…,"c":…}   sealed
 * ```
 *
 * Two reasons it is not wrapped in a new envelope type. The relay routes and
 * gates on the type (`gateBrowserSyncFrame` is the only tier-enforcement
 * chokepoint in the product), so a frame that renamed itself would slip that
 * gate. And the AAD binds `frameType` — the receiver must know which type it
 * is authenticating BEFORE it opens the frame, so the type has to be outside
 * the ciphertext. Moving it inside would mean either trying every type or not
 * binding it, and §13.10 binds it.
 *
 * ## The list is an ALLOWLIST of what gets sealed, read from §13.7
 *
 * Not a denylist of what stays clear. A new frame type added by a future
 * dispatch is therefore plaintext until someone puts it in [SEALED_TYPES] —
 * which is the safe direction to fail for *routing*, and is why [outbound]
 * also carries the latch: a frame that IS on the list and cannot be sealed is
 * dropped, never downgraded.
 *
 * `GET_MESSAGES`, `GET_CALL_LOGS` and `GET_CONTACTS` stay plaintext
 * **mandatorily**. §13.7 is explicit that `gateBrowserSyncFrame` clamps `since`
 * and drops `GET_CONTACTS` below Plus, so sealing them would move billing
 * enforcement to the client, which is the same as deleting it. What leaks is a
 * timestamp and a category, no content. An accepted, documented trade.
 *
 * `CALL_STATUS` is the one §13.7 entry with FIELD-level treatment (`{state}`
 * clear, number and name sealed). It is absent here because the phone never
 * sends it — there is no `CALL_STATUS` emitter anywhere in this module. If a
 * future dispatch adds one, the field-level split has no specified wire shape
 * and needs a ruling before it is invented.
 *
 * ## What this class is NOT
 *
 * It does no crypto. Sealing, sequence reservation, the replay window and the
 * decrypt-failure counter all belong to [E2eSession], which is the only
 * sealing API production code may use (A1 item 2). This is routing.
 */
class E2eFrameGate(
    /** The live session, or null when this pair is in the clear. */
    private val sessionProvider: () -> E2eSession?,
    /**
     * True once encryption has been negotiated for this pair. With it set, a
     * §13.7 sealed frame that cannot be sealed is DROPPED. Separate from
     * `session != null` so that a session torn down mid-pair cannot reopen the
     * plaintext path underneath a pairing the user was told is encrypted.
     */
    private val latchedProvider: () -> Boolean,
) {

    companion object {
        /** §13.7, FROZEN. Everything else is plaintext. */
        val SEALED_TYPES: Set<String> = setOf(
            "PHONE_NOTIFICATION",
            "SMS_RECEIVED",
            "MESSAGES", "MESSAGES_CHUNK",
            "CONTACTS", "CONTACTS_CHUNK",
            "CALL_LOGS", "CALL_LOGS_CHUNK",
            "CALL_LOG_ENTRY",
            "MMS_MEDIA_CHUNK", "MMS_MEDIA_ERROR",
            "CALL_INCOMING", "CALL_ADD", "CALL_UPDATE", "CALL_WAITING",
            "CALL_ANSWERED", "CALL_ENDED", "CALL_REMOVE",
            "SIM_LIST",
            "SMS_SEND_STATUS",
            "SYNC_ESTIMATE",
            "SEND_SMS",
            "MAKE_CALL",
            "NOTIFICATION_REPLY", "NOTIFICATION_DISMISS",
            "NOTIFICATION_REPLY_SENT", "NOTIFICATION_REPLY_FAILED",
            "NOTIFICATION_REMOVED",

        ) + FileTransfer.FRAMES.filter { FileTransfer.isSealedFrame(it) }
        // FT-2 — the FILE_* entries are not listed literally here on purpose.
        // [FileTransfer.isSealedFrame] is the single owner of that decision,
        // so GATE1 Addendum FT-A1's ruling was a one-function change on this
        // lane rather than an edit inside the frozen §13.7 list. Read that
        // function for the policy; FT-A1 §3 (C) ratified sealing all eight.

        /**
         * §13.7's mandatory-plaintext trio, held separately from "everything
         * not in [SEALED_TYPES]" so that adding one of them to the sealed list
         * by accident is a test failure rather than a silent billing outage.
         */
        val MANDATORY_PLAINTEXT: Set<String> = setOf(
            "GET_MESSAGES", "GET_CALL_LOGS", "GET_CONTACTS",
        )

        /** Is this frame sealed when a session is live? */
        @JvmStatic
        fun isSealedType(type: String): Boolean =
            type in SEALED_TYPES && type !in MANDATORY_PLAINTEXT

        /** Does this body look like a §13.7 envelope rather than a payload? */
        @JvmStatic
        fun looksSealed(json: String): Boolean {
            // Cheap structural check before paying for a parse. An envelope is
            // exactly {"e":…,"kid":…,"s":…,"c":…}; a payload that happened to
            // contain the substring "\"e\":" would still fail E2eEnvelope.parse
            // and be handled as a bad frame, so this only has to be a filter.
            val t = json.trimStart()
            return t.startsWith("{") && t.contains("\"e\":") && t.contains("\"kid\":") &&
                t.contains("\"c\":")
        }
    }

    /** Frames dropped because they could not be sealed. §13.5 exports it. */
    @Volatile
    var droppedOutbound: Long = 0L
        private set

    /** Inbound frames dropped: plaintext under the latch, or undecryptable. */
    @Volatile
    var droppedInbound: Long = 0L
        private set

    /**
     * Why the last outbound frame was dropped. [PhoneClient] logs it — this
     * class deliberately has NO android.util.Log call and no Android import at
     * all, so the whole §13.7 routing table is testable on the JVM instead of
     * needing an emulator or a mocking framework to assert a drop.
     */
    @Volatile
    var lastDropReason: String? = null
        private set

    /** Set when §13.5's 3-failures-in-10s threshold asks for a re-pair. */
    @Volatile
    var repairRequested: Boolean = false
        private set

    // ------------------------------------------------------------- outbound

    /**
     * Transform one outbound frame body.
     *
     * @return the body to send, or **null to DROP the frame**.
     *
     * Dropping is the important case. Once the latch is on, a §13.7 frame that
     * cannot be sealed must never leave in the clear: the user has been told
     * this pair is encrypted, and a silent plaintext fallback on the one frame
     * that failed is worse than losing it, because nothing on either side
     * would show that it happened.
     */
    fun outbound(type: String, json: String): String? {
        if (!isSealedType(type)) return json

        val session = sessionProvider()
        if (session == null) {
            if (!latchedProvider()) return json // this pair is in the clear
            droppedOutbound++
            lastDropReason = "latched ON with no session"
            return null
        }

        return try {
            // seal() reserves the sequence DURABLY before it returns, so a
            // frame can never leave this device under an unrecorded sequence
            // (A1 item 3 / A2's sole control). The send happens only on the
            // success path below, after that reservation is on disk.
            val envelope = session.seal(type, json.toByteArray(Charsets.UTF_8)).toJson()
            // FT-A1 MUST C-1 / C-2: the `ft` hint is attached at the SEALING
            // chokepoint, not by a caller, and it is read from `json` — the
            // very bytes just sealed — in this same function. A hint derived
            // from a second source (a caller's argument, a re-stat of the Uri)
            // can drift from the sealed body through ordinary refactoring, and
            // the receiver's compare would then refuse HONEST transfers: an
            // outage that looks like "file transfer is broken on Android" with
            // no attacker anywhere near it.
            attachHint(type, json, envelope)
        } catch (e: RuntimeException) {
            // E2eSeqStore.CounterUnsafeException lands here: the counter cannot
            // be proved safe, so sealing would risk a nonce reuse. Drop and
            // count. A failure to seal is loud, unlike a failure to open.
            droppedOutbound++
            lastDropReason = "seal failed (${e.javaClass.simpleName}: ${e.message})"
            null
        }
    }

    /**
     * Append the FT-A1 hint to a sealed envelope, or return it untouched.
     *
     * The hint is a SIBLING of `{e,kid,s,c}`, not a member of the ciphertext
     * and not part of the AAD. It is appended textually so the four
     * authenticated fields keep the exact bytes [E2eEnvelope.Sealed.toJson]
     * produced — re-serialising the envelope through a JSON library would risk
     * reordering or renumbering them, and they are what the peer authenticates.
     */
    private fun attachHint(type: String, sealedJson: String, envelope: String): String {
        val body = try {
            com.google.gson.JsonParser.parseString(sealedJson).asJsonObject
        } catch (e: RuntimeException) {
            return envelope
        }
        val fields = mutableMapOf<String, Any?>()
        for ((k, v) in body.entrySet()) {
            fields[k] = if (v.isJsonPrimitive) {
                val p = v.asJsonPrimitive
                if (p.isNumber) p.asNumber else if (p.isString) p.asString else null
            } else null
        }
        val hint = FileTransfer.hintFor(type, fields) ?: return envelope
        val id = hint["id"] as String
        val size = hint["size"] as Long
        // The envelope ends with '}'; splice the sibling in before it.
        return envelope.dropLast(1) +
            ",\"${FileTransfer.HINT_KEY}\":{\"id\":\"$id\",\"size\":$size}}"
    }

    /**
     * The `ft` hint from an inbound envelope, or null.
     *
     * Read off the RAW envelope rather than [E2eEnvelope.parse]'s result,
     * because that parser deliberately keeps only the four authenticated
     * fields — which is correct, and is why the hint has to be picked up here.
     */
    private fun hintOf(json: String): Map<String, Any?>? = try {
        val obj = com.google.gson.JsonParser.parseString(json).asJsonObject
        val ft = obj.getAsJsonObject(FileTransfer.HINT_KEY)
        if (ft == null) null else mapOf(
            "id" to (ft.get("id")?.takeIf { it.isJsonPrimitive }?.asString),
            "size" to (ft.get("size")?.takeIf { it.isJsonPrimitive }?.asLong),
        )
    } catch (e: RuntimeException) {
        null
    }

    // -------------------------------------------------------------- inbound

    /** Splice `ft` into an unsealed body as a sibling field. */
    private fun mergeHint(plain: String, ft: Map<String, Any?>): String = try {
        val id = ft["id"] as? String
        val size = ft["size"] as? Long
        val idJson = if (id == null) "null" else "\"" + id + "\""
        plain.trimEnd().dropLast(1) +
            ",\"" + FileTransfer.HINT_KEY + "\":{\"id\":" + idJson +
            ",\"size\":" + (size?.toString() ?: "null") + "}}"
    } catch (e: RuntimeException) {
        plain
    }

    /** What [inbound] decided. */
    sealed interface Inbound {
        /** Dispatch [json] as the frame body. */
        data class Deliver(val json: String) : Inbound

        /** Drop it. A duplicate, a forgery, or plaintext under the latch. */
        data class Drop(val reason: String) : Inbound
    }

    /**
     * Transform one inbound frame body.
     *
     * Never throws and never asks the caller to close the socket: §13.5 says a
     * frame that does not authenticate is DROPPED and the connection is left
     * alone. An exception here would tempt a caller into the reconnect loop the
     * spec forbids — and a reconnect loop triggerable by one forged frame is a
     * denial of service worth about one packet.
     */
    fun inbound(type: String, json: String): Inbound {
        val sealed = looksSealed(json)

        if (!sealed) {
            // A plaintext frame that SHOULD have been sealed, while the latch
            // is on, is exactly what a stripping relay produces. Drop it.
            if (latchedProvider() && isSealedType(type)) {
                droppedInbound++
                return Inbound.Drop("plaintext under the latch")
            }
            return Inbound.Deliver(json)
        }

        val session = sessionProvider()
            ?: run {
                droppedInbound++
                return Inbound.Drop("sealed frame with no session")
            }

        val envelope = try {
            E2eEnvelope.parse(json)
        } catch (e: E2eEnvelope.EnvelopeException) {
            droppedInbound++
            return Inbound.Drop("malformed envelope: ${e.message}")
        }

        return when (val opened = session.open(envelope, type)) {
            is E2eSession.Opened.Frame -> {
                val plain = String(opened.plaintext, Charsets.UTF_8)
                // FT-A1 MUST A-5: the receiver has to compare the hint against
                // the body it just unsealed, so the hint must travel with the
                // body to whoever does that compare. Merged as a sibling field
                // `ft` — the same name it had on the wire — so the handler
                // reads it the same way in sealed and open mode.
                if (type == FileTransfer.OFFER) {
                    val ft = hintOf(json)
                    if (ft != null) Inbound.Deliver(mergeHint(plain, ft))
                    else Inbound.Deliver(plain)
                } else {
                    Inbound.Deliver(plain)
                }
            }

            is E2eSession.Opened.Duplicate -> {
                // NOT an error. A resume legitimately re-sends buffered frames,
                // which is why the (w5) 1,000-frame replay expects zero
                // LEGITIMATE drops and a pile of duplicates.
                Inbound.Drop("duplicate")
            }

            is E2eSession.Opened.Undecryptable -> {
                droppedInbound++
                if (opened.requestRepair) repairRequested = true
                Inbound.Drop("undecryptable (repair=${opened.requestRepair})")
            }
        }
    }
}
