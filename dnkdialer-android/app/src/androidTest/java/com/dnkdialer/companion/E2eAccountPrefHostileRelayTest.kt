package com.dnkdialer.companion

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetSocketAddress
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * vc69 T-E2E-ACCOUNT-PREF — Security B1, on a device, end to end through the
 * REAL [PhoneClient] frame parser, the REAL [E2eAccountPrefController] and the
 * REAL SharedPreferences file.
 *
 * A HOSTILE relay (an in-process WebSocketServer on loopback): on the first
 * connection it honestly pushes the account ON; the socket drops (an ordinary
 * blip); on the reconnect it pushes E2E_PREF "off" with a forged rev jump,
 * `updatedBy:"phone"`, a plausible `updatedAt` — and sends NO
 * PAIRING_TERMINATED / ROOM_RESET. The phone must:
 *  - keep advertising ON (the Accept path's input stays true),
 *  - hold the latch (prompt owed), persisted — it survives a re-read,
 *  - and decide a pairing against a web computer advertising OFF as
 *    ENCRYPTED_VERIFIED, i.e. the code is shown on both screens (OR rule).
 *
 * Runs against a throwaway account id via [E2eAccountPrefController.userIdSource]
 * so the device's persist-once TokenStore id is never touched.
 */
@RunWith(AndroidJUnit4::class)
class E2eAccountPrefHostileRelayTest {

    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext
    private val testUser = "hostile-relay-test-user"
    private lateinit var savedSource: (android.content.Context) -> String?

    @Before
    fun setUp() {
        savedSource = E2eAccountPrefController.userIdSource
        E2eAccountPrefController.userIdSource = { testUser }
        E2eAccountPrefController.onSignOut(ctx) // clean slate for the test id
    }

    @After
    fun tearDown() {
        E2eAccountPrefController.onSignOut(ctx)
        E2eAccountPrefController.userIdSource = savedSource
    }

    private class HostileRelay(private val frames: List<List<String>>) :
        WebSocketServer(InetSocketAddress("127.0.0.1", 0)) {
        @Volatile var connections = 0
        val started = CountDownLatch(1)
        override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
            val i = connections++
            frames.getOrNull(i)?.forEach { conn.send(it) }
        }
        override fun onClose(conn: WebSocket, code: Int, reason: String?, remote: Boolean) = Unit
        override fun onMessage(conn: WebSocket, message: String) = Unit
        override fun onError(conn: WebSocket?, ex: Exception) = Unit
        override fun onStart() { started.countDown() }
    }

    private fun connectAndWaitFor(port: Int, frames: Int): PhoneClient {
        val got = CountDownLatch(frames)
        val c = PhoneClient(
            URI("ws://127.0.0.1:$port/"),
            { command, payload ->
                when (command) {
                    E2eAccountPref.FRAME_PUSH -> { E2eAccountPrefController.onPushFrame(ctx, payload); got.countDown() }
                    E2eAccountPref.FRAME_REFUSED -> { E2eAccountPrefController.onRefusedFrame(ctx, payload); got.countDown() }
                }
            },
            { },
        )
        assertTrue("connect", c.connectBlocking(10, TimeUnit.SECONDS))
        assertTrue("frames delivered", got.await(10, TimeUnit.SECONDS))
        return c
    }

    @Test
    fun forged_off_after_reconnect_keeps_the_code_check() {
        val honestOn = "E2E_PREF:{\"preference\":\"on\",\"effective\":\"on\",\"pausedByServer\":false," +
            "\"rev\":5,\"updatedAt\":\"2026-09-25T12:00:00.000Z\",\"updatedBy\":\"web\"}"
        val forgedOff = "E2E_PREF:{\"preference\":\"off\",\"effective\":\"off\",\"pausedByServer\":false," +
            "\"rev\":999999,\"updatedAt\":\"2026-09-25T12:00:01.000Z\",\"updatedBy\":\"phone\"}"
        val relay = HostileRelay(listOf(listOf(honestOn), listOf(forgedOff)))
        relay.isReuseAddr = true
        relay.start()
        try {
            assertTrue(relay.started.await(10, TimeUnit.SECONDS))
            val port = relay.port

            // Connection 1: the account is ON.
            connectAndWaitFor(port, 1).closeBlocking()
            assertTrue("honest ON applied", E2eAccountPrefController.advertisedOn(ctx))

            // Connection 2 (the "blip" reconnect): forged OFF, no reset frames.
            val c2 = connectAndWaitFor(port, 1)
            try {
                val s = E2eAccountPrefController.state(ctx)
                assertNotNull(s)
                assertEquals("rev recorded", 999999, s!!.lastRev)
                assertNotNull("latched: the prompt is owed", s.pendingDowngrade)
                assertTrue("still advertising ON", E2eAccountPrefController.advertisedOn(ctx))
            } finally {
                c2.closeBlocking()
            }

            // Persisted: a fresh read of the same prefs file still latches.
            assertNotNull(E2eAccountPrefController.state(ctx)?.pendingDowngrade)

            // Pairing against a web computer advertising OFF: the code is shown.
            val webOff = E2eNegotiation.PeerOffer(
                advertisement = E2eSettings.PeerAdvertisement.OFF,
                recipients = listOf(E2eNegotiation.Recipient("web", "AAAAAAAAAAAAAAAAAAAAAA", ByteArray(65) { 4 })),
            )
            val d = E2eNegotiation.decide(E2eAccountPrefController.advertisedOn(ctx), webOff, null)
            assertTrue("sealed", d is E2eNegotiation.Decision.Encrypted)
            assertTrue("SAS blocking = the code is shown", (d as E2eNegotiation.Decision.Encrypted).modeOn)
            assertEquals(2, relay.connections)
        } finally {
            relay.stop(2000)
        }
    }
}
