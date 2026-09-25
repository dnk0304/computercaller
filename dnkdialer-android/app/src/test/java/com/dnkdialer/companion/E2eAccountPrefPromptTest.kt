package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * vc69 account-pref — security review of c7c290f, minors R2 and R3.
 *
 * R2: on the PAUSED card the safe choice, "Keep code check", is the PRIMARY
 * (filled) button; "Continue without code check" is the outline secondary.
 * MainActivity binds the card ONLY through [E2eAccountPrefCopy.promptButtons],
 * so this pins the decision the screen paints.
 *
 * R3: every button of the latch prompt card (both variants share the same two
 * views) declares `android:filterTouchesWhenObscured="true"` in the shipped
 * layout, so an overlay cannot click through onto a choice. MainActivity
 * also sets it at bind time; the instrumented E2eAccountPrefPromptCardTest
 * reads it back off the live view.
 */
class E2eAccountPrefPromptTest {

    @Test
    fun paused_primary_is_keep_code_check_and_filled() {
        val b = E2eAccountPrefCopy.promptButtons(E2eAccountPref.DowngradeKind.PAUSED)
        assertEquals(E2eAccountPrefCopy.PromptAction.KEEP_CODE_CHECK, b.primary)
        assertEquals(E2eAccountPrefCopy.PromptAction.CONTINUE_WITHOUT, b.secondary)
        assertTrue("paused primary must be the filled pill", b.primaryFilled)
        assertEquals(R.string.e2e_pref_prompt_keep_check, b.primary.labelRes)
        assertEquals(R.string.e2e_pref_prompt_continue_without, b.secondary.labelRes)
    }

    @Test
    fun pref_off_card_is_unchanged() {
        val b = E2eAccountPrefCopy.promptButtons(E2eAccountPref.DowngradeKind.PREF_OFF)
        assertEquals(E2eAccountPrefCopy.PromptAction.TURN_BACK_ON, b.primary)
        assertEquals(E2eAccountPrefCopy.PromptAction.KEEP_OFF, b.secondary)
        assertFalse(b.primaryFilled)
    }

    @Test
    fun every_kind_has_a_layout_and_no_kind_offers_the_same_action_twice() {
        for (k in E2eAccountPref.DowngradeKind.values()) {
            val b = E2eAccountPrefCopy.promptButtons(k)
            assertTrue("$k: primary == secondary", b.primary != b.secondary)
        }
    }

    /** Unit-test cwd is `dnkdialer-android/app`. */
    private val layout = File("src/main/res/layout/activity_main.xml")

    @Test
    fun every_prompt_card_button_filters_obscured_touches() {
        assertTrue("layout not found at ${layout.absolutePath}", layout.isFile)
        val f = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
        val doc = f.newDocumentBuilder().parse(layout)
        val ns = "http://schemas.android.com/apk/res/android"
        val all = doc.getElementsByTagName("*")
        var card: Element? = null
        for (i in 0 until all.length) {
            val e = all.item(i) as Element
            if (e.getAttributeNS(ns, "id") == "@+id/homeE2ePrefPromptCard") card = e
        }
        assertTrue("homeE2ePrefPromptCard not in layout", card != null)
        val inCard = card!!.getElementsByTagName("*")
        val buttons = (0 until inCard.length).map { inCard.item(it) as Element }
            .filter { it.tagName.substringAfterLast('.').endsWith("Button") }
        assertEquals(
            "the card's buttons",
            setOf("@+id/homeE2ePrefPromptSecondary", "@+id/homeE2ePrefPromptPrimary"),
            buttons.map { it.getAttributeNS(ns, "id") }.toSet(),
        )
        for (b in buttons) {
            assertEquals(
                "${b.getAttributeNS(ns, "id")} must set filterTouchesWhenObscured",
                "true",
                b.getAttributeNS(ns, "filterTouchesWhenObscured"),
            )
        }
    }
}
