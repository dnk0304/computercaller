package com.dnkdialer.companion

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * FT-A1 sealed-offer hint — the PHONE half of the cross-surface contract
 * (RESUME-PROTOCOL v3.0 RULE 30).
 *
 * ## One file, two implementations
 *
 * `tests/e2e-ft-hint-vectors.json` at the repo root is the SINGLE source of
 * truth. The web lane asserts it in `tests/e2e-ft-hint-contract.test.mjs`
 * (`ftHintFor` -> the envelope `sealOutbound` emits -> the REAL relay accessor
 * `ftOfferMetadata` sliced out of server.js); this file asserts the SAME rows
 * against [FileTransfer.hintFor] and [E2eFrameGate]'s private `attachHint`,
 * which is where the phone actually splices the hint onto a sealed envelope.
 * Same pattern as [E2eKdfVectorsTest] and [E2eSasBlockingContractTest]: a
 * shared vector file is the only thing that can catch the two sides quietly
 * disagreeing, because each side's own tests agree with it by construction.
 *
 * ## The defect this exists for
 *
 * server.js:2361-2392 fails CLOSED when a sealed FILE_OFFER carries no
 * plaintext `ft` hint (drop reason `bad_hint`, server.js:2483). This side has
 * attached one since FT-A1 landed; the BROWSER sealed FILE_OFFER as a bare
 * envelope, so every browser->phone file on any sealed pair was refused —
 * Dennis's "0 bytes, no progress bar", proven on PROD 6d0aa98 by ACCEPT-9.
 * That is a web fix. This file pins the phone shape the web side was told to
 * mirror, so the two producers cannot drift apart again in silence.
 *
 * ## No Kotlin product code changes on this lane
 *
 * Ken's ruling: the F1 lane is web + one Kotlin TEST file. Nothing under
 * `app/src/main` is touched here.
 *
 * Run: `gradlew.bat testDebugUnitTest --tests '*E2eFtHintContractTest*'`
 */
class E2eFtHintContractTest {

    /** Unit-test cwd is `dnkdialer-android/app`, so `../..` is the repo root. */
    private val file = File("../../tests/e2e-ft-hint-vectors.json")

    private fun root(): JsonObject {
        assertTrue(
            "the shared vector file is missing at " + file.absolutePath +
                " — the web lane and this one must read the SAME file",
            file.exists()
        )
        return JsonParser.parseString(file.readText()).asJsonObject
    }

    private fun rows(): List<JsonObject> {
        val r = root()
        assertEquals("vector file version", 1, r.get("version").asInt)
        val rows = r.getAsJsonArray("rows").map { it.asJsonObject }
        // A vectors test whose file lost its rows passes vacuously. It must not.
        assertTrue("the vector file still carries its rows", rows.size >= 10)
        return rows
    }

    /**
     * What THIS surface is expected to emit for a row.
     *
     * `expectHintPhone`, when present, records a MEASURED divergence from the
     * web producer rather than smoothing one over: on `hint-id-uppercase` the
     * web side validates the id against the relay's own `^[0-9a-f]{32}$` and
     * emits nothing, while [FileTransfer.hintFor] passes any non-null String
     * through. Both land on the relay's same `bad_hint` verdict, and the phone
     * mints lowercase ids, so it is not a live defect — but it is a real
     * difference and it is stated in the contract instead of being discovered
     * in an outage. Tightening this side is android PRODUCT code and belongs to
     * the vc64 lane; Ken's ACCEPT-9 ruling keeps this web hotfix out of
     * `app/src/main`.
     */
    private fun expectFor(row: JsonObject) =
        if (row.has("expectHintPhone")) row.get("expectHintPhone") else row.get("expectHint")

    /** The sealed body as [E2eFrameGate.attachHint] sees it: primitives only. */
    private fun fieldsOf(body: JsonObject): Map<String, Any?> {
        val fields = mutableMapOf<String, Any?>()
        for ((k, v) in body.entrySet()) {
            fields[k] = if (v.isJsonPrimitive) {
                val p = v.asJsonPrimitive
                if (p.isNumber) p.asNumber else if (p.isString) p.asString else null
            } else null
        }
        return fields
    }

