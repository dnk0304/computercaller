package com.dnkdialer.companion

import java.security.SecureRandom
import java.util.Locale

/**
 * FT-2 — the pure core of phone ⇄ PC file transfer.
 *
 * Everything in this file is JVM-testable: no Android imports, no I/O, no
 * clock. The frame names, the two constants everything else is derived from,
 * the filename sanitiser and the slicing arithmetic live here so that the
 * parts most likely to be wrong are the parts that can be proved on the unit
 * lane instead of on an emulator.
 *
 * Wire protocol — FROZEN by DISPATCH-BRIEF-FT-2 (relay side is FT-1):
 * ```
 *   FILE_OFFER  {id,name,size,mime,sha256,from}
 *   FILE_ACCEPT {id}
 *   FILE_REJECT {id}
 *   FILE_CHUNK  {id,seq,n,data}      data = base64 of <= CHUNK_RAW_BYTES bytes
 *   FILE_ACK    {id,upTo}
 *   FILE_RESUME {id,upTo}
 *   FILE_DONE   {id,sha256}
 *   FILE_FAILED {id,reason}
 * ```
 *
 * `upTo` is the **highest contiguous seq durably written by the receiver**, or
 * [NOTHING_RECEIVED] when none. One definition, shared by FILE_ACK and
 * FILE_RESUME on purpose: a resume is an ACK that survived a reconnect, and
 * two definitions of "how far did we get" is how an off-by-one becomes a
 * corrupted file that still passes its own byte count.
 */
object FileTransfer {

    // ------------------------------------------------------------- limits

    /**
     * 1 GiB per file. Spec Addendum A, DECIDED by Dennis 2026-09-17.
     *
     * The phone MIRRORS this for UX (refuse the pick with the same copy the
     * server would send back); the server is the only enforcer. A client-side
     * cap that the user believes is the rule is a client-side cap an attacker
     * edits out of the APK.
     */
    const val MAX_FILE_BYTES: Long = 1_073_741_824L

    /**
     * 2 GiB per UTC day, sender-side. Mirrored for COPY only, never enforced.
     *
     * There is deliberately no local "used today" accumulator on the phone.
     * The relay meters ACTUAL `FILE_CHUNK` wire bytes and charges those
     * (FT-A1 MUST A-3/A-4), so any number the phone kept would be a second,
     * always-slightly-wrong copy of a figure the server already owns — and the
     * first time they disagreed the user would be told the wrong thing.
     *
     * If one is ever added: it counts bytes this device ACTUALLY SENT. Never
     * the declared size, and never `ft.size` — the hint is untrusted input
     * (FT-A1 MUST C-3) and a quota built on it is a quota the sender sets.
     */
    const val DAILY_QUOTA_BYTES: Long = 2_147_483_648L

    /**
     * 48 KiB of raw bytes per chunk → exactly 65,536 B of base64. Spec §1.
     *
     * The base64 expansion is the reason this number is 48 KiB and not 64:
     * 49,152 × 4/3 = 65,536 lands on a power of two under the relay's payload
     * cap with the E2E seal's tag/nonce/JSON headroom still to spare.
     */
    const val CHUNK_RAW_BYTES: Int = 49_152

    /** Sender stops at 16 unacked chunks (~1 MB in flight). Spec §1 backpressure. */
    const val ACK_WINDOW_CHUNKS: Int = 16

    /** Receiver emits FILE_ACK every 8 chunks, and on the final chunk. */
    const val ACK_EVERY_CHUNKS: Int = 8

    /**
     * Sender defers the next chunk while the socket has more than 2 MB queued.
     *
     * The ACK window bounds the PEER; this bounds US. On a slow uplink the
     * peer's ACKs keep arriving for chunks the socket has accepted but not yet
     * put on the wire, so the window alone does not stop the outbound queue
     * from growing without limit.
     */
    const val OUTBOUND_WATERMARK_BYTES: Long = 2L * 1024 * 1024

    /** 30 s with no chunk (receiver) / no ACK (sender) → FILE_FAILED timeout. */
    const val STALL_TIMEOUT_MS: Long = 30_000L

    /** 60 s with no FILE_ACCEPT → the offer expires, sender fails it cancelled. */
    const val OFFER_EXPIRY_MS: Long = 60_000L

    /** How long a half-written receive stays resumable after the socket drops. */
    const val RESUME_WINDOW_MS: Long = 10 * 60_000L

    /** `upTo` when the receiver has durably written nothing. */
    const val NOTHING_RECEIVED: Int = -1

    // -------------------------------------------------------------- frames

