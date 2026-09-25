package com.dnkdialer.companion

import com.google.gson.JsonElement
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
 * vc69 T-E2E-ACCOUNT-PREF step 2 — RULE 30 runner for
 * `tests/e2e-pref-latch-vectors.json` (the SAME file, read from the repo root,
 * never a copy). Drives the REAL pure reducer [E2eAccountPref] over a
 * simulated per-userId store whose records go through the REAL
 * [E2eAccountPref.encode]/[E2eAccountPref.decode] on every step, so "restart"
 * and "sign-in as B" exercise the persisted shape, not an in-memory object.
 *
 * The harness mirrors [E2eAccountPrefController] one-for-one (userId from the
 * local store, push ignored with no id, sign-out wipes the current id's record,
 * legacy fallback when no id); the controller itself needs a Context and is
 * covered by the source assertions at the bottom.
 *
 * Run: `gradlew.bat testDebugUnitTest --tests '*E2eAccountPref*'`
 */
class E2eAccountPrefLatchVectorsTest {

    private val file = File("../../tests/e2e-pref-latch-vectors.json")

    private fun vectors(): List<JsonObject> {
        assertTrue("shared vector file missing at " + file.absolutePath, file.exists())
        val root = JsonParser.parseString(file.readText()).asJsonObject
        assertEquals("vector file version", 1, root.get("version").asInt)
        val v = root.getAsJsonArray("vectors").map { it.asJsonObject }
        // A vectors test whose file lost its rows passes vacuously.
        assertEquals("latch vector count", 31, v.size)
        val named = v.filter { it.get("named")?.asBoolean == true }.map { it.get("row").asInt }
        assertEquals("Ken's 14 rows + refused row + hostile row", (1..16).toList(), named)
        return v
    }

    /** The simulated device. */
    private class Device(v: JsonObject) {
        val records = HashMap<String, String>()
        var userId: String? = v.get("userId")?.takeUnless { it.isJsonNull }?.asString
        val userSetOn = v.getAsJsonObject("legacy").get("userSetOn").asBoolean
        var consumed = v.getAsJsonObject("legacy").get("consumed").asBoolean
        val sent = ArrayList<String>()
        val toasts = ArrayList<String>()

        init {
            for ((id, rec) in v.getAsJsonObject("users").entrySet()) {
                val o = rec.asJsonObject
                records[id] = if (o.has("raw")) o.get("raw").asString else {
                    val c = o.deepCopy()
                    c.addProperty("v", E2eAccountPref.STATE_VERSION)
                    c.toString()
                }
            }
        }

        fun legacy() = E2eAccountPref.Legacy(userSetOn, consumed)
        fun state(): E2eAccountPref.State? = userId?.let { E2eAccountPref.decode(records[it]) }
        fun advertised(): Boolean {
            val s = state() ?: return userSetOn // controller: legacy local switch
            return E2eAccountPref.advertisedOn(s, legacy())
        }

        fun apply(step: E2eAccountPref.Step) {
            val uid = userId ?: return
            records[uid] = E2eAccountPref.encode(step.state)
            for (e in step.effects) when (e) {
                is E2eAccountPref.Effect.Send -> sent += "${e.type}:${if (e.value) "on" else "off"}"
                is E2eAccountPref.Effect.Toast ->
                    toasts += e.kind.name + (e.retryAfterMs?.let { ":$it" } ?: "")
                E2eAccountPref.Effect.MarkLegacyConsumed -> consumed = true
                else -> Unit
            }
        }
    }