    /**
     * The REAL private splice, invoked reflectively.
     *
     * Re-typing the splice here would make this a second opinion about the same
     * bytes — the mistake a cross-surface contract exists to prevent. Calling
     * the production method needs no session and no keystore: it takes the
     * sealed body and an already-built envelope string.
     */
    private fun attachHint(gate: E2eFrameGate, type: String, sealedJson: String, envelope: String): String {
        val m = E2eFrameGate::class.java.getDeclaredMethod(
            "attachHint", String::class.java, String::class.java, String::class.java
        )
        m.isAccessible = true
        return m.invoke(gate, type, sealedJson, envelope) as String
    }

    private fun gate(): E2eFrameGate =
        E2eFrameGate(sessionProvider = { null }, latchedProvider = { false })

    // ── 1. the hint key and id shape both surfaces are built on ───────────
    @Test
    fun `the vector file names the key and id shape this side splices`() {
        val r = root()
        assertEquals("the hint key", FileTransfer.HINT_KEY, r.get("hintKey").asString)
        assertEquals("the relay's id shape", "^[0-9a-f]{32}\$", r.get("idPattern").asString)
        assertEquals("FILE_OFFER is the frame the hint belongs to", "FILE_OFFER", FileTransfer.OFFER)
    }

    // ── 2. the phone producer over every row ──────────────────────────────
    @Test
    fun `FileTransfer hintFor agrees with the shared vectors on every row`() {
        val idPattern = Regex(root().get("idPattern").asString)
        var offerRows = 0
        for (row in rows()) {
            val id = row.get("id").asString
            val type = row.get("type").asString
            val expect = expectFor(row)
            val hint = FileTransfer.hintFor(type, fieldsOf(row.getAsJsonObject("body")))

            if (expect == null || expect.isJsonNull) {
                assertNull("$id: the phone producer must emit NO hint", hint)
                continue
            }
            offerRows++
            assertNotNull("$id: the phone producer must emit a hint", hint)
            assertEquals("$id: hint id", expect.asJsonObject.get("id").asString, hint!!["id"] as String)
            assertEquals("$id: hint size", expect.asJsonObject.get("size").asLong, hint["size"] as Long)
            // EVERY row must emit a relay-acceptable id except the ONE that
            // records the divergence, where this side is the looser of the two
            // and the emitted id is exactly what the relay will refuse. Writing
            // it as an equality rather than a relaxed assertTrue keeps both
            // directions measured: if this side were tightened (the vc64 lane),
            // the divergence row goes red here and must be retired from the
            // vector file rather than quietly passing.
            assertEquals(
                "$id: does the emitted id match the shape the relay accepts?",
                !row.has("expectHintPhone"),
                idPattern.matches(hint["id"] as String)
            )
        }
        // A loop that asserted nothing because every row went down the null arm
        // would pass. It must not: the rows this contract exists for are the
        // ones that DO produce a hint.
        assertTrue("at least the offer rows produced a hint", offerRows >= 3)
    }

    // ── 3. the real splice, and what it does NOT put on the wire ──────────
    @Test
    fun `attachHint splices the hint as a sibling of the four authenticated fields`() {
        val g = gate()
        val idPattern = Regex(root().get("idPattern").asString)
        var spliced = 0
        for (row in rows()) {
            val rowId = row.get("id").asString
            val type = row.get("type").asString
            val body = row.getAsJsonObject("body")
            val envelopeVec = row.getAsJsonObject("envelope")
            // The four authenticated fields exactly as E2eEnvelope.Sealed.toJson
            // would have produced them for this row.
            val sealed = "{\"e\":" + envelopeVec.get("e").asInt +
                ",\"kid\":\"" + envelopeVec.get("kid").asString + "\"" +
                ",\"s\":" + envelopeVec.get("s").asInt +
                ",\"c\":\"" + envelopeVec.get("c").asString + "\"}"

            val out = attachHint(g, type, body.toString(), sealed)
            val parsed = JsonParser.parseString(out).asJsonObject

            // The authenticated four survive the splice byte for byte — the peer
            // authenticates those and a re-serialise could reorder them.
            assertTrue("$rowId: the splice produced valid JSON", parsed.has("c"))
            assertEquals("$rowId: e survives", envelopeVec.get("e").asInt, parsed.get("e").asInt)
            assertEquals("$rowId: kid survives", envelopeVec.get("kid").asString, parsed.get("kid").asString)
            assertEquals("$rowId: s survives", envelopeVec.get("s").asInt, parsed.get("s").asInt)
            assertEquals("$rowId: c survives", envelopeVec.get("c").asString, parsed.get("c").asString)

            // Nothing that belongs inside the ciphertext leaves in the clear.
            for (leak in listOf("name", "mime", "sha256", "from")) {
                assertFalse("$rowId: $leak must stay sealed", parsed.has(leak))
            }

            val expect = expectFor(row)
            if (expect == null || expect.isJsonNull) {
                assertFalse(
                    "$rowId: no hint may be spliced onto this frame",
                    parsed.has(FileTransfer.HINT_KEY)
                )
                continue
            }
            spliced++
            assertTrue("$rowId: the hint was spliced", parsed.has(FileTransfer.HINT_KEY))
            val ft = parsed.getAsJsonObject(FileTransfer.HINT_KEY)
            assertEquals("$rowId: spliced id", expect.asJsonObject.get("id").asString, ft.get("id").asString)
            assertEquals("$rowId: spliced size", expect.asJsonObject.get("size").asLong, ft.get("size").asLong)
            assertEquals(
                "$rowId: does the spliced id match the shape the relay accepts?",
                !row.has("expectHintPhone"),
                idPattern.matches(ft.get("id").asString)
            )
            assertEquals("$rowId: the hint carries id and size and nothing else", 2, ft.entrySet().size)
        }
        assertTrue("at least the offer rows were spliced", spliced >= 3)
    }

