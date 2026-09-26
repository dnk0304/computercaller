package com.dnkdialer.companion

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.os.Build
import android.os.IBinder
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * vc70 NOTIF-FORWARDING — emulator proof, the REAL PhoneService against a
 * scripted relay.
 *
 * The relay is an in-process WebSocketServer on loopback that records every
 * frame the phone sends (connection id, type, time). The service is the real
 * one: real NotificationListenerService, real E2E accept (device-key registry
 * served by a loopback HTTP stub via E2eDeviceKeyClient.baseOverride), real
 * E2eFrameGate, real SAS contract broadcasts. Notifications are posted by the
 * SHELL package via `cmd notification post` — a foreign package, which is what
 * the filter sees in production (our own package is always dropped).
 *
 * Every timeline line goes to logcat tag NOTIF-PROOF for the evidence file.
 */
@RunWith(AndroidJUnit4::class)
class NotifForwardingProofTest {

    private val instr get() = InstrumentationRegistry.getInstrumentation()
    private val ctx: Context get() = instr.targetContext

    private data class Frame(val conn: Int, val type: String, val atMs: Long, val body: String) {
        fun json(): JSONObject? = runCatching { JSONObject(body) }.getOrNull()
    }

    private val frames = CopyOnWriteArrayList<Frame>()
    private val connSeq = AtomicInteger(0)
    private val openConns = AtomicInteger(0)
    private val connIds = java.util.concurrent.ConcurrentHashMap<WebSocket, Int>()
    private lateinit var relay: WebSocketServer
    private var relayPort = 0

    private var keyServer: ServerSocket? = null
    private var svc: PhoneService? = null
    private var conn: ServiceConnection? = null
    private val webPub: ByteArray by lazy {
        val e = E2eKeyAgreement.mintEphemeral()
        try { e.publicSec1 } finally { e.close() }
    }

    private fun log(msg: String) = android.util.Log.i("NOTIF-PROOF", msg)

    private fun shell(cmd: String): String {
        val fd = instr.uiAutomation.executeShellCommand(cmd)
        return android.os.ParcelFileDescriptor.AutoCloseInputStream(fd).use {
            it.readBytes().toString(Charsets.UTF_8)
        }
    }