    private fun run(v: JsonObject): Device {
        val d = Device(v)
        val id = v.get("id").asString
        var now = 0L
        for ((i, stepEl) in v.getAsJsonArray("steps").withIndex()) {
            val st = stepEl.asJsonObject
            st.get("at")?.let { now = it.asLong }
            val where = "$id step $i"
            when {
                st.has("push") || st.has("pushRaw") -> {
                    val body: JsonObject? = if (st.has("push")) st.getAsJsonObject("push") else
                        runCatching { JsonParser.parseString(st.get("pushRaw").asString).asJsonObject }.getOrNull()
                    val push = E2eAccountPref.parsePush(body)
                    if (push == null || d.userId == null) continue // controller: dropped / ignored
                    val step = E2eAccountPref.onPush(d.state()!!, push, d.legacy(), now)
                    st.get("expectDropped")?.let { assertEquals("$where dropped", it.asBoolean, step.dropped) }
                    if (!step.dropped) d.apply(step)
                }
                st.has("userSet") -> d.apply(E2eAccountPref.onUserSet(d.state()!!, st.get("userSet").asString == "on", now))
                st.has("keepOff") -> d.apply(E2eAccountPref.onKeepOff(d.state()!!))
                st.has("keepCodeCheck") -> d.apply(E2eAccountPref.onKeepCodeCheck(d.state()!!))
                st.has("turnBackOn") -> d.apply(E2eAccountPref.onTurnBackOn(d.state()!!, now))
                st.has("refused") -> {
                    val r = st.getAsJsonObject("refused")
                    d.apply(
                        E2eAccountPref.onRefused(
                            d.state()!!, r.get("op").asString, r.get("reason")?.asString,
                            r.get("retryAfterMs")?.asLong, d.legacy(),
                        ),
                    )
                }
                st.has("signIn") -> d.userId = st.get("signIn").asString
                st.has("signOut") -> { d.userId?.let { d.records.remove(it) }; d.userId = null }
                st.has("restart") -> {
                    // Process death: every record is re-read from disk form.
                    for (k in d.records.keys.toList()) {
                        d.records[k] = E2eAccountPref.encode(E2eAccountPref.decode(d.records[k]))
                    }
                }
                st.has("assert") -> check(d, st.getAsJsonObject("assert"), where)
                else -> throw AssertionError("$where: unknown step $st")
            }
        }
        check(d, v.getAsJsonObject("expect"), "$id expect")
        return d
    }

    private fun JsonElement?.strOrNull(): String? = if (this == null || isJsonNull) null else asString

    private fun check(d: Device, e: JsonObject, where: String) {
        val s = d.state()
        e.get("userId")?.let { assertEquals("$where userId", it.strOrNull(), d.userId) }
        e.get("advertised")?.let { assertEquals("$where advertised", it.asBoolean, d.advertised()) }
        e.get("prompt")?.let { p ->
            assertEquals("$where prompt", p.strOrNull(), s?.pendingDowngrade?.kind?.name)
            assertEquals("$where promptVisible", p.strOrNull() != null, s?.let { E2eAccountPref.promptVisible(it) } ?: false)
        }
        e.get("sent")?.let { assertEquals("$where sent", it.asJsonArray.map { x -> x.asString }, d.sent) }
        e.get("toasts")?.let { assertEquals("$where toasts", it.asJsonArray.map { x -> x.asString }, d.toasts) }
        e.get("lastRev")?.let {
            if (it.isJsonNull) assertNull("$where no account", s) else assertEquals("$where lastRev", it.asInt, s!!.lastRev)
        }
        e.get("pendingOwnWrite")?.let {
            assertEquals("$where pendingOwnWrite", it.strOrNull(), s?.pendingOwnWrite?.let { w -> if (w.value) "on" else "off" })
        }
        e.get("notice")?.let {
            assertEquals("$where notice", it.strOrNull(), s?.notice?.let { n -> if (n.on) "on" else "off" })
        }
        e.getAsJsonObject("mirror")?.let { m ->
            assertNotNull("$where mirror", s?.mirror)
            fun oo(b: Boolean) = if (b) "on" else "off"
            assertEquals("$where mirror.preference", m.get("preference").asString, oo(s!!.mirror!!.preference))
            assertEquals("$where mirror.effective", m.get("effective").asString, oo(s.mirror!!.effective))
            assertEquals("$where mirror.pausedByServer", m.get("pausedByServer").asBoolean, s.mirror!!.pausedByServer)
        }
        e.get("legacyConsumed")?.let { assertEquals("$where legacyConsumed", it.asBoolean, d.consumed) }
        e.get("peerOffAtAccept")?.let {
            assertEquals(
                "$where effectiveMode(advertised, peer OFF)",
                it.asString,
                E2eSettings.effectiveMode(d.advertised(), E2eSettings.PeerAdvertisement.OFF).name,
            )
        }
        e.getAsJsonObject("users")?.entrySet()?.forEach { (id, x) ->
            val u = x.asJsonObject
            val rec = d.records[id]
            if (u.get("exists")?.asBoolean == false) {
                assertNull("$where users.$id wiped", rec)
            } else {
                assertNotNull("$where users.$id exists", rec)
                val us = E2eAccountPref.decode(rec)
                u.get("advertised")?.let { a -> assertEquals("$where users.$id advertised", a.asBoolean, us.advertised) }
                u.get("lastRev")?.let { r -> assertEquals("$where users.$id lastRev", r.asInt, us.lastRev) }
            }
        }
    }

