package com.dnkdialer.companion

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.InputStreamReader

/**
 * E2E P4 Part 2 (b) — the instrumented SAS vectors test.
 *
 * `app/src/androidTest/resources/sas-vectors.json` is a BYTE-IDENTICAL copy of
 * `tests/sas-vectors.json` at P1's a0 commit `ce603b5`
 * (sha256 fb7bced0d702337b54281fb474186fb05688f447ea7944f705b27c93a9e04562).
 * The web lane, the service-worker lane and this one are all pinned by that one
 * file. If they disagree, no mode-ON pairing completes anywhere.
 *
 * ## Why this asserts the transcript and not only the digits
 *
 * Five digits collide one time in 100000. A transcript bug that happened to
 * collide would read as a pass, and it would read as a pass on the vector most
 * likely to be run first. So every vector's `transcriptHex` is asserted before
 * its digits: the transcript is the thing the protocol actually agrees on, and
 * the digits are a lossy projection of it.
 *
 * ## Why it asserts the file's SHAPE first
 *
 * A reference file guards only what the reader actually understood. If the JSON
 * were re-encoded, truncated, or silently replaced by an older copy without the
 * P-256 vector, a per-vector loop would still report a cheerful green over
 * whatever it managed to parse. So [the_vectors_file_is_the_one_we_think_it_is]
 * asserts the count, the ids, and — the load-bearing one — that `v6-3key-p256`
 * is present and really does carry 65-byte points.
 */
@RunWith(AndroidJUnit4::class)
class E2eSasVectorsTest {

    private fun load(): JsonObject {
        val stream = javaClass.classLoader!!.getResourceAsStream("sas-vectors.json")
            ?: throw AssertionError(
                "sas-vectors.json is not on the androidTest classpath — it must live in " +
                    "app/src/androidTest/resources/ and be a byte-identical copy of " +
                    "tests/sas-vectors.json at P1 a0 (ce603b5)"
            )
        return InputStreamReader(stream, Charsets.UTF_8).use {
            JsonParser.parseReader(it).asJsonObject
        }
    }

    private fun hex(s: String) = E2eKdf.fromHex(s)

    // -------------------------------------------------- the file's own shape

    @Test
    fun the_vectors_file_is_the_one_we_think_it_is() {
        val root = load()
        assertEquals("cc-sas-v1", root["version"].asString)
        assertEquals("cc-sas-v1", root["info"].asString)
        assertEquals("SHA-256", root["hash"].asString)
        assertTrue(
            "the curve note must record the Gate 1 P-256 ruling",
            root["curve"].asString.contains("P-256")
        )

        val vectors = root["vectors"].asJsonArray
        assertEquals("vector count — a short file guards less than you think", 6, vectors.size())

        val ids = vectors.map { it.asJsonObject["id"].asString }
        assertEquals(
            listOf(
                "v1-2key-mode-off",
                "v2-2key-mode-on",
                "v3-3key-mode-on",
                "v4-3key-sw-swapped",
                "v5-4key-mode-on",
                "v6-3key-p256",
            ),
            ids
        )

        // The reason P4 waited for P1's a0: v6 is the vector with REAL 65-byte
        // uncompressed SEC1 points, i.e. the shape this app actually puts on the
        // wire. Vectors v1..v4 use 32-byte placeholders that pin the FRAMING
        // only. Without this assertion a stale pre-a0 copy of the file would
        // pass every other test in this class.
        val v6 = vectors.map { it.asJsonObject }.first { it["id"].asString == "v6-3key-p256" }
        assertEquals(65, hex(v6["epk"].asString).size)
        for (k in v6["keys"].asJsonArray) {
            val bytes = hex(k.asString)
            assertEquals("v6 keys must be 65-byte SEC1 points", 65, bytes.size)
            assertEquals("…with the uncompressed tag", 0x04.toByte(), bytes[0])
            // And they must be points this app would accept from a peer.
            E2eKeyEncoding.validate(bytes)
        }
    }

    // ------------------------------------------------------- every vector

    @Test
    fun every_vector_matches_transcript_then_digits() {
        val vectors = load()["vectors"].asJsonArray
        var checked = 0
        for (e in vectors) {
            val v = e.asJsonObject
            val id = v["id"].asString
            val epk = hex(v["epk"].asString)
            val keys = v["keys"].asJsonArray.map { hex(it.asString) }
            val epoch = v["pairEpoch"].asLong
            val modeOn = v["modeOn"].asBoolean

            val transcript = E2eSas.transcript(epk, keys, epoch, modeOn)
            assertEquals(
                "$id: TRANSCRIPT mismatch — the digits are a lossy projection of this, " +
                    "so fix the transcript, never the digits",
                v["transcriptHex"].asString,
                E2eKdf.toHex(transcript)
            )
            assertEquals(
                "$id: digits mismatch",
                v["digits"].asString,
                E2eSas.digits(v["pairingId"].asString, epk, keys, epoch, modeOn)
            )
            checked++
        }
        assertEquals("every vector must have been exercised", vectors.size(), checked)
        assertTrue("the loop must not have run over an empty file", checked >= 6)
    }

    // --------------------------------------------- the B9 discriminating case