    const val OFFER = "FILE_OFFER"
    const val ACCEPT = "FILE_ACCEPT"
    const val REJECT = "FILE_REJECT"
    const val CHUNK = "FILE_CHUNK"
    const val ACK = "FILE_ACK"
    const val RESUME = "FILE_RESUME"
    const val DONE = "FILE_DONE"
    const val FAILED = "FILE_FAILED"

    /** Every frame this feature speaks. Used by the dispatcher and by tests. */
    val FRAMES: Set<String> = setOf(OFFER, ACCEPT, REJECT, CHUNK, ACK, RESUME, DONE, FAILED)

    // ------------------------------------------------------------- reasons

    /** `FILE_FAILED.reason`, FROZEN by the brief. Nothing else may be sent. */
    object Reason {
        const val HASH_MISMATCH = "hash_mismatch"
        const val CONNECTION_LOST = "connection_lost"
        const val RELAY_BACKPRESSURE = "relay_backpressure"
        const val CANCELLED = "cancelled"
        const val TIMEOUT = "timeout"
        const val TOO_LARGE = "too_large"
        const val OOM = "oom"
        const val QUOTA = "quota"
        const val TIER = "tier"

        /**
         * FT-A1 MUST A-7. The unsealed `FILE_OFFER` body disagreed with the
         * envelope's `ft` hint.
         *
         * Its own reason rather than `cancelled` or `hash_mismatch` because
         * those mislabel a tamper event as user action or as corruption, and
         * the one thing this failure must do is be legible afterwards.
         */
        const val SIZE_MISMATCH = "size_mismatch"

        val ALL: Set<String> = setOf(
            HASH_MISMATCH, CONNECTION_LOST, RELAY_BACKPRESSURE, CANCELLED,
            TIMEOUT, TOO_LARGE, OOM, QUOTA, TIER, SIZE_MISMATCH,
        )
    }

    /** This device's identity in `FILE_OFFER.from`. */
    const val FROM_PHONE = "phone"

    // ------------------------------------------------------ sealing policy

    /**
     * **The single place that decides which FILE_* frames are sealed.**
     *
     * GATE1 Addendum **FT-A1 §3 (C), RATIFIED 2026-09-18**: every FILE_* frame
     * goes through the `PhoneClient` seal chokepoint like every other frame,
     * sealed when mode is ON. No new path and no exception — so this returns
     * true for the whole family.
     *
     * `FILE_CHUNK` is additionally padding-EXEMPT with no amendment, because
     * §13.4 keys that exemption on the `*_CHUNK` SUFFIX rather than on a list,
     * and a fixed-count bulk transfer already discloses its size through `n`.
     *
     * The relay does not lose its gate by this: the frame TYPE travels in the
     * clear on every frame (`TYPE:body`) and is bound into the AAD, so the
     * relay can drive its per-room record, its stall timer and its
     * accept-before-chunks rule from the type alone (FT-A1 §0/Q1). What it
     * needs beyond the type — the transfer id and the declared size — arrives
     * as the [hintFor] envelope hint, not by leaving the body in the clear.
     *
     * Superseded: spec line 176's "plaintext `size` on FILE_OFFER". The
     * plaintext size is now the hint; the SEALED `size` is authoritative.
     */
    fun isSealedFrame(type: String): Boolean = type in FRAMES

    /** The envelope hint key. Rides OUTSIDE the AAD — see [hintFor]. */
    const val HINT_KEY = "ft"

    /**
     * FT-A1 **MUST A-1 / C-1 / C-2** — the plaintext relay hint, or null.
     *
     * Only `FILE_OFFER` carries one, and it carries exactly `{id, size}`.
     * `FILE_CHUNK` and the six control frames carry none.
     *
     * ## Why a hint exists at all
     *
     * The relay charges the sender's quota and enforces the tier at the
     * FILE_OFFER gate, and under mode ON it cannot read the sealed body. The
     * hint is the minimum it needs: an opaque 16-byte id to meter against, and
     * a declared size for admission control.
     *
     * ## Why it is OUTSIDE the AAD, and therefore untrusted
     *
     * Binding it would mean either a new AAD tag on EVERY frame (breaking the
     * frozen `kdf-vectors.json` on three implementations) or a
     * frame-type-conditional AAD — two AAD layouts in a protocol that has one.
     * It also buys nothing: vector L2 shows a relay that lowers `ft.size`
     * produces a BYTE-IDENTICAL ciphertext, and the receiver's compare
     * ([hintMatches]) refuses anyway. A tampering relay's only achievable
     * outcome is "transfer fails", which it could get by dropping a packet.
     *
     * So: **this is a hint from an untrusted party. The sealed value is the
     * fact.** Never allocate from it, never show it, never meter with it.
     */
    fun hintFor(type: String, sealedBody: Map<String, Any?>): Map<String, Any?>? {
        if (type != OFFER) return null
        val id = sealedBody["id"] as? String ?: return null
        val size = (sealedBody["size"] as? Number)?.toLong() ?: return null
        return mapOf("id" to id, "size" to size)
    }

