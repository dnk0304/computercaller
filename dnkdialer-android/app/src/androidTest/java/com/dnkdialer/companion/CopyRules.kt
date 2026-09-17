package com.dnkdialer.companion

import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import org.junit.Assert.assertFalse

/**
 * E2E programme P5b — the user-facing copy rules, in one place so every screen
 * is held to them rather than only the first one that thought to check.
 *
 * Extracted from [SettingsScreenshotHelper], which had the only copy of
 * [assertNoEndToEndClaim]. (c)'s SAS face and (d)'s TOFU face need the same
 * rule, and a second copy-paste is how a rule quietly stops applying to the
 * screen that was added last.
 */
object CopyRules {

    /**
     * Walk the live view tree and fail on any visible text claiming
     * "end-to-end".
     *
     * Deliberately a view-tree walk, not a grep over strings.xml: a grep would
     * miss copy assembled at runtime and would false-positive on an unused
     * resource. Only what is actually on screen is a claim to the user.
     *
     * P8-CLAIM-REVIEW: the phrase is a specific, checkable assertion, the
     * feature is not finished, and a store listing carrying it is a compliance
     * problem as well as an untrue one. Say "Encrypted".
     */
    fun assertNoEndToEndClaim(root: View) {
        forEachVisibleText(root) { view, text ->
            val t = text.lowercase()
            assertFalse(
                "user-visible copy claims end-to-end: '${view.text}'",
                t.contains("end-to-end") || t.contains("end to end")
            )
        }
    }

    /**
     * Fail if a state is signalled ONLY by colour.
     *
     * [tokens] are the words that must appear in the visible text for the
     * state to be legible to a user who cannot distinguish the tint — a
     * colour-blind user, a monochrome display, or anyone reading the
     * notification shade in sunlight. WCAG 1.4.1.
     */
    fun assertStateIsNotColourOnly(root: View, vararg tokens: String) {
        val visible = buildString {
            forEachVisibleText(root) { _, text -> append(text).append('\n') }
        }.lowercase()
        for (token in tokens) {
            org.junit.Assert.assertTrue(
                "state '$token' is signalled by colour alone — no visible text carries it",
                visible.contains(token.lowercase())
            )
        }
    }

    /** Collect the visible text of every shown TextView under [root]. */
    fun visibleText(root: View): List<String> =
        buildList { forEachVisibleText(root) { _, text -> add(text) } }

    private fun forEachVisibleText(root: View, body: (TextView, String) -> Unit) {
        if (root.visibility != View.VISIBLE) return
        if (root is ViewGroup) {
            for (i in 0 until root.childCount) forEachVisibleText(root.getChildAt(i), body)
        }
        if (root is TextView) {
            val text = root.text?.toString().orEmpty()
            if (text.isNotBlank()) body(root, text)
        }
    }
}