    @Test
    fun every_latch_vector_passes() {
        val v = vectors()
        var n = 0
        for (row in v) { run(row); n++ }
        println("e2e-pref-latch-vectors: $n/${v.size} PASS")
    }

    /**
     * B1's core claim, restated as a sweep over EVERY updatedBy the server can
     * send (and a few it cannot): with no own write, a lowering push is latched.
     */
    @Test
    fun updatedBy_never_bypasses_the_latch() {
        val on = E2eAccountPref.State(advertised = true, lastRev = 3)
        val lg = E2eAccountPref.Legacy(false, false)
        for (by in listOf("web", "ext", "phone", "seed", "admin", null, "PHONE", "")) {
            for (paused in listOf(false, true)) {
                val push = E2eAccountPref.Resolved(paused, false, paused, 4, "2026-09-25T12:00:00.000Z", by)
                val step = E2eAccountPref.onPush(on, push, lg, 1000)
                assertTrue("by=$by paused=$paused latched", step.state.pendingDowngrade != null)
                assertTrue("by=$by still ON", E2eAccountPref.advertisedOn(step.state, lg))
            }
        }
    }

    /**
     * Equal-rev rule, the Android-only half (the shared vectors cover the rest):
     * at an unchanged rev a push whose SOURCE (updatedBy) or neverChosen differs
     * from the mirror is dropped as a mismatch even when only the master fields
     * would move; the controller logs that one as a warning.
     */
    @Test
    fun equal_rev_source_or_neverChosen_mismatch_is_dropped() {
        val lg = E2eAccountPref.Legacy(false, false)
        val t = "2026-09-25T12:00:00.000Z"
        val on = E2eAccountPref.State(
            advertised = true, lastRev = 4,
            mirror = E2eAccountPref.Resolved(true, true, false, 4, t, "web"),
        )
        for (by in listOf("ext", "phone", "seed", null, "WEB")) {
            val step = E2eAccountPref.onPush(on, E2eAccountPref.Resolved(true, false, true, 4, t, by), lg, 1000)
            assertTrue("by=$by dropped", step.dropped)
            assertEquals("by=$by reason", E2eAccountPref.DropReason.EQUAL_REV_MISMATCH, step.dropReason)
            assertEquals("by=$by state untouched", on, step.state)
        }
        // rev 0: the mirror never chose (updatedBy null); a push naming a writer at rev 0 is not the same row.
        val never = E2eAccountPref.State(
            advertised = false, lastRev = 0,
            mirror = E2eAccountPref.Resolved(false, false, false, 0, null, null),
        )
        val s2 = E2eAccountPref.onPush(never, E2eAccountPref.Resolved(false, false, false, 0, t, "web"), lg, 1000)
        assertEquals(E2eAccountPref.DropReason.EQUAL_REV_MISMATCH, s2.dropReason)
        // Same source, master flip: applied, masterOnly, updatedAt kept from the mirror.
        val ok = E2eAccountPref.onPush(on, E2eAccountPref.Resolved(true, false, true, 4, "2027-01-01T00:00:00.000Z", "web"), lg, 1000)
        assertFalse(ok.dropped)
        assertTrue(ok.masterOnly)
        assertEquals(t, ok.state.mirror!!.updatedAt)
        assertTrue(E2eAccountPref.promptVisible(ok.state))
        assertFalse(ok.effects.any { it is E2eAccountPref.Effect.MarkLegacyConsumed || it is E2eAccountPref.Effect.ShowNotice })
        val c = src("E2eAccountPrefController.kt").substringAfter("fun onPushFrame(").substringBefore("fun onRefusedFrame(")
        assertTrue(c.contains("E2eAccountPref.DropReason.EQUAL_REV_MISMATCH") && c.contains("DiagLog.w(TAG, \"E2E_PREF rev=") && c.contains("dropped (equal rev, preference/source mismatch)"))
    }