    /**
     * FT-A1 **MUST A-5 / C-3** — the receiver's compare, before anything else.
     *
     * True when the envelope hint is consistent with the body we just
     * unsealed. The caller refuses with [Reason.SIZE_MISMATCH] otherwise, and
     * must do so BEFORE any UI prompt, any FILE_ACCEPT and any save picker —
     * a refusal after the picker has opened has already spent the user's
     * attention on a transfer that was never going to happen.
     *
     * [sealedModeOn] is what makes this fail CLOSED: under mode ON a missing
     * hint is a stripped hint, which is exactly what a relay that wants to
     * bypass the quota gate would send. Under mode OFF there is no envelope
     * and so no hint, and requiring one would refuse every honest transfer.
     */
    fun hintMatches(
        hint: Map<*, *>?,
        sealedId: String,
        sealedSize: Long,
        sealedModeOn: Boolean,
    ): Boolean {
        if (hint == null) return !sealedModeOn
        val id = hint["id"] as? String ?: return false
        val size = (hint["size"] as? Number)?.toLong() ?: return false
        if (size < 0 || size > MAX_FILE_BYTES) return false
        return id == sealedId && size == sealedSize
    }

    // ------------------------------------------------------------------ id

    private val rng = SecureRandom()

    /**
     * 16 random bytes as lowercase hex. Spec §2.
     *
     * SecureRandom rather than Random: the id is the relay's routing key and
     * its accept-before-chunks gate key, so a guessable id lets a third party
     * in the same room inject chunks into somebody else's accepted transfer.
     */
    fun newTransferId(): String {
        val b = ByteArray(16)
        rng.nextBytes(b)
        return hex(b)
    }

