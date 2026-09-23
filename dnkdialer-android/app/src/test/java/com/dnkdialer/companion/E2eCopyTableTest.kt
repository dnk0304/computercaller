package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * E2E programme P5b — the copy table, asserted on the JVM against the actual
 * strings.xml rather than against a Kotlin copy of it.
 *
 * Why a resource-file parse instead of `getString`: this is a plain JVM unit
 * test (no Robolectric in this module), and more importantly the thing worth
 * protecting is the SHIPPED resource. A test that asserted over a constant in
 * test code would pass forever while the resource drifted.
 *
 * What this pins, and why each rule exists:
 *
 *  * no string claims "end-to-end" (P8-CLAIM-REVIEW — a specific claim, an
 *    unfinished feature, and a store-listing compliance problem);
 *  * no string says "E2E" or "end to end" at the user;
 *  * the four capability reasons are four DIFFERENT strings, so a greyed
 *    control always says what to do next rather than only that it is greyed;
 *  * the SAS and TOFU copy is present and asks a question the user can answer
 *    by looking at their computer, not by trusting the app;
 *  * every state word that a colour also carries ("Encrypted", "Not
 *    encrypted") exists as text.
 */
class E2eCopyTableTest {

    private val strings: Map<String, String> by lazy { parseStrings() }

    /** Every P5b-owned key, so a deleted string fails here and not on a device. */
    private val required = listOf(
        "row_encrypted_mode_title",
        "row_encrypted_mode_sub",
        "settings_encrypted_mode_waiting",
        "settings_encrypted_mode_peer_old",
        "settings_encrypted_mode_device_old",
        "settings_encrypted_mode_ready",
        "settings_encrypted_mode_on_next_pair",
        "settings_encrypted_mode_off_next_pair",
        "settings_encrypted_mode_a11y",
        "e2e_sas_title",
        "e2e_sas_prompt",
        "e2e_sas_matches",
        "e2e_sas_no_match",
        "e2e_sas_refused",
        "e2e_sas_code_a11y",
        "e2e_key_change_title",
        "e2e_key_change_body",
        "e2e_key_change_trust",
        "e2e_key_change_not_now",
        "status_connected_encrypted",
        "status_connected_encrypted_unverified",
        "status_connected_unencrypted",
        "notif_ongoing_connected_encrypted",
        "notif_ongoing_connected_encrypted_unverified",
        // vc63 — the Home "Computer" card (T-VC63-MAIN-SCREEN).
        "section_computer",
        "row_send_file_title",
        "row_send_file_sub",
        "home_e2e_now_verified",
        "home_e2e_now_unverified",
        "home_e2e_now_plaintext",
        "home_e2e_next_only",
    )

    @Test
    fun every_p5b_string_exists_and_is_not_blank() {
        val missing = required.filter { strings[it].isNullOrBlank() }
        assertTrue("missing or blank strings: $missing", missing.isEmpty())
    }

    @Test
    fun no_user_facing_string_claims_end_to_end() {
        val offenders = strings.filterValues {
            val t = it.lowercase()
            t.contains("end-to-end") || t.contains("end to end") || Regex("\\be2e\\b").containsMatchIn(t)
        }.keys
        assertTrue(
            "these strings make an end-to-end claim at the user: $offenders — " +
                "say \"Encrypted\" (P8-CLAIM-REVIEW)",
            offenders.isEmpty()
        )
    }

    @Test
    fun the_four_capability_reasons_are_four_different_strings() {
        val reasons = listOf(
            "settings_encrypted_mode_waiting",
            "settings_encrypted_mode_peer_old",
            "settings_encrypted_mode_device_old",
            "settings_encrypted_mode_ready",
        ).map { strings.getValue(it) }
        assertEquals(
            "a shared reason tells the user it is greyed but never what to do",
            reasons.size, reasons.toSet().size
        )
        // The peer case must point at the COMPUTER and the device case at the
        // PHONE. Swapping them sends the user to fix the wrong machine.
        assertTrue(
            strings.getValue("settings_encrypted_mode_peer_old").contains("computer", true)
        )
        assertTrue(
            strings.getValue("settings_encrypted_mode_device_old").contains("phone", true)
        )
    }

    @Test
    fun the_sas_prompt_asks_about_the_computer_and_offers_both_answers() {
        val prompt = strings.getValue("e2e_sas_prompt")
        assertTrue(
            "the SAS question must send the user to look at the other device",
            prompt.contains("computer", true)
        )
        // Parity with the web/extension surface, which asks "Same code on your
        // phone?". Same question, other direction.
        assertEquals("Same code on your computer?", prompt)
        assertEquals("Matches", strings.getValue("e2e_sas_matches"))
        assertEquals("Doesn't match", strings.getValue("e2e_sas_no_match"))
    }

    @Test
    fun the_key_change_warning_is_the_frozen_copy_and_asserts_no_cause() {
        // FROZEN, parity with P5a-UI (Ken R-AH). P5a says "Your phone's key
        // changed"; this is the same sentence pointed the other way.
        assertEquals(
            "Your computer's key changed",
            strings.getValue("e2e_key_change_title")
        )
        val body = strings.getValue("e2e_key_change_body")
        assertEquals(
            "If you reinstalled or reset the browser, pair again to confirm it's your computer.",
            body
        )
        // M-C: the phone cannot tell a reinstall from a substitution, so the
        // copy must not claim it can. A confident "this is just a reinstall"
        // trains users straight through a real attack.
        assertFalse(
            "the warning must not assert a cause it cannot know",
            body.contains("this is just", true) || body.contains("don't worry", true)
        )
        for (cause in listOf("reinstall", "reset")) {
            assertTrue("benign cause '$cause' missing from the warning", body.contains(cause, true))
        }
        // The remedy must be to CHECK, not to click past it.
        assertTrue("the warning must send the user to pair again", body.contains("pair again", true))
        assertEquals("Trust", strings.getValue("e2e_key_change_trust"))
        assertEquals("Not now", strings.getValue("e2e_key_change_not_now"))
    }

    @Test
    fun the_three_frozen_state_words_are_present_and_distinct() {
        // P5a parity (Ken R-AH): "Encrypted" / "Encrypted, unverified" /
        // "Not encrypted". THREE words, not two — sealed-but-unverified means
        // nobody confirmed a code, and calling that plain "Encrypted" claims a
        // verification that did not happen.
        val verified = strings.getValue("status_connected_encrypted")
        val unverified = strings.getValue("status_connected_encrypted_unverified")
        val plaintext = strings.getValue("status_connected_unencrypted")
        assertTrue(verified.contains("Encrypted", true))
        assertTrue(unverified.contains("Encrypted, unverified", true))
        assertTrue(plaintext.contains("Not encrypted", true))
        assertEquals("the three states must be three strings", 3, setOf(verified, unverified, plaintext).size)
        // The shade must agree with the line, or the user has a contradiction
        // they cannot resolve from the surface they see when the app is closed.
        assertTrue(
            strings.getValue("notif_ongoing_connected_encrypted").contains("Encrypted", true)
        )
        assertTrue(
            strings.getValue("notif_ongoing_connected_encrypted_unverified")
                .contains("Encrypted, unverified", true)
        )
    }

    @Test
    fun the_sas_copy_says_five_digits_because_the_spec_freezes_five() {
        // §13.3: "mod 100000, zero-padded to 5". The P5b brief said six and
        // the first cut of this UI believed it.
        assertTrue(
            "the SAS body must not promise a digit count the spec does not freeze",
            strings.getValue("e2e_sas_body").contains("five-digit", true)
        )
        assertFalse(strings.getValue("e2e_sas_body").contains("six", true))
    }

    /**
     * Minimal `<string name="…">value</string>` reader. A real XML parse would
     * need a dependency this module does not have; the file is ours and its
     * shape is stable, and a malformed entry shows up as a missing key in
     * [every_p5b_string_exists_and_is_not_blank].
     */
    private fun parseStrings(): Map<String, String> {
        val f = File("src/main/res/values/strings.xml")
        assertTrue("strings.xml not found at ${f.absolutePath}", f.exists())
        val text = f.readText()
        return Regex("""<string name="([^"]+)"[^>]*>(.*?)</string>""", RegexOption.DOT_MATCHES_ALL)
            .findAll(text)
            .associate { it.groupValues[1] to unescape(it.groupValues[2].trim()) }
    }

    /**
     * Undo strings.xml's own escaping once, here, so no assertion has to.
     *
     * A backslash-apostrophe is how a resource file spells an apostrophe (aapt
     * rejects a bare
     * one), which is a property of the FILE FORMAT and not of the copy. Every
     * test in this class is about what the user reads, so the escape is noise
     * — and leaving it in means each assertion carries its own un-escaping,
     * which is exactly where one of them gets it wrong.
     */
    private fun unescape(raw: String): String =
        raw.replace(Regex("""\\(['"])"""), "$1")

    /**
     * vc63 — the live-pair line must never upgrade an unverified pair into a
     * verified-sounding claim.
     *
     * The generic end-to-end ban above already covers the phrase; this pins
     * the narrower rule the row exists to respect. "Encrypted, unverified"
     * means NOBODY CONFIRMED A CODE, and the only honest way to say that is
     * to keep the word "unverified" attached to it — a line that said
     * "Encrypted" flat there would read as safe next to a switch the user
     * just turned on.
     */
    @Test
    fun the_live_unverified_line_keeps_saying_unverified() {
        val unverified = strings["home_e2e_now_unverified"].orEmpty()
        assertTrue(
            "home_e2e_now_unverified must name the unverified state: '$unverified'",
            unverified.lowercase().contains("unverified")
        )
        val plaintext = strings["home_e2e_now_plaintext"].orEmpty()
        assertTrue(
            "home_e2e_now_plaintext must spell out that it is NOT encrypted — " +
                "the absence of a word is not a signal: '$plaintext'",
            plaintext.lowercase().contains("not encrypted")
        )
        // Three distinct sentences, so the row can never render two modes the
        // same way.
        val lines = listOf(
            "home_e2e_now_verified", "home_e2e_now_unverified", "home_e2e_now_plaintext"
        ).map { strings[it].orEmpty() }
        assertEquals("three live modes, three lines", 3, lines.toSet().size)
    }

    /**
     * The caveat must be about the NEXT connection, not this one. A caveat
     * that merely said "saved" would leave the user believing the flip
     * changed the session they are looking at — SPEC §13.1 latches the mode
     * at Accept, so it cannot have.
     */
    @Test
    fun the_switch_caveat_points_at_the_next_connection() {
        val caveat = strings["home_e2e_next_only"].orEmpty().lowercase()
        assertTrue(
            "home_e2e_next_only must say 'next': '$caveat'",
            caveat.contains("next")
        )
    }
}
