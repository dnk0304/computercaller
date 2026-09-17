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
        "status_connected_unencrypted",
        "notif_ongoing_connected_encrypted",
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
        assertEquals("Doesn't match", strings.getValue("e2e_sas_no_match").replace("\\'", "'"))
    }

    @Test
    fun the_key_change_warning_lists_benign_causes_without_asserting_one() {
        val body = strings.getValue("e2e_key_change_body")
        // M-C: the phone cannot tell a reinstall from a substitution, so the
        // copy must not claim it can. A confident "this is just a reinstall"
        // trains users straight through a real attack.
        assertFalse(
            "the warning must not assert a cause it cannot know",
            body.contains("this is just", true) || body.contains("don't worry", true)
        )
        for (cause in listOf("reinstall", "sign", "reset")) {
            assertTrue("benign cause '$cause' missing from the warning", body.contains(cause, true))
        }
        assertEquals("Trust", strings.getValue("e2e_key_change_trust"))
        assertEquals("Not now", strings.getValue("e2e_key_change_not_now"))
    }

    @Test
    fun encrypted_state_exists_as_words_not_only_as_a_colour() {
        assertTrue(strings.getValue("status_connected_encrypted").contains("Encrypted", true))
        assertTrue(
            strings.getValue("notif_ongoing_connected_encrypted").contains("Encrypted", true)
        )
        // The unencrypted state must be nameable too — "Connected" with a grey
        // dot and no word is the state a user misreads as safe.
        assertTrue(
            strings.getValue("status_connected_unencrypted").contains("Not encrypted", true)
        )
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
            .associate { it.groupValues[1] to it.groupValues[2].trim() }
    }
}
