package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * T-VC63-EXPORT-DIAGNOSTICS — the redactor, against the five shapes the brief
 * names plus the controls that keep them honest.
 *
 * The reason every assertion here has a control: a redactor is trivially
 * "passed" by a function that returns a constant. `assertFalse(out.contains(
 * "12345678"))` is true of `""`, of `"REDACTED"`, and of a function that threw
 * and was swallowed. So each case asserts BOTH that the secret is gone AND
 * that the surrounding metadata survived — which is the property the export
 * actually needs, since a log line with the numbers removed and the event
 * names removed is not a diagnostic.
 */
class RedactTest {

    /** The number-shaped run the leak guard also scans for. */
    private val NUMBERISH = Regex("""\+?\d[\d \-]{5,}\d""")

    // ---------------------------------------------------- brief case 1: raw

    @Test
    fun rawNumberIsHashed() {
        val out = Redact.line("sms in parts=2 from=47123456 dedupe=false")
        assertFalse("raw digits survived: $out", out.contains("47123456"))
        assertTrue("no num: token: $out", out.contains("num:"))
        // Control: the metadata this line exists for is still readable.
        assertTrue(out.contains("parts=2"))
        assertTrue(out.contains("dedupe=false"))
        // Control: the hash is 6 hex, not an empty or constant marker.
        assertTrue(out, Regex("num:[0-9a-f]{6}").containsMatchIn(out))
    }

    // ------------------------------------------------- brief case 2: +47

    @Test
    fun plusPrefixedSpacedNumberIsHashed() {
        val out = Redact.line("call out to +47 123 45 678 state=DIALING")
        assertFalse("digits survived: $out", NUMBERISH.containsMatchIn(out))
        assertTrue(out.contains("num:"))
        assertTrue("state lost: $out", out.contains("state=DIALING"))
    }

    @Test
    fun separatorFormsOfTheSameNumberHashIdentically() {
        // +47 123 45 678, +47-123-45-678 and +4712345678 are ONE number; the
        // whole point of the hash is that Ken can see it is one number across
        // four differently formatted call sites.
        val a = Redact.line("x +47 123 45 678 y")
        val b = Redact.line("x +47-123-45-678 y")
        val c = Redact.line("x +4712345678 y")
        assertEquals(a, b)
        assertEquals(b, c)
    }

    @Test
    fun theLeadingPlusChangesTheHash() {
        // Documented in Redact's header: no national-prefix guessing, so
        // 4712345678 and +4712345678 are different tokens. Pinned so that the
        // behaviour is a decision and not an accident someone later "fixes".
        assertNotEquals(Redact.line("+4712345678"), Redact.line("4712345678"))
    }

    // ------------------------------------------------ brief case 3: in JSON

    @Test
    fun numberEmbeddedInJsonIsHashed() {
        val out = Redact.line("""frame={"type":"sms","from":"+4712345678","parts":1}""")
        assertFalse("digits survived: $out", out.contains("4712345678"))
        assertTrue(out.contains("num:"))
        // Control: the JSON around it is intact, so the line is still parseable
        // by eye — redaction must not eat structure.
        assertTrue(out, out.contains("\"type\":\"sms\""))
        assertTrue(out, out.contains("\"parts\":1"))
    }

    // -------------------------------------------------- brief case 4: email

    @Test
    fun emailIsHashed() {
        val out = Redact.line("signin account=dennis.kotlenko@gmail.com ok=true")
        assertFalse("address survived: $out", out.contains("gmail.com"))
        assertFalse(out.contains("dennis"))
        assertTrue(out, Regex("email:[0-9a-f]{6}").containsMatchIn(out))
        assertTrue(out.contains("ok=true"))
    }

    @Test
    fun emailWinsOverTheNumberRuleWhenBothMatch() {
        // a1234567@example.com contains a 7-digit run. If the number rule ran
        // first the local part would be rewritten and the DOMAIN would survive
        // — a half-redacted address that still identifies the user. This is
        // the ordering assertion for Redact.line.
        val out = Redact.line("acct a1234567@example.com")
        assertFalse("domain survived: $out", out.contains("example.com"))
        assertTrue(out, out.contains("email:"))
        assertFalse("number rule ran first: $out", out.contains("num:"))
    }

    @Test
    fun emailCaseDoesNotChangeTheHash() {
        assertEquals(Redact.line("a@B.com"), Redact.line("A@b.COM"))
    }

    // ---------------------------------------------- brief case 5: long line

    @Test
    fun longLineIsTruncatedWithItsLength() {
        val out = Redact.line("x".repeat(500))
        assertEquals(Redact.MAX_LEN + "...[500]".length, out.length)
        assertTrue(out, out.endsWith("...[500]"))
        // Control: a line AT the limit is untouched, so the rule is a cap and
        // not an unconditional rewrite.
        val atLimit = "y".repeat(Redact.MAX_LEN)
        assertEquals(atLimit, Redact.line(atLimit))
    }

    @Test
    fun truncationCannotResurrectARedactedNumber() {
        // Redaction runs BEFORE truncation. If the order were reversed, a
        // number straddling char 160 would be cut into a sub-7-digit tail that
        // the number rule then declines to touch — i.e. a partial leak that
        // only appears on long lines.
        val out = Redact.line("z".repeat(155) + "+4712345678 tail")
        assertFalse("digits survived truncation: $out", NUMBERISH.containsMatchIn(out))
    }

    // ------------------------------------------------------------ negatives

    @Test
    fun shortNumbersAndMetadataSurvive() {
        // The floor is 7 digits precisely so that byte counts, chunk indices,
        // status codes and part counts stay readable. A redactor that ate
        // "size=68623" would make the log useless for INC-0923's file-transfer
        // half.
        val out = Redact.line("FILE_OFFER id=7f3a size=68623 chunks=68 code=1006")
        assertEquals("FILE_OFFER id=7f3a size=68623 chunks=68 code=1006", out)
    }

    @Test
    fun sixDigitRunIsKeptAndSevenIsNot() {
        // The exact boundary, both sides, so MIN_PHONE_DIGITS cannot drift.
        assertTrue(Redact.line("n=123456").contains("123456"))
        assertFalse(Redact.line("n=1234567").contains("1234567"))
    }

    @Test
    fun outputIsIdempotent() {
        // DiagExport re-redacts logcat lines that DiagLog already redacted.
        // If that second pass changed anything, the same event would read
        // differently in app.log and logcat.txt.
        val once = Redact.line("from +4712345678 to a@b.com")
        assertEquals(once, Redact.line(once))
    }

    @Test
    fun nullAndEmptyAreSafe() {
        assertEquals("", Redact.line(null))
        assertEquals("", Redact.line(""))
    }

    @Test
    fun hash6IsSixHexAndStable() {
        val h = Redact.hash6("+4712345678")
        assertEquals(6, h.length)
        assertTrue(h, Regex("^[0-9a-f]{6}$").matches(h))
        assertEquals(h, Redact.hash6("+4712345678"))
        assertNotEquals(h, Redact.hash6("+4712345679"))
    }
}
