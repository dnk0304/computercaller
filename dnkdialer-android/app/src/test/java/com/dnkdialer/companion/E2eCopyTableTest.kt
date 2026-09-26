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
        // vc63 Amendment 2 — the 4401 banner Dennis read on a screenshot.
        "status_failed_invalid_token",
        // vc63 — the Home "Computer" card (T-VC63-MAIN-SCREEN).
        "section_computer",
        "row_send_file_title",
        "home_e2e_now_verified",
        "home_e2e_now_unverified",
        "home_e2e_now_plaintext",
        // vc70 item 10 — home_e2e_next_only removed; the transient and the
        // reset-failed footer added.
        "home_e2e_now_switching",
        "home_e2e_switch_failed",
        "home_e2e_switch_retry",
        "status_switching",
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
        // INC-0924. Was "Same code on your computer?" — a question the user
        // could not answer, because the phone asked it BEFORE sending the
        // ACCEPT the computer derives its digits from, so the other screen was
        // blank. PhoneService now accepts first and both codes appear at the
        // same moment, and the copy is an INSTRUCTION to compare rather than a
        // question about a screen that had nothing on it. The web/extension
        // side keeps its own question ("Same code on your phone?"): it is the
        // side that has had its digits all along.
        assertEquals("Compare with the code on your computer", prompt)
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
        // THREE words, not two — sealed-but-unverified means nobody confirmed
        // a code, and calling that plain "Encrypted" claims a verification
        // that did not happen. vc70 item 10 (Dennis 2026-09-26, option a)
        // renamed them to what the user can check: "codes checked" / "no code
        // check" / "Standard (TLS)". Pinned EXACT: the words are a locked set.
        val verified = strings.getValue("status_connected_encrypted")
        val unverified = strings.getValue("status_connected_encrypted_unverified")
        val plaintext = strings.getValue("status_connected_unencrypted")
        assertEquals("Connected · Encrypted, codes checked", verified)
        assertEquals("Connected · Encrypted, no code check", unverified)
        assertEquals("Connected · Standard (TLS)", plaintext)
        assertEquals("Switching… reconnecting", strings.getValue("status_switching"))
        for (s in listOf(verified, unverified, plaintext)) {
            assertFalse("no 'verified' word may remain in the status set: '$s'", s.contains("verified", true))
        }
        assertEquals("the three states must be three strings", 3, setOf(verified, unverified, plaintext).size)
        // The shade must agree with the line, or the user has a contradiction
        // they cannot resolve from the surface they see when the app is closed.
        assertTrue(
            strings.getValue("notif_ongoing_connected_encrypted").contains("Encrypted", true)
        )
        assertTrue(
            strings.getValue("notif_ongoing_connected_encrypted_unverified")
                .contains("Encrypted, no code check", true)
        )
        assertTrue(
            strings.getValue("notif_ongoing_connected_encrypted")
                .contains("Encrypted, codes checked", true)
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
        // vc70 item 10: "unverified" became "no code check" — the same fact
        // in the words of the thing the user can do about it.
        val unverified = strings["home_e2e_now_unverified"].orEmpty()
        assertEquals("This connection: Encrypted, no code check", unverified)
        assertEquals(
            "This connection: Encrypted, codes checked",
            strings["home_e2e_now_verified"].orEmpty()
        )
        val plaintext = strings["home_e2e_now_plaintext"].orEmpty()
        assertEquals("This connection: Standard (TLS)", plaintext)
        assertEquals(
            "This connection: Switching… reconnecting",
            strings["home_e2e_now_switching"].orEmpty()
        )
        // Three distinct sentences, so the row can never render two modes the
        // same way.
        val lines = listOf(
            "home_e2e_now_verified", "home_e2e_now_unverified", "home_e2e_now_plaintext"
        ).map { strings[it].orEmpty() }
        assertEquals("three live modes, three lines", 3, lines.toSet().size)
    }

    /**
     * vc70 item 10 (T2/T5) — the vc63 "The switch applies to your next
     * connection" caveat is GONE (the vc69 switch resets the pair, so it was
     * false), the reset-failed footer exists, and the switch copy says the
     * connection is always encrypted — OFF only drops the code check
     * (Dennis 2026-09-26 09:37Z, option a).
     */
    @Test
    fun the_switch_copy_is_the_locked_vc70_set() {
        assertFalse("home_e2e_next_only must be deleted", strings.containsKey("home_e2e_next_only"))
        assertEquals("Couldn't switch this connection.", strings["home_e2e_switch_failed"])
        assertEquals("Retry", strings["home_e2e_switch_retry"])
        val sub = strings.getValue("row_encrypted_mode_sub")
        assertEquals(
            "Always encrypted in transit. On adds a one-time code check that proves no one is in the middle.",
            sub
        )
        assertFalse("the old subtitle implied OFF = unscrambled", sub.contains("Scramble", true))
        val off = strings.getValue("settings_encrypted_mode_off_next_pair")
        assertFalse("OFF is still encrypted under option (a): '$off'", off.contains("won't be encrypted", true))
        assertEquals("Off. Still encrypted next time you connect, with no code check.", off)
        assertEquals(
            "On. Next time you connect, you'll check a code on both devices.",
            strings.getValue("settings_encrypted_mode_on_next_pair")
        )
    }

    /**
     * vc63 Amendment 2 — the 4401 banner names the remedy the user actually
     * has.
     *
     * Close 4401 means the STORED phoneToken was rejected. The phone has no
     * QR flow and no "account settings" screen: the token comes from signing
     * in inside the APK, so the only thing the user can do is sign out (the
     * overflow action) and sign in again. The old copy — "Re-scan the QR
     * from your account settings" — sent them hunting for a scanner that has
     * not existed since dispatch #29.
     *
     * Pinned as EXACT text, not as a keyword, because the failure mode here
     * is a well-meaning rewrite that reintroduces a step the product does
     * not have.
     */
    @Test
    fun the_invalid_token_banner_says_sign_out_and_back_in() {
        assertEquals(
            "Sign-in expired — sign out and sign in again to reconnect.",
            strings["status_failed_invalid_token"]
        )
    }

    /**
     * Dennis, 2026-09-23 12:42Z, verbatim: "it says scan QR, we should never
     * mention QR anywhere. We dont use QR."
     *
     * So this is the same shape of rule as the end-to-end ban above, and it
     * exists for the same reason: the product does not do the thing the word
     * describes, and a string that says otherwise sends the user looking for
     * a feature. It runs over EVERY string value in the file, not a curated
     * key list, because the two offenders this lane removed (cd_qr,
     * label_scan) were both orphans nobody was looking at.
     *
     * Values only — comments still record the history, and that history is
     * worth keeping: it is why the strings are gone.
     */
    @Test
    fun noStringMentionsQrOrScanning() {
        val pattern = Regex("""(?i)\bqr\b|qr[-_ ]?code|\bscan""")
        val offenders = strings.filterValues { pattern.containsMatchIn(it) }.keys
        assertTrue(
            "these strings mention QR or scanning at the user: $offenders — " +
                "this product has no QR flow and no scanner (Dennis, " +
                "2026-09-23: \"we should never mention QR anywhere\")",
            offenders.isEmpty()
        )
    }
}
