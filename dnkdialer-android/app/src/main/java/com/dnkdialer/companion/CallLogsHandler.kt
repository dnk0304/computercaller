package com.dnkdialer.companion

import android.content.Context
import android.provider.CallLog
import android.provider.ContactsContract

data class CallLogEntry(
    val id: String,
    val number: String,
    val name: String?,
    val date: Long,
    val duration: Int,
    val type: String, // "incoming", "outgoing", "missed"
    // PhoneAccount id this call was placed/received on. On most devices this
    // is the subscriptionId stringified ("1", "2"), but some OEMs use richer
    // labels like "sim1" / iccid hashes — we surface the raw string and let
    // the web client map it. null when the platform didn't tag the row.
    val simId: String? = null
)

class CallLogsHandler(private val context: Context) {

    // Cap removed 2026-05-26 per Dennis pivot ("just make it available for
    // users. If we want to cap it later, we can add a new tier."). Default
    // now: Int.MAX_VALUE (effectively unbounded). The `effectiveLimit` math
    // below already treats `limit <= 0` as "no cap" so this is a default
    // flip only — no behavior change for explicit callers.
    fun getCallLogs(limit: Int = Int.MAX_VALUE, since: Long = 0): List<CallLogEntry> {
        val callLogs = mutableListOf<CallLogEntry>()

        // When `since == 0L` ("All time"), do not cap results — return everything.
        // Otherwise honor the caller-provided limit.
        val effectiveLimit = if (limit <= 0) Int.MAX_VALUE else limit

        // Optional time-range filter — only return entries newer than `since` (epoch ms).
        // Parameterized to avoid SQL injection.
        val selection = if (since > 0) "${CallLog.Calls.DATE} > ?" else null
        val selectionArgs = if (since > 0) arrayOf(since.toString()) else null

        try {
            val cursor = context.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(
                    CallLog.Calls._ID,
                    CallLog.Calls.NUMBER,
                    CallLog.Calls.CACHED_NAME,
                    CallLog.Calls.DATE,
                    CallLog.Calls.DURATION,
                    CallLog.Calls.TYPE,
                    CallLog.Calls.PHONE_ACCOUNT_ID
                ),
                selection,
                selectionArgs,
                CallLog.Calls.DATE + " DESC"
            )

            cursor?.use {
                var count = 0
                while (it.moveToNext() && count < effectiveLimit) {
                    val id = it.getString(0) ?: continue
                    val number = it.getString(1) ?: "Unknown"
                    val cachedName = it.getString(2)
                    val date = it.getLong(3)
                    val duration = it.getInt(4)
                    val callType = it.getInt(5)
                    // PHONE_ACCOUNT_ID is "" or null when the platform didn't tag
                    // the row with a SIM (older devices, single-SIM, or system-
                    // generated entries). Surface as null in those cases.
                    val accountId = it.getString(6)?.takeIf { s -> s.isNotBlank() }

                    val typeString = when (callType) {
                        CallLog.Calls.INCOMING_TYPE -> "incoming"
                        CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                        CallLog.Calls.MISSED_TYPE -> "missed"
                        CallLog.Calls.REJECTED_TYPE -> "rejected"
                        else -> "unknown"
                    }

                    // Try to get contact name if cached name is not available
                    val name = cachedName ?: getContactName(number)

                    callLogs.add(
                        CallLogEntry(
                            id = id,
                            number = number,
                            name = name,
                            date = date,
                            duration = duration,
                            type = typeString,
                            simId = accountId
                        )
                    )
                    count++
                }
            }
        } catch (e: SecurityException) {
            android.util.Log.e("CallLogsHandler", "READ_CALL_LOG permission not granted", e)
            return emptyList()
        }

        return callLogs
    }

    private fun getContactName(phoneNumber: String): String? {
        try {
            val uri = ContactsContract.PhoneLookup.CONTENT_FILTER_URI.buildUpon()
                .appendPath(phoneNumber)
                .build()

            val cursor = context.contentResolver.query(
                uri,
                arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME),
                null,
                null,
                null
            )

            cursor?.use {
                if (it.moveToFirst()) {
                    return it.getString(0)
                }
            }
        } catch (e: SecurityException) {
            android.util.Log.w("CallLogsHandler", "Cannot look up contact name: permission denied")
        }

        return null
    }
}