    // ── 4. the defect, and the controls that prove this file can go red ───
    @Test
    fun `the browser row is the same shape this side emits`() {
        val web = rows().first { it.get("id").asString == "web-offer-hint" }
        val phone = rows().first { it.get("id").asString == "phone-offer-hint" }
        for (row in listOf(web, phone)) {
            val hint = FileTransfer.hintFor("FILE_OFFER", fieldsOf(row.getAsJsonObject("body")))
            assertNotNull("both producers must reach a hint for a valid offer body", hint)
            val wire = row.getAsJsonObject("envelope").getAsJsonObject(FileTransfer.HINT_KEY)
            assertEquals("same id on the wire", wire.get("id").asString, hint!!["id"] as String)
            assertEquals("same size on the wire", wire.get("size").asLong, hint["size"] as Long)
        }
        // The PRE-FIX browser wire shape, recorded in the vectors: a valid body
        // whose envelope carries no hint. This side would never emit it, and the
        // relay refuses it — which is the whole defect.
        val bare = rows().first { it.get("id").asString == "no-hint-bare-envelope" }
        assertTrue("the regression row is marked", bare.get("wireOmitsHint").asBoolean)
        assertFalse(
            "the pre-fix envelope carries no hint",
            bare.getAsJsonObject("envelope").has(FileTransfer.HINT_KEY)
        )
        assertNotNull(
            "and yet the producer must hint that very body — the two cannot both be shipped code",
            FileTransfer.hintFor("FILE_OFFER", fieldsOf(bare.getAsJsonObject("body")))
        )
    }

    @Test
    fun `controls — the producer and the splice are both capable of refusing`() {
        val g = gate()
        val valid = mapOf<String, Any?>("id" to "3f2a91c0d4e84b6798aa10ff5c3b7d20", "size" to 4404019L)
        assertNotNull("CONTROL: the producer hints a valid offer", FileTransfer.hintFor("FILE_OFFER", valid))
        assertNull("CONTROL: never for a non-offer frame", FileTransfer.hintFor("FILE_ACCEPT", valid))
        assertNull(
            "CONTROL: never for an offer with no id",
            FileTransfer.hintFor("FILE_OFFER", mapOf("size" to 1L))
        )
        assertNull(
            "CONTROL: never for an offer with no size",
            FileTransfer.hintFor("FILE_OFFER", mapOf("id" to "3f2a91c0d4e84b6798aa10ff5c3b7d20"))
        )
        // CONTROL: the splice returns the envelope UNTOUCHED when there is
        // nothing to hint. If this ever started appending something, every
        // "no hint on a non-offer" assertion above would be measuring nothing.
        val env = "{\"e\":1,\"kid\":\"k\",\"s\":1,\"c\":\"x\"}"
        assertEquals(
            "CONTROL: a non-offer envelope leaves untouched",
            env,
            attachHint(g, "FILE_ACCEPT", "{\"id\":\"3f2a91c0d4e84b6798aa10ff5c3b7d20\"}", env)
        )
        assertEquals(
            "CONTROL: an unparseable body leaves the envelope untouched",
            env,
            attachHint(g, "FILE_OFFER", "not json", env)
        )
    }
}
