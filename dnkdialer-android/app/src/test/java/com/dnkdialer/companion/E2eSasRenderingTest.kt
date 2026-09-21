package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * E2eSasRenderingTest — M-A6-5, SPEC §13.3 "Rendering — FROZEN (R-BK)".
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 * The P6.1c Part 3 screenshots were read back side by side and the SAME code
 * appeared as "316 44" on the phone hero face and "31 644" in the page dialog:
 * E2eSasContract.group split 3+2, lib/encryptedModeCopy.ts's groupSasDigits
 * split 2+3. Both surfaces were internally consistent, which is exactly why it
 * survived to a live run — nothing on either side could see the other.
 *
 * It is not styling. The SAS is a human EXACT-STRING compare and it is the only
 * defence against a key substitution at the relay. A user who is taught that
 * the two screens legitimately render the same code differently has been taught
 * to accept "looks a bit different", which is the judgment the attack needs.
 *
 * ── WHAT IS PINNED HERE, AND WHY IT IS A JVM TEST ─────────────────────────
 * The rendering is a pure function, so it is driven directly rather than
 * observed through a screenshot. §3 additionally pins the CALL SITE from
 * source, because MainActivity needs an instrumented run and a contract nobody
 * calls is the easiest way for this fix to rot: E2eSasConfirmUiTest asserts the
 * same facts on a real device in the instrumented lane.
 *
 * §4 pins the WEB half's rule by reading lib/encryptedModeCopy.ts. That file is
 * the other surface the spec names, and a pin that only covers this side would
 * let the pair diverge again from the direction it diverged last time.
 */
class E2eSasRenderingTest {

    private companion object {
        /** The live code from the P6.1c Part 3 run, which is what diverged. */
        const val DIGITS = "31644"
    }

    // ── 1. the visible rendering ───────────────────────────────────────────

    @Test
    fun the_visible_code_is_the_five_digits_verbatim() {
        assertEquals(
            "SPEC 13.3 R-BK freezes the ungrouped five digits on every surface",
            DIGITS, E2eSasContract.render(DIGITS)
        )
        assertEquals("41290", E2eSasContract.render("41290"))
        assertEquals("00042", E2eSasContract.render("00042"))
    }

    @Test
    fun the_visible_code_carries_no_separator_of_any_kind() {
        val rendered = E2eSasContract.render(DIGITS)
        assertEquals("length must be exactly the digit count", 5, rendered.length)
        assertTrue("every character must be a digit", rendered.all { it.isDigit() })
        for (sep in listOf(" ", " ", "-", "‐", "–", ".", "/", " ")) {
            assertFalse("a '" + sep + "' separator is forbidden", rendered.contains(sep))
        }
    }

    @Test
    fun leading_zeroes_are_never_suppressed() {
        // 13.3 zero-pads to 5. A render that trimmed would make two different
        // codes look the same, which is worse than looking different.
        assertEquals("00000", E2eSasContract.render("00000"))
        assertEquals("01234", E2eSasContract.render("01234"))
    }

    @Test
    fun a_malformed_payload_is_passed_through_unchanged_not_tidied() {
        // The caller refuses these (isWellFormed); render must not make a bad
        // payload LOOK like a good one on the way there.
        assertEquals("123", E2eSasContract.render("123"))
        assertEquals("1234567", E2eSasContract.render("1234567"))
        assertEquals("abcde", E2eSasContract.render("abcde"))
    }

    // ── 2. the spoken rendering ────────────────────────────────────────────

    @Test
    fun the_spoken_code_spells_the_same_digits_one_at_a_time() {
        assertEquals("3 1 6 4 4", E2eSasContract.spoken(DIGITS))
        assertEquals("4 1 2 9 0", E2eSasContract.spoken("41290"))
    }

    @Test
    fun the_spoken_code_is_the_same_digits_in_the_same_order_as_the_visible_one() {
        // The one invariant that actually protects a screen-reader user: what
        // is spoken must be what is shown, stripped of the spacing that makes
        // TalkBack say digits instead of a number.
        val shown = E2eSasContract.render(DIGITS)
        assertEquals(shown, E2eSasContract.spoken(DIGITS).replace(" ", ""))
    }

    @Test
    fun the_spoken_code_is_never_a_grouped_number() {
        val spoken = E2eSasContract.spoken(DIGITS)
        assertFalse(
            "'316 44' / '31 644' spoken is two numbers, not five digits",
            spoken == "316 44" || spoken == "31 644"
        )
        assertEquals("five digits means four separators", 4, spoken.count { it == ' ' })
    }

    @Test
    fun a_malformed_payload_is_not_spelled_out() {
        assertEquals("abcde", E2eSasContract.spoken("abcde"))
        assertEquals("123", E2eSasContract.spoken("123"))
    }

    // ── 3. the call site, pinned at source ─────────────────────────────────

    @Test
    fun main_activity_renders_through_the_contract_and_groups_nothing() {
        val f = File("src/main/java/com/dnkdialer/companion/MainActivity.kt")
        assertTrue("MainActivity.kt not found at " + f.absolutePath, f.exists())
        val src = f.readText()
        val show = src.substringAfter("fun showSasConfirm").substringBefore("fun hideSasConfirm")
        assertTrue("MainActivity.kt: showSasConfirm not found", show.isNotEmpty())
        assertTrue(
            "the visible text must come from E2eSasContract.render",
            show.contains("val rendered = E2eSasContract.render(digits)") &&
                show.contains("code.text = rendered")
        )
        assertTrue(
            "the spoken description must come from E2eSasContract.spoken",
            show.contains("E2eSasContract.spoken(digits)")
        )
        assertFalse(
            "the old grouping call must be gone from the hero face",
            show.contains("E2eSasContract.group(")
        )
    }

    @Test
    fun the_grouping_function_is_gone_from_the_contract_entirely() {
        // Leaving it exported invites the next surface to call it.
        val src = File("src/main/java/com/dnkdialer/companion/E2eSasContract.kt").readText()
        assertFalse(
            "E2eSasContract must expose no grouping door at all",
            src.contains("fun group(")
        )
    }

    // ── 4. parity with the page dialog, the other surface the spec names ───

    @Test
    fun the_web_surface_renders_the_digits_verbatim_too() {
        val f = File("../../lib/encryptedModeCopy.ts")
        assertTrue("encryptedModeCopy.ts not found at " + f.absolutePath, f.exists())
        val src = f.readText()
        assertFalse(
            "the web helper must no longer group: it split 2+3 while this side split 3+2",
            src.contains("export function groupSasDigits")
        )
        val body = src.substringAfter("export function renderSasDigits(digits: string): string {")
            .substringBefore("}")
        assertTrue("renderSasDigits not found in encryptedModeCopy.ts", body.isNotBlank())
        assertEquals(
            "the web render must return the digits verbatim",
            "return digits;", body.trim()
        )
    }

    @Test
    fun the_page_dialog_calls_the_render_door() {
        val f = File("../../components/SasConfirmDialog.tsx")
        assertTrue("SasConfirmDialog.tsx not found at " + f.absolutePath, f.exists())
        val src = f.readText()
        assertTrue(
            "the dialog must render through renderSasDigits",
            src.contains("{renderSasDigits(digits)}")
        )
        assertFalse("no grouping call may survive in the dialog", src.contains("groupSasDigits"))
    }
}