    @Test
    fun encode_decode_round_trips_every_field() {
        val s = E2eAccountPref.State(
            advertised = true,
            lastRev = 12,
            mirror = E2eAccountPref.Resolved(false, false, false, 12, "2026-09-25T12:00:00.000Z", "web"),
            pendingOwnWrite = E2eAccountPref.OwnWrite(false, 123L),
            pendingDowngrade = E2eAccountPref.PendingDowngrade(12, "web", "2026-09-25T12:00:00.000Z", E2eAccountPref.DowngradeKind.PREF_OFF),
            seedAttempted = true,
            notice = E2eAccountPref.Notice(true, "ext", null),
        )
        assertEquals(s, E2eAccountPref.decode(E2eAccountPref.encode(s)))
        assertEquals(E2eAccountPref.State(), E2eAccountPref.decode(null))
        assertEquals(E2eAccountPref.failClosed(), E2eAccountPref.decode("{\"v\":2}"))
        assertTrue(E2eAccountPref.advertisedOn(E2eAccountPref.failClosed(), E2eAccountPref.Legacy(false, true)))
    }

    // ------------------------------------------------ call-site assertions

    private fun src(name: String) = File("src/main/java/com/dnkdialer/companion/$name").readText()

    /** The Accept path advertises the POST-LATCH account value, not the legacy switch. */
    @Test
    fun accept_path_reads_the_post_latch_value() {
        val svc = src("PhoneService.kt")
        val decide = svc.substringAfter("private fun decideE2e(").substringBefore("return decision")
        assertTrue(decide.contains("E2eAccountPrefController.advertisedOn(this)"))
        assertFalse(decide.contains("E2eSettings.isEncryptedModeEnabled"))
        assertTrue(svc.contains("E2eAccountPref.FRAME_PUSH -> E2eAccountPrefController.onPushFrame(this, payload)"))
        assertTrue(svc.contains("E2eAccountPref.FRAME_REFUSED -> E2eAccountPrefController.onRefusedFrame(this, payload)"))
    }

    /** M1: the key is TokenStore's locally stored id; the frame never names the account. */
    @Test
    fun controller_keys_by_the_local_user_id_only() {
        val c = src("E2eAccountPrefController.kt")
        assertTrue(c.contains("TokenStore.getUserId(ctx)"))
        val onPush = c.substringAfter("fun onPushFrame(").substringBefore("fun onRefusedFrame(")
        assertFalse("the push must not supply the key", onPush.contains("payload?.get(\"userId\")") || onPush.contains("payload[\"userId\"]"))
        assertTrue(onPush.contains("val uid = userId(ctx)"))
    }

    /** M1: sign-out wipes the account record BEFORE TokenStore.clear() erases its key. */
    @Test
    fun sign_out_wipes_before_the_key_is_gone() {
        val a = src("AccountActions.kt")
        val wipe = a.indexOf("E2eAccountPrefController.onSignOut(activity)")
        val clear = a.indexOf("TokenStore.clear(activity)")
        assertTrue("wipe present", wipe > 0)
        assertTrue("wipe precedes TokenStore.clear", wipe < clear)
    }

    /** The Settings/Home switch no longer writes the legacy local store (read-only from vc69). */
    @Test
    fun switch_no_longer_writes_the_legacy_store() {
        val b = src("E2eModeRowBinder.kt")
        assertFalse(b.contains("E2eSettings.setEncryptedModeEnabled("))
        assertTrue(b.contains("E2eAccountPrefController.requestSet(ctx, on)"))
    }

    @Test
    fun copy_helpers() {
        assertEquals(R.string.e2e_pref_src_web, E2eAccountPrefCopy.sourceRes("web"))
        assertEquals(R.string.e2e_pref_src_ext, E2eAccountPrefCopy.sourceRes("ext"))
        assertEquals(R.string.e2e_pref_src_account, E2eAccountPrefCopy.sourceRes("<script>"))
        assertEquals(R.string.e2e_pref_src_account, E2eAccountPrefCopy.sourceRes(null))
        assertNull(E2eAccountPrefCopy.rateLimitedSeconds(null))
        assertNull(E2eAccountPrefCopy.rateLimitedSeconds(60_000))
        assertEquals(30, E2eAccountPrefCopy.rateLimitedSeconds(29_500))
    }
}