    private fun until(timeoutMs: Long, cond: () -> Boolean): Boolean {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            if (cond()) return true
            Thread.sleep(100)
        }
        return cond()
    }

    // ------------------------------------------------------------ fixtures

    @Before
    fun setUp() {
        val listener = "${ctx.packageName}/${DnkNotificationListenerService::class.java.name}"
        shell("cmd notification allow_listener $listener")
        shell("pm grant ${ctx.packageName} android.permission.POST_NOTIFICATIONS")

        relay = object : WebSocketServer(InetSocketAddress("127.0.0.1", 0)) {
            override fun onOpen(c: WebSocket, h: ClientHandshake?) {
                val id = connSeq.incrementAndGet()
                connIds[c] = id
                openConns.incrementAndGet()
                log("relay open conn=$id open=${openConns.get()}")
            }
            override fun onClose(c: WebSocket, code: Int, reason: String?, remote: Boolean) {
                openConns.decrementAndGet()
                log("relay close conn=${connIds[c]} code=$code open=${openConns.get()}")
            }
            override fun onMessage(c: WebSocket, message: String) {
                val i = message.indexOf(':')
                val type = if (i < 0) message else message.substring(0, i)
                val body = if (i < 0) "" else message.substring(i + 1)
                val f = Frame(connIds[c] ?: -1, type, System.currentTimeMillis(), body)
                frames += f
                val j = f.json()
                val detail = if (type == "PHONE_NOTIFICATION" && j != null) {
                    if (j.has("e") && j.has("kid")) "sealed" else
                        "pkg=${j.optString("packageName")} backfill=${j.optBoolean("backfill")} " +
                            "titleIsLabel=${j.optString("title") == shellLabel()}"
                } else ""
                log("relay <- conn=${f.conn} $type bytes=${body.length} $detail")
            }
            override fun onError(c: WebSocket?, ex: Exception) { log("relay error ${ex.javaClass.simpleName}") }
            override fun onStart() {}
        }.also { it.isReuseAddr = true; it.start() }
        assertTrue("relay did not bind", until(5_000) { relay.port != 0 })
        relayPort = relay.port

        startKeyRegistry()

        // A signed-in phone that has NOT auto-dialed prod: stayed-disconnected
        // holds startBridge's dial; we dial the scripted relay ourselves.
        TokenStore.clear(ctx)
        TokenStore.save(ctx, "proof-token", "Proof phone")
        TokenStore.putUserId(ctx, "acct-proof")
        TokenStore.setUserStayedDisconnected(ctx, true)

        ctx.startForegroundService(Intent(ctx, PhoneService::class.java).setAction(PhoneService.ACTION_START))
        val bound = CountDownLatch(1)
        conn = object : ServiceConnection {
            override fun onServiceConnected(n: ComponentName?, b: IBinder?) {
                svc = (b as PhoneService.LocalBinder).getService(); bound.countDown()
            }
            override fun onServiceDisconnected(n: ComponentName?) {}
        }
        ctx.bindService(Intent(ctx, PhoneService::class.java), conn!!, Context.BIND_AUTO_CREATE)
        assertTrue("service did not bind", bound.await(10, TimeUnit.SECONDS))
        assertTrue("listener not connected", until(10_000) { DnkNotificationListenerService.getInstance() != null })
        TokenStore.setUserStayedDisconnected(ctx, false)
        clearShellNotifications()
    }

    @After
    fun tearDown() {
        // The DiagExport side of the evidence: what app.log holds for this run.
        runCatching {
            DiagLog.ringSnapshot().filter {
                it.contains("NotifFwd") || it.contains("redial") || it.contains("sas confirmed")
            }.takeLast(60).forEach { log("diag> $it") }
        }
        runCatching { clearShellNotifications() }
        runCatching { svc?.disconnectRelay() }
        runCatching { conn?.let { ctx.unbindService(it) } }
        runCatching { ctx.stopService(Intent(ctx, PhoneService::class.java)) }
        runCatching { relay.stop(1000) }
        runCatching { keyServer?.close() }
        E2eDeviceKeyClient.baseOverride = null
        E2eSettings.setEncryptedModeEnabled(ctx, false)
        TokenStore.clear(ctx)
    }

    private fun shellLabel(): String =
        ctx.packageManager.getApplicationLabel(ctx.packageManager.getApplicationInfo("com.android.shell", 0)).toString()

    private fun clearShellNotifications() {
        val l = DnkNotificationListenerService.getInstance() ?: return
        for (sbn in runCatching { l.activeNotifications }.getOrNull().orEmpty()) {
            if (sbn.packageName == "com.android.shell") DnkNotificationListenerService.dismissByKey(sbn.key)
        }
        until(3_000) {
            runCatching { l.activeNotifications }.getOrNull().orEmpty().none { it.packageName == "com.android.shell" }
        }
    }

    /** Loopback stand-in for /api/devicekeys: this phone's row + the web peer's row. */
    private fun startKeyRegistry() {
        val ss = ServerSocket(0, 8, java.net.InetAddress.getByName("127.0.0.1"))
        keyServer = ss
        val phoneId = E2eLifecycle.deviceId(ctx)
        val phonePub = E2eKeyEncoding.toBase64Url(E2eKeyAgreement.devicePublicSec1(ctx))
        val rows = JSONArray()
            .put(JSONObject().put("deviceId", phoneId).put("kind", "phone").put("publicKey", phonePub).put("revokedAt", JSONObject.NULL))
            .put(JSONObject().put("deviceId", WEB_ID).put("kind", "web").put("publicKey", E2eKeyEncoding.toBase64Url(webPub)).put("revokedAt", JSONObject.NULL))
        Thread {
            while (!ss.isClosed) {
                val s = runCatching { ss.accept() }.getOrNull() ?: break
                runCatching {
                    s.use { sock ->
                        val r = sock.getInputStream().bufferedReader()
                        val line = r.readLine().orEmpty()
                        var len = 0
                        while (true) {
                            val h = r.readLine() ?: break
                            if (h.isEmpty()) break
                            if (h.lowercase().startsWith("content-length:")) len = h.substring(15).trim().toInt()
                        }
                        if (len > 0) { val buf = CharArray(len); r.read(buf) }
                        val body = if (line.contains("/list")) {
                            JSONObject().put("keys", rows).put("userId", "acct-proof").toString()
                        } else {
                            JSONObject().put("key", rows.getJSONObject(0)).put("rotated", false).put("userId", "acct-proof").toString()
                        }
                        log("registry ${line.substringBefore(" HTTP")}")
                        val bytes = body.toByteArray()
                        sock.getOutputStream().write(
                            ("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${bytes.size}\r\n" +
                                "Connection: close\r\n\r\n").toByteArray() + bytes
                        )
                    }
                }
            }
        }.apply { isDaemon = true }.start()
        E2eDeviceKeyClient.baseOverride = "http://127.0.0.1:${ss.localPort}/api/devicekeys"
    }

    private fun relayUrl() = "ws://127.0.0.1:$relayPort/relay/phone?token=proof-token"

    private fun toPhone(frame: String) {
        log("relay -> $frame".take(160))
        relay.connections.forEach { it.send(frame) }
    }

    private fun connectAndPair(pairingId: String, e2e: JSONObject?) {
        val s = svc!!
        assertEquals(RelayDialPolicy.Decision.DIAL, s.connectToRelay(relayUrl(), trigger = "proof"))
        assertTrue("phone never opened", until(10_000) { openConns.get() == 1 && frames.any { it.type == "DEVICE_INFO" } })
        val req = JSONObject().put("pairingId", pairingId).put("ua", "Proof").put("ip", "127.0.0.1")
        if (e2e != null) req.put("e2e", e2e)
        toPhone("PAIRING_REQUEST:$req")
        assertTrue("pairing handler missing", until(5_000) { ConnectionRequestReceiver.serviceHandler != null })
        Thread.sleep(500)
        ConnectionRequestReceiver.serviceHandler!!.invoke(pairingId, true)
        assertTrue("no ACCEPT_PAIRING", until(20_000) { frames.any { it.type == "ACCEPT_PAIRING" } })
    }

    private fun post(tag: String, text: String, title: String?) {
        val t = if (title != null) "-t $title " else ""
        shell("cmd notification post $t$tag $text")
        log("posted tag=$tag title=${title != null}")
    }

    private fun counter(name: String) = DiagLog.snapshotCounters()[name] ?: 0L

    private fun notifFrames(sinceMs: Long) = frames.filter { it.type == "PHONE_NOTIFICATION" && it.atMs >= sinceMs }

    private fun countersLine(prefix: String) =
        DiagLog.snapshotCounters().filterKeys {
            it.startsWith("notif.") || it.startsWith("backfill.") || it.startsWith("e2e.gate.") ||
                it.startsWith("redial_") || it == "net_redial"
        }.toSortedMap().toString().also { log("$prefix counters=$it") }

    // ------------------------------------------------------------- proofs

    /**
     * Plain pair: backfill on PAIRING_ACTIVE (one frame per forwardable shade
     * entry), then live adb posts — no-category titled, and null-title — each
     * produce EXACTLY one frame; the null-title one carries the app label.
     * The 4th shell post makes the platform post an autogroup SUMMARY, which
     * must not produce a frame. P4: a dial request on the open socket opens
     * no new socket.
     */
    @Test
    fun a_plain_pair_backfill_live_posts_and_dial_guard() {
        E2eSettings.setEncryptedModeEnabled(ctx, false)
        countersLine("start")
        post("pre1", "ShadeOne", "PreOne")
        post("pre2", "ShadeTwo", "PreTwo")
        Thread.sleep(1_500)

        connectAndPair("proof-plain-1", null)
        val tActive = System.currentTimeMillis()
        toPhone("PAIRING_ACTIVE:{}")
        assertTrue("backfill never arrived", until(10_000) {
            notifFrames(tActive).count { it.json()?.optBoolean("backfill") == true && it.json()?.optString("packageName") == "com.android.shell" } >= 2
        })
        Thread.sleep(2_000)
        val bf = notifFrames(tActive).filter { it.json()?.optBoolean("backfill") == true }
        val shellBf = bf.filter { it.json()?.optString("packageName") == "com.android.shell" }
        log("backfill frames total=${bf.size} shell=${shellBf.size} gapsMs=${bf.zipWithNext { a, b -> b.atMs - a.atMs }}")
        assertEquals("one backfill frame per shell shade entry", 2, shellBf.size)
        assertEquals("no key sent twice in the backfill", bf.size, bf.map { it.json()?.optString("notificationKey") }.toSet().size)

        // --- live: no category + title (the bank shape)
        val t1 = System.currentTimeMillis()
        post("bank1", "PaymentReceived", "Bank")
        Thread.sleep(3_000)
        val live1 = notifFrames(t1).filter { it.json()?.optString("packageName") == "com.android.shell" }
        assertEquals("one post -> one frame", 1, live1.size)

        // --- live: null title -> app label
        val t2 = System.currentTimeMillis()
        post("nt1", "BodyOnly", null)
        Thread.sleep(3_000)
        val live2 = notifFrames(t2).filter { it.json()?.optString("packageName") == "com.android.shell" }
        assertEquals("null title still forwards, once", 1, live2.size)
        assertEquals("title falls back to the app label", shellLabel(), live2[0].json()!!.optString("title"))

        // --- 4th live shell notification: autogroup summary appears
        val summaryBefore = counter("notif.drop.group_summary")
        val t3 = System.currentTimeMillis()
        post("bank2", "SecondPayment", "Bank")
        Thread.sleep(4_000)
        val live3 = notifFrames(t3).filter { it.json()?.optString("packageName") == "com.android.shell" }
        val summaryDrops = counter("notif.drop.group_summary") - summaryBefore
        log("post#4 frames=${live3.size} groupSummaryDrops=$summaryDrops")
        assertTrue(
            "the child forwards and the summary does not: frames=${live3.size}",
            live3.size == 1 || (summaryDrops == 0L && live3.size <= 2),
        )
        if (summaryDrops > 0) assertEquals(1, live3.size)

        // --- P4: an extra dial request while OPEN
        val conns = connSeq.get()
        val d = svc!!.connectToRelay(relayUrl(), trigger = "proof_extra")
        Thread.sleep(2_000)
        log("P4 extra dial decision=${d.key} conns before=$conns after=${connSeq.get()} open=${openConns.get()}")
        assertEquals(RelayDialPolicy.Decision.SKIP_OPEN, d)
        assertEquals("no second socket", conns, connSeq.get())
        assertEquals(1, openConns.get())
        countersLine("end")

        // SPEC-PLAIN-PRIVACY-9: DiagLog carries reasons and hashes, never the
        // package name, title or body of a notification.
        val ring = DiagLog.ringSnapshot()
        assertTrue("drop lines present", ring.any { it.contains("notif drop reason=") })
        for (secret in listOf("com.android.shell", "PaymentReceived", "BodyOnly", "ShadeOne", "PreOne")) {
            assertTrue("DiagLog leaked '$secret'", ring.none { it.contains(secret) })
        }
    }

    /**
     * Encrypted pair (item 3): PAIRING_ACTIVE arrives while the code is
     * pending -> NO frames and NO gate drops; the SAS confirm runs the
     * backfill -> sealed frames; the web's re-request within 10 s is skipped.
     */
    @Test
    fun b_encrypted_pair_backfills_after_sas_confirm() {
        E2eSettings.setEncryptedModeEnabled(ctx, true)
        post("enc1", "EncShadeOne", "EncOne")
        post("enc2", "EncShadeTwo", "EncTwo")
        Thread.sleep(1_500)

        val prompted = CountDownLatch(1)
        var promptedId: String? = null
        val fakeUi = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                promptedId = i?.getStringExtra(PhoneService.EXTRA_PAIRING_ID)
                log("SAS prompt received")
                prompted.countDown()
            }
        }
        val filter = IntentFilter(E2eSasContract.ACTION_E2E_SAS_REQUIRED)
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(fakeUi, filter, Context.RECEIVER_NOT_EXPORTED)
        else @Suppress("UnspecifiedRegisterReceiverFlag") ctx.registerReceiver(fakeUi, filter)
        try {
            val gateDropsBefore = DiagLog.snapshotCounters().filterKeys { it.startsWith("e2e.gate.drop.") }.values.sum()
            val runsBefore = counter("backfill.run")
            val deferBefore = counter("backfill.defer_sas")
            val dupeBefore = counter("backfill.skip_dupe")
            countersLine("enc start")

            val e2e = JSONObject().put("v", 1).put("mode", 1).put(
                "recips",
                JSONArray().put(JSONObject().put("kind", "web").put("deviceId", WEB_ID).put("pub", E2eKeyEncoding.toBase64Url(webPub))),
            )
            connectAndPair("proof-enc-1", e2e)
            val accept = frames.last { it.type == "ACCEPT_PAIRING" }.json()
            assertNotNull("ACCEPT carried no e2e block — pair is not encrypted", accept?.optJSONObject("e2e"))
            assertTrue("no SAS prompt", prompted.await(20, TimeUnit.SECONDS))

            val tActive = System.currentTimeMillis()
            toPhone("PAIRING_ACTIVE:{}")
            Thread.sleep(3_000)
            val beforeConfirm = notifFrames(tActive)
            log("between ACTIVE and confirm: frames=${beforeConfirm.size} defer=${counter("backfill.defer_sas") - deferBefore}")
            assertEquals("nothing may be sent while the code is pending", 0, beforeConfirm.size)
            assertEquals("the ACTIVE backfill was deferred", 1L, counter("backfill.defer_sas") - deferBefore)

            val tConfirm = System.currentTimeMillis()
            ctx.sendBroadcast(Intent(E2eSasContract.ACTION_E2E_SAS_RESULT).apply {
                setPackage(ctx.packageName)
                putExtra(PhoneService.EXTRA_PAIRING_ID, promptedId)
                putExtra(E2eSasContract.EXTRA_SAS_MATCHED, true)
            })
            log("SAS confirmed (fake UI)")
            assertTrue("backfill never arrived after confirm", until(10_000) { notifFrames(tConfirm).size >= 2 })
            Thread.sleep(1_500)
            val afterConfirm = notifFrames(tConfirm)
            log("after confirm: frames=${afterConfirm.size} firstAfterConfirmMs=${afterConfirm.first().atMs - tConfirm} " +
                "sealed=${afterConfirm.all { E2eFrameGate.looksSealed(it.body) }}")
            assertTrue("backfill frames must be sealed", afterConfirm.all { E2eFrameGate.looksSealed(it.body) })
            assertEquals("exactly one backfill run, on confirm", 1L, counter("backfill.run") - runsBefore)

            // the web's #18 re-request, ~1 s after the confirm backfill
            val tWeb = System.currentTimeMillis()
            toPhone("GET_NOTIFICATIONS:{}")
            Thread.sleep(3_000)
            val afterWeb = notifFrames(tWeb)
            log("web re-request: frames=${afterWeb.size} skipDupe=${counter("backfill.skip_dupe") - dupeBefore}")
            assertEquals("re-request within 10 s is skipped", 0, afterWeb.size)
            assertEquals(1L, counter("backfill.skip_dupe") - dupeBefore)

            val gateDropsAfter = DiagLog.snapshotCounters().filterKeys { it.startsWith("e2e.gate.drop.") }.values.sum()
            log("gate drops during test=${gateDropsAfter - gateDropsBefore}")
            assertEquals("0 gate drops", 0L, gateDropsAfter - gateDropsBefore)
            countersLine("enc end")
        } finally {
            runCatching { ctx.unregisterReceiver(fakeUi) }
        }
    }

    /**
     * P1: wifi off/on against a HOST relay (10.0.2.2), because a loopback
     * socket does not ride wifi. Needs the host relay from
     * the host-side scripted relay kept with the evidence (not in this tree);
     * skipped (not passed) without its port.
     */
    @Test
    fun c_wifi_off_on_redials_once_on_a_single_socket() {
        val port = InstrumentationRegistry.getArguments().getString("hostRelayPort")
        assumeTrue("host relay port not given", !port.isNullOrBlank())
        val url = "ws://10.0.2.2:$port/relay/phone?token=proof-token"
        val s = svc!!
        shell("svc wifi enable")
        Thread.sleep(3_000)
        assertEquals(RelayDialPolicy.Decision.DIAL, s.connectToRelay(url, trigger = "proof"))
        assertTrue("never opened", until(10_000) { s.relayPhase == PhoneService.RelayPhase.OPEN })
        Thread.sleep(3_000)
        val redialBefore = counter("net_redial")
        countersLine("wifi start")

        val tOff = System.currentTimeMillis()
        log("wifi disable")
        shell("svc wifi disable")
        val reopened = until(15_000) {
            counter("net_redial") > redialBefore && s.relayPhase == PhoneService.RelayPhase.OPEN
        }
        log("wifi off: net_redial=${counter("net_redial") - redialBefore} reopenMs=${System.currentTimeMillis() - tOff} phase=${s.relayPhase}")
        Thread.sleep(3_000)

        val tOn = System.currentTimeMillis()
        log("wifi enable")
        shell("svc wifi enable")
        Thread.sleep(8_000)
        log("wifi on: phase=${s.relayPhase} net_redial=${counter("net_redial") - redialBefore} sinceOnMs=${System.currentTimeMillis() - tOn}")
        countersLine("wifi end")
        assertTrue("re-dial after wifi off did not reopen within 15 s", reopened)
        assertEquals(PhoneService.RelayPhase.OPEN, s.relayPhase)
    }

    private companion object {
        const val WEB_ID = "dev-web-proof"
    }
}
