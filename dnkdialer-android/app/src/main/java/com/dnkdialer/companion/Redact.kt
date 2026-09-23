package com.dnkdialer.companion

import java.security.MessageDigest

/**
 * T-VC63-EXPORT-DIAGNOSTICS — the redactor.
 *
 * Every line that reaches [DiagStore] — and every line of logcat that reaches
 * the export zip — passes through [line] first. This is DEFENCE IN DEPTH, not
 * the policy: call sites are required to pass metadata only (ids, sizes, codes,
 * enum names). Message bodies, notification text, contact names, file names,
 * tokens, device keys and SAS digits are never handed to DiagLog at all.
 *
 * The redactor exists because "never" is a promise made by ~60 call sites, and
 * one of them will eventually be wrong. INC-0923 is exactly the incident class
 * this export is for — a user mails Ken a zip — so a single leaked SMS body or
 * phone number in that zip is a privacy incident, not a bug.
 *
 * Pure JVM on purpose: no android.* import, so the unit suite can assert every
 * branch without Robolectric.
 *
 * ## What is replaced
 *
 *  - **Phone-number-shaped runs** — any token made of digits, spaces and
 *    dashes (optionally `+`-prefixed) containing **7 or more digits** becomes
 *    `num:<6 hex>`, where the hex is the first 6 characters of
 *    SHA-256(E.164-normalised form). 7 is the floor because Norwegian numbers
 *    are 8 digits and the shortest NANP subscriber number is 7; below that the
 *    token is far more likely to be a byte count, a timestamp or an id.
 *  - **Email-shaped tokens** — `email:<6 hex>`.
 *  - **Over-long lines** — truncated to [MAX_LEN] with a `...[n]` suffix.
 *
 * The 6-hex hash is a CORRELATION handle, not an identity: it lets Ken see
 * "the same number appears in these four events" without learning the number.
 * 24 bits is deliberately weak against a brute-force reversal of a *known*
 * candidate — which is fine, because an attacker holding the candidate already
 * holds the number. It is not a security boundary; the security boundary is
 * that the number never enters the file.
 *
 * ## Normalisation
 *
 * `+47 123 45 678` and `4712345678` normalise to `+4712345678` / `4712345678`
 * respectively — the leading `+` is preserved, all other non-digits dropped.
 * The two therefore hash DIFFERENTLY. That is intentional: guessing which
 * national prefix an un-prefixed local number belongs to would make the
 * redactor's output depend on a locale assumption, and a wrong guess silently
 * breaks correlation. Call sites that want stable correlation across formats
 * normalise before logging (SmsReceiver does).
 */
object Redact {

    /** Longest line stored verbatim. Beyond this the tail is dropped. */
    const val MAX_LEN = 160

    /** Minimum digit count for a token to be treated as a phone number. */
    const val MIN_PHONE_DIGITS = 7

    /**
     * Email first, then numbers.
     *
     * Order is load-bearing: `a1234567@example.com` contains a 7-digit run, so
     * running the number rule first would rewrite the local part and leave the
     * domain — a half-redacted address that still identifies the user. Email is
     * the more specific shape, so it wins.
     */
    private val EMAIL = Regex("""[A-Za-z0-9._%+\-]+@[A-Za-z0-9](?:[A-Za-z0-9.\-]*[A-Za-z0-9])?\.[A-Za-z]{2,}""")

    /**
     * Candidate phone runs. Deliberately over-matches (it will happily grab
     * `1 2 3 4 5 6 7`) and is then filtered on digit count by [redactNumbers],
     * because "7+ digits with optional separators" is a count condition and a
     * single regex that enforces it is unreadable and backtracking-prone.
     */
    private val PHONE_CANDIDATE = Regex("""\+?\d[\d \-]*\d""")

    /**
     * Redact one line. Idempotent in practice: the replacement tokens contain
     * no 7-digit run and no `@`, so re-running [line] over its own output is a
     * no-op. [DiagExport] relies on that — a logcat line that was already
     * emitted through DiagLog gets redacted twice.
     */
    fun line(raw: String?): String {
        if (raw.isNullOrEmpty()) return ""
        var s = EMAIL.replace(raw) { "email:" + hash6(it.value.lowercase()) }
        s = redactNumbers(s)
        return truncate(s)
    }

    /** Public so [DiagExport]'s device.txt can hash the pairing id the same way. */
    fun hash6(input: String): String {
        val d = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
        val sb = StringBuilder(6)
        for (i in 0 until 3) sb.append(String.format("%02x", d[i]))
        return sb.toString()
    }

    private fun redactNumbers(s: String): String = PHONE_CANDIDATE.replace(s) { m ->
        val token = m.value
        val digits = token.count { it.isDigit() }
        if (digits < MIN_PHONE_DIGITS) {
            token
        } else {
            val normalised = buildString {
                if (token.startsWith("+")) append('+')
                for (c in token) if (c.isDigit()) append(c)
            }
            "num:" + hash6(normalised)
        }
    }

    private fun truncate(s: String): String =
        if (s.length <= MAX_LEN) s else s.take(MAX_LEN) + "...[" + s.length + "]"
}
