package com.dnkdialer.companion

import android.content.Context
import org.json.JSONObject

/**
 * FT-2 (c) — the durable half of resume.
 *
 * What a resume needs to survive a process death is small and awkward: the
 * transfer id, the sha256 the sender declared, how many bytes are durably on
 * disk, and the SAF document the bytes are in. The spec says "persist beside
 * the .part file"; SAF gives us no place beside it, so it lives in prefs keyed
 * by id and points AT the document.
 *
 * ## The one rule that makes this safe
 *
 * [upTo] is written **after** the file descriptor is synced, never before. If
 * we crash between the sync and the write, we resume from an older point and
 * re-receive chunks we already have — wasteful and correct. If we wrote it
 * first we would resume past bytes that never reached the platter, and the
 * only thing that would notice is the sha256 at the very end of a 1 GB
 * transfer, which is the most expensive possible place to find out.
 *
 * The receiver also truncates the document back to [bytesWritten] on resume,
 * so an unsynced tail is discarded rather than left in the middle of the file.
 *
 * ## Versioning
 *
 * The record carries `v`. An unknown version is DISCARDED (and its .part
 * deleted by the caller) rather than parsed optimistically — RESUME-PROTOCOL
 * v2 item 6: a resumer must never "work on my machine" against an old record.
 */
object FileTransferStore {

    private const val PREFS = "file_transfer_resume"
    private const val KEY_PENDING = "pending"
    private const val VERSION = 1

    /** A receive that can be picked up again. */
    data class Pending(
        val id: String,
        val sha256: String,
        val name: String,
        val size: Long,
        /** Highest contiguous seq DURABLY written. [FileTransfer.NOTHING_RECEIVED] if none. */
        val upTo: Int,
        val bytesWritten: Long,
        /** The SAF document holding the `.part` bytes. */
        val uri: String,
        val savedAtMs: Long,
    )

    private fun prefs(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Persist the resume point. Call only AFTER the descriptor is synced. */
    fun save(ctx: Context, p: Pending) {
        val o = JSONObject()
            .put("v", VERSION)
            .put("id", p.id)
            .put("sha256", p.sha256)
            .put("name", p.name)
            .put("size", p.size)
            .put("upTo", p.upTo)
            .put("bytesWritten", p.bytesWritten)
            .put("uri", p.uri)
            .put("savedAtMs", p.savedAtMs)
        prefs(ctx).edit().putString(KEY_PENDING, o.toString()).commit()
    }

    /**
     * The pending receive, or null.
     *
     * Returns null — and leaves the record in place for [clear] — on an
     * unknown version, a parse failure, or an expired window. Three ways to
     * get null, one meaning: do not resume this.
     */
    fun load(ctx: Context, nowMs: Long): Pending? {
        val raw = prefs(ctx).getString(KEY_PENDING, null) ?: return null
        return try {
            val o = JSONObject(raw)
            val v = o.optInt("v", -1)
            if (v != VERSION) {
                android.util.Log.w(
                    "FileTransferStore",
                    "discarding resume record: version $v, this build speaks $VERSION"
                )
                return null
            }
            val p = Pending(
                id = o.getString("id"),
                sha256 = o.getString("sha256"),
                name = o.getString("name"),
                size = o.getLong("size"),
                upTo = o.getInt("upTo"),
                bytesWritten = o.getLong("bytesWritten"),
                uri = o.getString("uri"),
                savedAtMs = o.getLong("savedAtMs"),
            )
            if (nowMs - p.savedAtMs > FileTransfer.RESUME_WINDOW_MS) {
                android.util.Log.i("FileTransferStore", "resume record expired")
                return null
            }
            p
        } catch (e: Exception) {
            android.util.Log.w("FileTransferStore", "unparseable resume record: ${e.message}")
            null
        }
    }

    /** The raw record regardless of version/expiry — so the caller can delete its .part. */
    fun loadUriForCleanup(ctx: Context): String? = try {
        prefs(ctx).getString(KEY_PENDING, null)?.let { JSONObject(it).optString("uri", null) }
    } catch (e: Exception) {
        null
    }

    fun clear(ctx: Context) {
        prefs(ctx).edit().remove(KEY_PENDING).commit()
    }
}
