package com.dnkdialer.companion

import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL

/**
 * E2E programme, phase P4 Part 2 (e) — the DeviceKey registry client.
 *
 * Talks to P1's routes (merged at `96042d0`):
 * ```
 *   POST /api/devicekeys/register  {deviceId, kind, publicKey, label?}
 *                                  -> {key, rotated}      409 pairing_in_flight
 *   GET  /api/devicekeys/list      -> {keys: [...]}
 *   POST /api/devicekeys/revoke    {deviceId} -> {key, alreadyRevoked}
 * ```
 *
 * ## Auth: the phone's bearer, and why no CSRF header is sent
 *
 * `lib/deviceKeyAuth.resolveCaller` tries the session cookie FIRST and falls
 * back to `Authorization: Bearer <phoneToken>` — the same token the phone
 * already presents on the relay WebSocket. `userId` is taken from whichever
 * proof succeeded and **never** from the body; sending one would be ignored, so
 * this client does not send one.
 *
 * `register/route.ts:21-35` applies `requireSameOrigin` **only when
 * `caller.via === 'session'`**. A phone presenting a bearer is not a browser
 * and has no ambient credential for a third party to ride, so requiring an
 * Origin header it will never send would lock the phone out of registering the
 * key that matters most. Verified by reading the route, not assumed: a
 * speculative `Origin` header here would be cargo cult, and if the gate ever
 * changes this client would start getting 403 "CSRF check failed" — which
 * [Result.Forbidden] surfaces verbatim rather than swallowing.
 *
 * ## Deliberately low-dependency
 *
 * `HttpURLConnection` on a caller-supplied background thread, matching
 * [SignInActivity]'s existing convention. Pulling OkHttp in for three calls
 * would grow the APK and the lint baseline for no benefit.
 *
 * **Never call these on the main thread.** Every method blocks.
 */
object E2eDeviceKeyClient {

    private const val BASE = "https://computercaller.com/api/devicekeys"
    private const val TIMEOUT_MS = 10_000

    /** A row as the registry reports it. */
    data class DeviceKeyRow(
        val deviceId: String,
        val kind: String,
        val publicKey: String,
        val label: String?,
        val revokedAt: String?,
    ) {
        val isRevoked: Boolean get() = revokedAt != null

        /** The key as bytes, or null when the registry holds something unusable. */
        fun publicKeyBytes(): ByteArray? =
            runCatching { E2eKeyEncoding.fromBase64Url(publicKey) }
                .getOrNull()
                ?.takeIf { E2eKeyEncoding.isValid(it) }
    }

    /**
     * Every outcome, as a type. A boolean or a nullable would collapse
     * "the registry says no" into "the registry is unreachable", and §13.6
     * gives those two OPPOSITE handling: a mismatch always refuses, while an
     * unreachable registry fails closed only in mode ON.
     */
    sealed interface Result<out T> {
        data class Ok<T>(val value: T) : Result<T>

        /** 409 — a pairing handshake is mid-flight. Retry after it settles. */
        data object PairingInFlight : Result<Nothing>

        /** 401/403. [message] is the server's own, surfaced not swallowed. */
        data class Forbidden(val status: Int, val message: String) : Result<Nothing>

        /** Network failure, timeout, 5xx, unparseable body. */
        data class Unavailable(val reason: String) : Result<Nothing>
    }

    /** Register or rotate this device's key. Blocking. */
    fun register(
        phoneToken: String,
        deviceId: String,
        publicKeySec1: ByteArray,
        label: String? = null,
    ): Result<Pair<DeviceKeyRow, Boolean>> {
        val body = JSONObject().apply {
            put("deviceId", deviceId)
            put("kind", "phone")
            put("publicKey", E2eKeyEncoding.toBase64Url(publicKeySec1))
            if (label != null) put("label", label)
            // NOTE: no userId. The route ignores a body userId (B8) and takes
            // the caller from the bearer.
        }.toString()

        return request("POST", "$BASE/register", phoneToken, body) { json ->
            val row = parseRow(json.getJSONObject("key"))
            row to json.optBoolean("rotated", false)
        }
    }

    /** The caller's OWN rows. There is no userId parameter, by design. Blocking. */
    fun list(phoneToken: String, includeRevoked: Boolean = true): Result<List<DeviceKeyRow>> {
        val url = "$BASE/list" + if (includeRevoked) "" else "?includeRevoked=0"
        return request("GET", url, phoneToken, null) { json ->
            val arr: JSONArray = json.optJSONArray("keys") ?: JSONArray()
            (0 until arr.length()).map { parseRow(arr.getJSONObject(it)) }
        }
    }

    /** Revoke a device's key. Blocking. */
    fun revoke(phoneToken: String, deviceId: String): Result<Pair<DeviceKeyRow, Boolean>> {
        val body = JSONObject().apply { put("deviceId", deviceId) }.toString()
        return request("POST", "$BASE/revoke", phoneToken, body) { json ->
            parseRow(json.getJSONObject("key")) to json.optBoolean("alreadyRevoked", false)
        }
    }

    // ------------------------------------------------------------ internal

    private fun parseRow(o: JSONObject) = DeviceKeyRow(
        deviceId = o.optString("deviceId", ""),
        kind = o.optString("kind", ""),
        publicKey = o.optString("publicKey", ""),
        label = if (o.isNull("label")) null else o.optString("label", null),
        revokedAt = if (o.isNull("revokedAt")) null else o.optString("revokedAt", null),
    )

    private fun <T> request(
        method: String,
        urlStr: String,
        phoneToken: String,
        body: String?,
        parse: (JSONObject) -> T,
    ): Result<T> {
        if (phoneToken.isBlank()) return Result.Forbidden(401, "no phone token")
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                setRequestProperty("Accept", "application/json")
                // The one credential. See the class doc on why no Origin.
                setRequestProperty("Authorization", "Bearer $phoneToken")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("Content-Type", "application/json")
                }
            }
            if (body != null) OutputStreamWriter(conn.outputStream).use { it.write(body) }

            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()

            when {
                code in 200..299 -> Result.Ok(parse(JSONObject(text)))
                code == 409 -> Result.PairingInFlight
                code == 401 || code == 403 ->
                    Result.Forbidden(code, errorOf(text) ?: "request refused")
                else -> Result.Unavailable("HTTP $code${errorOf(text)?.let { ": $it" } ?: ""}")
            }
        } catch (e: java.io.IOException) {
            Result.Unavailable(e.javaClass.simpleName + ": " + (e.message ?: "network failure"))
        } catch (e: org.json.JSONException) {
            // A 200 we cannot parse is NOT a mismatch — it is an unavailable
            // registry, and §13.6 handles those differently.
            Result.Unavailable("unparseable response: ${e.message}")
        } finally {
            conn?.disconnect()
        }
    }

    private fun errorOf(text: String): String? =
        runCatching { JSONObject(text).optString("error", "").takeIf { it.isNotEmpty() } }
            .getOrNull()
}