    fun hex(bytes: ByteArray): String {
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            sb.append("0123456789abcdef"[(b.toInt() shr 4) and 0xF])
            sb.append("0123456789abcdef"[b.toInt() and 0xF])
        }
        return sb.toString()
    }

    // ------------------------------------------------------------- slicing

    /**
     * How many chunks a file of [size] bytes becomes.
     *
     * A zero-byte file is **zero chunks**, not one empty chunk: FILE_DONE
     * follows FILE_ACCEPT directly and the receiver writes nothing. One empty
     * chunk would work too, but then `n` and the byte count disagree about
     * what "empty" is, and the relay's declared-size rule reasons about bytes.
     */
    fun chunkCount(size: Long): Int {
        require(size >= 0) { "negative size" }
        return ((size + CHUNK_RAW_BYTES - 1) / CHUNK_RAW_BYTES).toInt()
    }

    /** Byte offset where chunk [seq] starts. */
    fun offsetOf(seq: Int): Long {
        require(seq >= 0) { "negative seq" }
        return seq.toLong() * CHUNK_RAW_BYTES
    }

    /** Length of chunk [seq] in a file of [size] bytes. */
    fun lengthOf(seq: Int, size: Long): Int {
        val start = offsetOf(seq)
        require(start < size) { "seq $seq past end of $size" }
        return minOf(CHUNK_RAW_BYTES.toLong(), size - start).toInt()
    }

    /**
     * Bytes durably written when the receiver's highest contiguous seq is
     * [upTo]. The inverse of [chunkCount] for resume.
     *
     * Clamped to [size] because the last chunk is short: without the clamp a
     * resume of a 100-byte file at upTo=0 would claim 49,152 bytes written and
     * the sender would slice from past the end.
     */
    fun bytesThrough(upTo: Int, size: Long): Long {
        if (upTo < 0) return 0L
        return minOf((upTo + 1).toLong() * CHUNK_RAW_BYTES, size)
    }

    /** First seq a sender must send when the receiver reports [upTo]. */
    fun resumeFrom(upTo: Int): Int = if (upTo < 0) 0 else upTo + 1

    /** Should the receiver ACK after durably writing chunk [seq] of [n]? */
    fun shouldAck(seq: Int, n: Int): Boolean =
        seq == n - 1 || (seq + 1) % ACK_EVERY_CHUNKS == 0

    // ------------------------------------------------------------ filename

    /** Longest sanitised name we will create, extension included. */
    const val MAX_NAME_CHARS: Int = 100

    private const val FALLBACK_NAME = "file"

    /**
     * Turn an attacker-controlled `FILE_OFFER.name` into something safe to
     * hand a SAF create-document call.
     *
     * A sender-supplied name is input, not a filename. The rules, and why each
     * one is here rather than "SAF will handle it":
     *
     *  - **path separators and `..`** — SAF's own display names are not paths,
     *    but the name is also used in notifications, in the `.part` name, and
     *    (on some OEM document providers) reaches a real path. Stripping is one
     *    line; trusting four layers is not.
     *  - **control characters and NUL** — a NUL truncates the name in any C
     *    layer it reaches, so `safe.txt .apk` displays as `safe.txt` and
     *    lands as something else. This is the one that actually matters.
     *  - **leading dots** — a name beginning `.` is hidden on every Unix-ish
     *    view, which is exactly what a file you did not mean to accept wants.
     *  - **length** — capped at [MAX_NAME_CHARS] **preserving the extension**,
     *    because truncating from the right silently changes the file type.
     *
     * The extension is NOT forced to match the declared mime. Spec §6 asks for
     * that; the brief's frozen frame set has no mime allow-list on the phone
     * and a mime→extension table that disagrees with reality renames correct
     * files. What protects the user here is the accept dialog showing the name
     * before a byte is written, which is the spec's own stated mitigation.
     */
    fun sanitizeName(raw: String?): String {
        var s = raw ?: ""
        // Separators first: turning "a/b" into "a_b" must happen before the
        // leading-dot strip, or "/.." sanitises to ".." by a different route.
        s = s.map { c ->
            when {
                c == '/' || c == '\\' -> '_'
                c.code < 0x20 || c.code == 0x7F -> '_'
                c == ':' || c == '*' || c == '?' || c == '"' ||
                    c == '<' || c == '>' || c == '|' -> '_'
                else -> c
            }
        }.joinToString("")
        s = s.trim()
        while (s.startsWith(".")) s = s.substring(1)
        s = s.trim()
        if (s == ".." || s.isEmpty()) return FALLBACK_NAME
        return capLength(s)
    }

    /** Cap to [MAX_NAME_CHARS] characters, keeping the extension intact. */
    private fun capLength(name: String): String {
        if (name.length <= MAX_NAME_CHARS) return name
        val dot = name.lastIndexOf('.')
        // An "extension" longer than 15 chars is not an extension, it is the
        // rest of the name — truncate plainly rather than keep 80 chars of it.
        val ext = if (dot > 0 && name.length - dot <= 16) name.substring(dot) else ""
        val stemRoom = MAX_NAME_CHARS - ext.length
        if (stemRoom <= 0) return name.substring(0, MAX_NAME_CHARS)
        return name.substring(0, stemRoom) + ext
    }

    /** The in-progress name. Renamed to the real one only after sha256 verifies. */
    fun partNameFor(sanitized: String): String = "$sanitized.part"

    /**
     * `holiday.jpg` → `holiday (1).jpg` → `holiday (2).jpg` …
     *
     * Only used where the document provider does not de-duplicate for us;
     * SAF's CREATE_DOCUMENT already does, which is why the receiver leans on
     * SAF first and on this second.
     */
    fun collisionName(sanitized: String, attempt: Int): String {
        if (attempt <= 0) return sanitized
        val dot = sanitized.lastIndexOf('.')
        val stem = if (dot > 0) sanitized.substring(0, dot) else sanitized
        val ext = if (dot > 0) sanitized.substring(dot) else ""
        return capLength("$stem ($attempt)$ext")
    }

    // ---------------------------------------------------------------- copy

    /** "4.2 MB" — display only, never used in arithmetic. */
    fun humanSize(bytes: Long): String {
        if (bytes < 1024) return "$bytes B"
        val units = arrayOf("KB", "MB", "GB", "TB")
        var v = bytes.toDouble() / 1024.0
        var i = 0
        while (v >= 1024.0 && i < units.lastIndex) {
            v /= 1024.0
            i++
        }
        return String.format(Locale.US, if (v >= 100) "%.0f %s" else "%.1f %s", v, units[i])
    }

    /**
     * Seconds remaining at the observed rate, or null when we cannot say yet.
     *
     * Returns null rather than a guess for the first second of a transfer: an
     * ETA computed off two chunks is wrong by an order of magnitude and a
     * progress notification that says "4 hours" then "20 seconds" reads as a
     * broken app.
     */
    fun etaSeconds(sentBytes: Long, totalBytes: Long, elapsedMs: Long): Long? {
        if (elapsedMs < 1_000L || sentBytes <= 0L || sentBytes >= totalBytes) return null
        val bytesPerMs = sentBytes.toDouble() / elapsedMs.toDouble()
        if (bytesPerMs <= 0.0) return null
        return ((totalBytes - sentBytes) / bytesPerMs / 1000.0).toLong()
    }
}