    /**
     * The whole reason the transcript covers the FULL key set. v4 is v3 with
     * only the service worker's key swapped; if this lane computed a
     * per-recipient SAS, or dropped the SW from the set, these two would produce
     * the same digits and a swapped SW key would be invisible to the user.
     */
    @Test
    fun swapping_only_the_service_worker_key_moves_the_digits() {
        val byId = load()["vectors"].asJsonArray
            .map { it.asJsonObject }.associateBy { it["id"].asString }
        val v3 = byId["v3-3key-mode-on"]!!
        val v4 = byId["v4-3key-sw-swapped"]!!

        // Control: the two vectors really do differ in exactly one key.
        val k3 = v3["keys"].asJsonArray.map { it.asString }.toSet()
        val k4 = v4["keys"].asJsonArray.map { it.asString }.toSet()
        assertEquals("v4 must differ from v3 by exactly one key", 1, (k3 - k4).size)
        assertEquals(v3["pairingId"].asString, v4["pairingId"].asString)
        assertEquals(v3["epk"].asString, v4["epk"].asString)
        assertEquals(v3["pairEpoch"].asLong, v4["pairEpoch"].asLong)
        assertEquals(v3["modeOn"].asBoolean, v4["modeOn"].asBoolean)

        assertNotEquals(
            "a swapped SW key MUST change the digits the user reads",
            digitsOf(v3),
            digitsOf(v4)
        )
    }

    /** The modeByte alone must move the digits (v1 vs v2). */
    @Test
    fun the_mode_byte_alone_moves_the_digits() {
        val byId = load()["vectors"].asJsonArray
            .map { it.asJsonObject }.associateBy { it["id"].asString }
        val off = byId["v1-2key-mode-off"]!!
        val on = byId["v2-2key-mode-on"]!!
        assertEquals(off["keys"].toString(), on["keys"].toString())
        assertEquals(off["epk"].asString, on["epk"].asString)
        assertNotEquals(digitsOf(off), digitsOf(on))
    }

    // ----------------------------------------------------- the sorting rule

    /**
     * Kotlin's `Byte` is signed. A comparison that forgets `and 0xff` orders
     * 0x80 before 0x01, so two parties that learned the keys in different orders
     * compute different digits — intermittently, and only for key sets that
     * happen to contain a high byte.
     */
    @Test
    fun the_key_set_is_sorted_unsigned_and_deduplicated() {
        val low = ByteArray(32) { 0x01 }
        val high = ByteArray(32) { 0x80.toByte() }
        val mid = ByteArray(32) { 0x7f }

        val sorted = E2eSas.canonicalKeySet(listOf(high, low, mid))
        assertEquals(3, sorted.size)
        assertEquals("0x01 first", 0x01.toByte(), sorted[0][0])
        assertEquals("0x7f second", 0x7f.toByte(), sorted[1][0])
        assertEquals("0x80 LAST — signed comparison would put it first", 0x80.toByte(), sorted[2][0])

        // Order of presentation must not matter.
        assertEquals(
            E2eKdf.toHex(E2eSas.transcript(low, listOf(high, low, mid), 1, true)),
            E2eKdf.toHex(E2eSas.transcript(low, listOf(mid, high, low), 1, true))
        )
        // Duplicates collapse.
        assertEquals(2, E2eSas.canonicalKeySet(listOf(low, high, low, high, low)).size)
        // A prefix sorts before its extension.
        val prefix = byteArrayOf(0x01, 0x02)
        val ext = byteArrayOf(0x01, 0x02, 0x03)
        assertTrue(E2eSas.compareBytes(prefix, ext) < 0)
    }

    @Test
    fun degenerate_inputs_are_refused() {
        val k = ByteArray(32) { 1 }
        for (bad in listOf<() -> Any>(
            { E2eSas.canonicalKeySet(emptyList()) },
            { E2eSas.canonicalKeySet(listOf(ByteArray(0))) },
            { E2eSas.canonicalKeySet(listOf(ByteArray(256))) },
            { E2eSas.transcript(ByteArray(0), listOf(k), 1, true) },
            { E2eSas.transcript(ByteArray(256), listOf(k), 1, true) },
            { E2eSas.transcript(k, listOf(k), -1, true) },
            { E2eSas.digits("", k, listOf(k), 1, true) },
        )) {
            try {
                bad()
                fail("a degenerate SAS input was accepted")
            } catch (e: E2eSas.SasException) {
                assertTrue(e.message!!.isNotEmpty())
            }
        }
    }

    /**
     * The end-to-end shape this app will actually run: real P-256 device keys,
     * a real ephemeral, computed twice from independently ordered key lists.
     */
    @Test
    fun real_p256_keys_produce_a_stable_five_digit_code() {
        val phone = E2eKeyAgreement.mintEphemeral()
        val web = E2eKeyAgreement.mintEphemeral()
        val sw = E2eKeyAgreement.mintEphemeral()
        try {
            val epk = phone.publicSec1
            val a = E2eSas.digits(
                "pair-live", epk, listOf(phone.publicSec1, web.publicSec1, sw.publicSec1), 9, true
            )
            val b = E2eSas.digits(
                "pair-live", epk, listOf(sw.publicSec1, phone.publicSec1, web.publicSec1), 9, true
            )
            assertEquals("key order must not change the code", a, b)
            assertEquals("the code is five digits", 5, a.length)
            assertTrue("digits only: '$a'", a.all { it.isDigit() })

            // Negative control: drop the SW and the code must change.
            assertNotEquals(
                "dropping a recipient must change the code",
                a,
                E2eSas.digits("pair-live", epk, listOf(phone.publicSec1, web.publicSec1), 9, true)
            )
        } finally {
            phone.close(); web.close(); sw.close()
        }
    }

    private fun digitsOf(v: JsonObject): String = E2eSas.digits(
        v["pairingId"].asString,
        hex(v["epk"].asString),
        v["keys"].asJsonArray.map { hex(it.asString) },
        v["pairEpoch"].asLong,
        v["modeOn"].asBoolean,
    )
}
