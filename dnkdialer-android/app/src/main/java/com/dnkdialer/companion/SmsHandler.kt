package com.dnkdialer.companion

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Telephony
import android.telephony.SmsManager

data class SmsMessage(
    val id: String,
    val address: String,
    val body: String,
    val date: Long,
    val type: String,
    // Optional base64-encoded JPEG thumbnail for image MMS messages. null for
    // SMS, non-image MMS, or when thumbnail extraction failed. Gson serialises
    // this as `"thumbnail": "..."` (or `"thumbnail": null`) which the web hook
    // attaches to the message for inline preview without a separate fetch.
    val thumbnail: String? = null,
    // Subscription / SIM id this message is attached to. Read from the
    // `sub_id` column on the SMS / MMS provider — typically populated on
    // Android 5.1+ for inbound messages on dual-SIM devices. null when the
    // platform didn't record it (older Android, single-SIM, or column missing).
    val simId: Int? = null
)

class SmsHandler(private val context: Context) {

    private val smsManager: SmsManager =
        context.getSystemService(SmsManager::class.java)

    fun sendSms(to: String, body: String, clientMsgId: String = "") {
        val parts = smsManager.divideMessage(body)

        // Build PendingIntent for send result
        val sendIntent = Intent("SMS_SENT").apply {
            putExtra("clientMsgId", clientMsgId)
            putExtra("to", to)
            `package` = context.packageName
        }
        val sentPI = PendingIntent.getBroadcast(
            context, clientMsgId.hashCode(),
            sendIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        // Build PendingIntent for delivery receipt (carrier-dependent, best-effort)
        val deliverIntent = Intent("SMS_DELIVERED").apply {
            putExtra("clientMsgId", clientMsgId)
            putExtra("to", to)
            `package` = context.packageName
        }
        val deliveredPI = PendingIntent.getBroadcast(
            context, clientMsgId.hashCode() + 1,
            deliverIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        if (parts.size == 1) {
            smsManager.sendTextMessage(to, null, body, sentPI, deliveredPI)
        } else {
            // For multipart, use ArrayList of PendingIntents
            val sentPIs = ArrayList<PendingIntent>().apply { repeat(parts.size) { add(sentPI) } }
            val deliveredPIs = ArrayList<PendingIntent>().apply { repeat(parts.size) { add(deliveredPI) } }
            smsManager.sendMultipartTextMessage(to, null, parts, sentPIs, deliveredPIs)
        }
    }

    // Cap removed 2026-05-26 per Dennis pivot ("just make it available for
    // users. If we want to cap it later, we can add a new tier."). The
    // previous default of 2500 forced silent truncation on phones with large
    // SMS histories — even though the user explicitly asked to sync "All
    // time". Default now: Int.MAX_VALUE (effectively unbounded). Callers can
    // still pass a positive `limit` to bound a specific call (e.g. the MMS
    // catch-up tick passes limit = 50). The existing `effectiveLimit` math
    // below already handles `limit <= 0` as "no cap" so this is a default
    // flip only — no behavior change for explicit callers.
    // `before` (epoch-ms, exclusive upper bound) was added 2026-05-27 for the
    // per-conversation "Older messages" backward-paging feature (Item 2). Unlike
    // `since`, which is the lower bound and gets CLEARED when an address filter is
    // set (open-thread default = full history), `before` is the UPPER bound and is
    // ALWAYS honoured even with an address filter — that's the whole point of
    // paging: "newest `limit` messages for this contact older than `before`".
    // before == 0 means "no upper bound" (newest-first from the top).
    fun getMessages(limit: Int = Int.MAX_VALUE, since: Long = 0, address: String? = null, before: Long = 0): List<SmsMessage> {
        val messages = mutableListOf<SmsMessage>()

        // When `since == 0L` ("All time"), do not cap results — return everything.
        // Otherwise honor the caller-provided limit.
        val effectiveLimit = if (limit <= 0) Int.MAX_VALUE else limit

        // When an address filter is supplied the caller wants ALL history for that
        // contact, regardless of the default "recent only" `since` window — clear
        // the time filter so we don't accidentally drop older messages.
        // NOTE: this clears `since` (lower bound) only. `before` (upper bound) is
        // never cleared here — backward paging relies on it surviving the address
        // filter.
        val effectiveSince = if (!address.isNullOrBlank()) 0L else since

        // Query SMS content provider
        val uri = Uri.parse("content://sms")
        val projection = arrayOf(
            Telephony.Sms._ID,
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE,
            Telephony.Sms.TYPE,
            // Subscription/SIM id — used to tag each row with the SIM it
            // arrived on / was sent through. May be missing on older API
            // levels; we guard the column lookup below with -1 fallback.
            "sub_id"
        )

        // Build WHERE clause from optional filters. Both branches stay
        // parameterized — no string concatenation of caller-supplied values
        // into the SQL itself, so SQL injection is impossible.
        //  - `since`   : only messages newer than this epoch-ms timestamp
        //  - `address` : exact match against the SMS provider's ADDRESS column.
        //                The provider may store numbers with or without country
        //                code prefix, so callers that need broader matching
        //                should normalize on their end before calling. Exact
        //                match is sufficient for the common "open this thread"
        //                use case the web client drives.
        val whereParts = mutableListOf<String>()
        val argsList = mutableListOf<String>()
        if (effectiveSince > 0) {
            whereParts.add("${Telephony.Sms.DATE} > ?")
            argsList.add(effectiveSince.toString())
        }
        if (!address.isNullOrBlank()) {
            whereParts.add("${Telephony.Sms.ADDRESS} = ?")
            argsList.add(address)
        }
        // Backward-paging upper bound: only rows strictly OLDER than `before`.
        // Exclusive (`<`) so the boundary message the caller already has is not
        // re-fetched — though even if it were, the web merge dedupes by id.
        // Stays parameterized (no SQL injection surface).
        if (before > 0) {
            whereParts.add("${Telephony.Sms.DATE} < ?")
            argsList.add(before.toString())
        }
        val selection = if (whereParts.isEmpty()) null else whereParts.joinToString(" AND ")
        val selectionArgs = if (argsList.isEmpty()) null else argsList.toTypedArray()

        try {
            // Note: passing "LIMIT N" inside sortOrder is unreliable across Android versions
            // (some OEMs strip or escape it). Enforce the limit by breaking out of the cursor
            // loop instead.
            context.contentResolver.query(
                uri,
                projection,
                selection,
                selectionArgs,
                "${Telephony.Sms.DATE} DESC"
            )?.use { cursor ->
                val idIndex = cursor.getColumnIndex(Telephony.Sms._ID)
                val addressIndex = cursor.getColumnIndex(Telephony.Sms.ADDRESS)
                val bodyIndex = cursor.getColumnIndex(Telephony.Sms.BODY)
                val dateIndex = cursor.getColumnIndex(Telephony.Sms.DATE)
                val typeIndex = cursor.getColumnIndex(Telephony.Sms.TYPE)
                // sub_id is best-effort — older API levels / some OEM SMS
                // providers don't expose this column. -1 means "not present".
                val subIdIndex = cursor.getColumnIndex("sub_id")

                while (cursor.moveToNext()) {
                    if (messages.size >= effectiveLimit) break

                    val id = cursor.getString(idIndex)
                    // Renamed from `address` to `rowAddress` to avoid shadowing the
                    // function parameter of the same name (the filter we may have
                    // applied to the query above).
                    val rowAddress = cursor.getString(addressIndex) ?: ""
                    val body = cursor.getString(bodyIndex) ?: ""
                    val date = cursor.getLong(dateIndex)
                    val typeInt = cursor.getInt(typeIndex)
                    val rawSubId = if (subIdIndex >= 0) cursor.getInt(subIdIndex) else -1
                    // sub_id of -1 (or column missing) means "no SIM info" — surface
                    // as null so the web client can render "default SIM" / no badge.
                    val simId = if (rawSubId >= 0) rawSubId else null

                    // Convert type int to string: 1=inbox, 2=sent
                    val type = when (typeInt) {
                        Telephony.Sms.MESSAGE_TYPE_INBOX -> "inbox"
                        Telephony.Sms.MESSAGE_TYPE_SENT -> "sent"
                        else -> "unknown"
                    }

                    // Skip sent messages where address = own SIM number (Samsung MSISDN quirk)
                    if (typeInt == Telephony.Sms.MESSAGE_TYPE_SENT) {
                        val ownNumbers = getOwnSimNumbers()
                        val cleanAddr = rowAddress.replace(Regex("[^0-9+]"), "")
                        val isSelf = ownNumbers.any { own ->
                            val cleanOwn = own.replace(Regex("[^0-9+]"), "")
                            cleanOwn.isNotEmpty() && (cleanOwn == cleanAddr || cleanOwn.endsWith(cleanAddr.takeLast(8)) || cleanAddr.endsWith(cleanOwn.takeLast(8)))
                        }
                        if (isSelf) continue
                    }

                    messages.add(SmsMessage(id, rowAddress, body, date, type, simId = simId))
                }
            }
        } catch (e: SecurityException) {
            android.util.Log.e("SmsHandler", "READ_SMS permission not granted", e)
            return emptyList()
        } catch (e: Exception) {
            android.util.Log.e("SmsHandler", "Error reading messages: ${e.message}", e)
        }

        android.util.Log.d("SmsHandler", "getMessages() returned ${messages.size} messages")
        return messages
    }

    private fun getOwnSimNumbers(): List<String> {
        return try {
            if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.LOLLIPOP_MR1) return emptyList()
            if (context.checkSelfPermission(android.Manifest.permission.READ_PHONE_STATE) != android.content.pm.PackageManager.PERMISSION_GRANTED) return emptyList()
            val sm = context.getSystemService(android.telephony.SubscriptionManager::class.java) ?: return emptyList()
            sm.activeSubscriptionInfoList?.mapNotNull { it.number?.takeIf { n -> n.isNotBlank() } } ?: emptyList()
        } catch (e: Exception) { emptyList() }
    }

    /**
     * Combined SMS + MMS history, merged and sorted by date desc, capped at `limit`.
     * MMS messages reuse the SmsMessage type (web client only knows that shape) but
     * their body is decorated with a media-type emoji prefix for non-text payloads.
     *
     * MmsHandler is constructed per-call (cheap — it's a thin wrapper around the
     * ContentResolver) so we don't hold a reference to a per-Service context here.
     */
    fun getMessagesWithMms(
        context: Context,
        // Cap removed 2026-05-26 per Dennis pivot — see getMessages() above.
        limit: Int = Int.MAX_VALUE,
        since: Long = 0,
        address: String? = null,
        // Backward-paging upper bound (epoch-ms, exclusive). See getMessages().
        // For address-filtered paging this only affects the SMS path — MMS with
        // an address filter is still skipped below (known SMS-only limitation).
        before: Long = 0
    ): List<SmsMessage> {
        // Get SMS messages — pass the optional address filter through so the SQL
        // WHERE clause runs in the provider (fast, indexed) instead of us
        // post-filtering in Kotlin.
        val smsMessages = getMessages(limit, since, address, before)

        // Get MMS messages. The MMS provider stores recipient addresses in a
        // separate `addr` sub-table keyed by message id, so an exact "address
        // equals X" filter requires a join we don't currently support in
        // MmsHandler. When an address filter is active we skip MMS entirely —
        // the typical "open thread" flow on the web client wants SMS history
        // for that contact; MMS for the same contact will arrive via the
        // normal sync path. This keeps the change minimal and safe.
        val mmsHandler = MmsHandler(context)
        val mmsMessages = if (!address.isNullOrBlank()) {
            emptyList()
        } else {
            mmsHandler.getMessages(limit, since)
        }

        // Convert MMS to SmsMessage format (reuse existing type so the web client
        // does not need a new shape). For media MMS we prefix the body with a
        // media-type emoji and fall back to a placeholder when there is no text.
        // For image MMS we also extract a small base64 JPEG thumbnail so the web
        // can render the preview inline without a separate fetch round-trip.
        val convertedMms = mmsMessages.map { mms ->
            // mms.id has the form "mms_<rawId>" — MmsHandler's helpers expect the
            // raw provider id, so strip the prefix once here.
            val rawId = mms.id.removePrefix("mms_")
            val thumb = if (mms.mmsType == "image") mmsHandler.getThumbnail(rawId) else null
            SmsMessage(
                id = mms.id,
                address = mms.address,
                body = when (mms.mmsType) {
                    "image" -> if (mms.body.isNotBlank()) "📷 ${mms.body}" else "📷 [Image]"
                    "audio" -> if (mms.body.isNotBlank()) "🎵 ${mms.body}" else "🎵 [Voice message]"
                    "video" -> if (mms.body.isNotBlank()) "🎬 ${mms.body}" else "🎬 [Video]"
                    "other" -> if (mms.body.isNotBlank()) mms.body else "📎 [Attachment]"
                    else -> mms.body.ifBlank { "[MMS]" }
                },
                date = mms.date,
                type = mms.type,
                thumbnail = thumb,
                // MmsHandler doesn't currently surface sub_id — pass through whatever
                // MmsMessage carries (null today, but future-proofed if MmsHandler
                // grows that field later).
                simId = null
            )
        }

        // Merge and sort by date descending, cap at limit.
        // When limit <= 0 the SMS path treats it as "all time" / no cap, so mirror
        // that here too for consistency.
        val effectiveLimit = if (limit <= 0) Int.MAX_VALUE else limit
        return (smsMessages + convertedMms)
            .sortedByDescending { it.date }
            .take(effectiveLimit)
    }
}
