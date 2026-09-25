package com.dnkdialer.companion

import com.google.gson.JsonParser
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * RULE 30 — the Kotlin twin of the relay's relay-owned account-pref frames.
 *
 * `tests/e2e-pref-relay-owned-frames.json` (repo root, created by the relay
 * C1 brief) lists the frame prefixes the relay OWNS: it only ever originates
 * them itself and never forwards a copy a peer sent. The phone's parser must
 * route exactly those prefixes, so both of [E2eAccountPref.FRAME_PUSH] and
 * [E2eAccountPref.FRAME_REFUSED] (with the ':' separator) must be listed —
 * otherwise a peer could forge a frame the relay no longer filters.
 *
 * The file does not exist on the android lane branch; there this test is
 * SKIPPED (Assume). On the vc69 tip, where the relay lane has merged, it MUST
 * run non-skipped — the vc69 cut records that.
 */
class E2ePrefRelayOwnedFramesTest {

    /** Unit-test cwd is `dnkdialer-android/app`, so `../..` is the repo root. */
    private val file = File("../../tests/e2e-pref-relay-owned-frames.json")

    @Test
    fun relay_owned_prefixes_cover_both_phone_frames() {
        assumeTrue("${file.path} absent on this branch — runs on the vc69 tip", file.isFile)
        val root = JsonParser.parseString(file.readText(Charsets.UTF_8)).asJsonObject
        val prefixes = root.getAsJsonArray("prefixes").map { it.asString }.toSet()
        for (frame in listOf(E2eAccountPref.FRAME_PUSH, E2eAccountPref.FRAME_REFUSED)) {
            assertTrue("'$frame:' missing from prefixes $prefixes", prefixes.contains("$frame:"))
        }
    }
}
