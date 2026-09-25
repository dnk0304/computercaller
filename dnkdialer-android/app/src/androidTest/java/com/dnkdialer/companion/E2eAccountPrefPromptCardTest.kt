package com.dnkdialer.companion

import android.graphics.Bitmap
import android.widget.Button
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * vc69 account-pref — security review of c7c290f, R2 + R3, on the LIVE view.
 *
 * A real E2E_PREF "paused" push goes through the REAL controller into the
 * REAL prefs file (throwaway account id via userIdSource); MainActivity then
 * paints the card through its production painter. Asserted before capture:
 *  - R2: the primary (filled, bottom) button reads "Keep code check" and its
 *    tap keeps the check on (latch cleared, still advertising ON);
 *  - R3: both prompt buttons have filterTouchesWhenObscured set.
 * Screenshot: screenshots/e2e-pref-paused-card.png in the app's external files.
 */
@RunWith(AndroidJUnit4::class)
class E2eAccountPrefPromptCardTest {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx get() = instr.targetContext
    private val testUser = "prompt-card-test-user"
    private lateinit var savedSource: (android.content.Context) -> String?

    @Before
    fun setUp() {
        TokenStore.save(ctx, "e2e-pref-card-fixture-not-a-real-token", "dennis@example.com")
        savedSource = E2eAccountPrefController.userIdSource
        E2eAccountPrefController.userIdSource = { testUser }
        E2eAccountPrefController.onSignOut(ctx)
    }

    @After
    fun tearDown() {
        E2eAccountPrefController.onSignOut(ctx)
        E2eAccountPrefController.userIdSource = savedSource
        TokenStore.clear(ctx)
    }

    private fun push(pref: String, eff: String, paused: Boolean, rev: Int) =
        E2eAccountPrefController.onPushFrame(
            ctx,
            mapOf(
                "preference" to pref, "effective" to eff, "pausedByServer" to paused,
                "rev" to rev, "updatedAt" to "2026-09-25T12:00:00.000Z", "updatedBy" to "admin",
            ),
        )

    @Test
    fun paused_card_primary_is_keep_and_buttons_filter_obscured_touches() {
        push("on", "on", false, 5)
        push("on", "off", true, 6)
        val pending = E2eAccountPrefController.state(ctx)?.pendingDowngrade
        assertNotNull("paused push must latch", pending)
        assertEquals(E2eAccountPref.DowngradeKind.PAUSED, pending!!.kind)

        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            instr.waitForIdleSync()
            scenario.onActivity { a ->
                a.refreshEncryptedModeRowForTest()
                val card = a.findViewById<android.view.View>(R.id.homeE2ePrefPromptCard)
                assertEquals("card visible", android.view.View.VISIBLE, card.visibility)
                val primary = a.findViewById<Button>(R.id.homeE2ePrefPromptPrimary)
                val secondary = a.findViewById<Button>(R.id.homeE2ePrefPromptSecondary)
                assertEquals(ctx.getString(R.string.e2e_pref_prompt_keep_check), primary.text.toString())
                assertEquals(ctx.getString(R.string.e2e_pref_prompt_continue_without), secondary.text.toString())
                assertTrue("R3 primary", primary.filterTouchesWhenObscured)
                assertTrue("R3 secondary", secondary.filterTouchesWhenObscured)
                val scroller = a.findViewById<android.view.View>(R.id.mainContentContainer)
                    .parent as android.widget.ScrollView
                val pad = (24 * a.resources.displayMetrics.density).toInt()
                scroller.scrollTo(0, maxOf(0, card.bottom - scroller.height + pad))
            }
            instr.waitForIdleSync()
            Thread.sleep(600)
            scenario.onActivity { a ->
                val r = android.graphics.Rect()
                assertTrue(
                    "card not in the window — capture would not show it",
                    a.findViewById<android.view.View>(R.id.homeE2ePrefPromptPrimary).getGlobalVisibleRect(r) &&
                        r.height() > 0,
                )
            }
            capture("e2e-pref-paused-card.png")

            // The filled primary keeps the check on.
            scenario.onActivity { a -> a.findViewById<Button>(R.id.homeE2ePrefPromptPrimary).performClick() }
            instr.waitForIdleSync()
            assertEquals(null, E2eAccountPrefController.state(ctx)?.pendingDowngrade)
            assertTrue("keep = still advertising ON", E2eAccountPrefController.advertisedOn(ctx))
        }
    }

    private fun capture(name: String) {
        val bmp: Bitmap = instr.uiAutomation.takeScreenshot()
            ?: throw AssertionError("takeScreenshot() returned null for $name")
        val dir = File(ctx.getExternalFilesDir(null), "screenshots").apply { mkdirs() }
        File(dir, name).outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
