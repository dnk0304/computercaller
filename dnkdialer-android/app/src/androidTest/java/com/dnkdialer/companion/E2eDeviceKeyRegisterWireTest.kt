package com.dnkdialer.companion

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * P6.1c 1a — what [E2eDeviceKeyClient.register] actually puts on the wire.
 *
 * The client's class doc reasons at length about two HTTP facts: that the
 * phone authenticates with `Authorization: Bearer` and that it deliberately
 * sends **no** `Origin` header (`register/route.ts` applies `requireSameOrigin`
 * only when the caller came in via a session cookie, so a speculative Origin
 * would be cargo cult and a required one would lock the phone out). Until this
 * commit nothing checked either claim, and the brief asks for exactly that.
 *
 * Instrumented rather than unit, because it is a claim about
 * `HttpURLConnection` on Android — the JVM stub would prove nothing about the
 * headers the platform adds on a real device.
 *
 * A twelve-line `ServerSocket` rather than a mock web server: no new
 * dependency, and it records the literal request line and headers, which is
 * the whole point.
 */
@RunWith(AndroidJUnit4::class)
class E2eDeviceKeyRegisterWireTest {

    private lateinit var server: ServerSocket
    private lateinit var thread: Thread

    /** Every header line of every request the client made, verbatim. */
    private val headers: MutableList<String> = Collections.synchronizedList(ArrayList())
    private val bodies: MutableList<String> = Collections.synchronizedList(ArrayList())

    /** What the next request is answered with. */
    @Volatile private var status = "200 OK"
    @Volatile private var payload = "{}"
    private val served = CountDownLatch(1)

    @Before
    fun start() {
        server = ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"))
        thread = Thread {
            try {
                server.accept().use { serve(it) }
            } catch (e: java.io.IOException) {
                // The socket was closed in @After; nothing to report.
            }
        }.apply { isDaemon = true; start() }
        E2eDeviceKeyClient.baseOverride = "http://127.0.0.1:${server.localPort}/api/devicekeys"
    }

    @After
    fun stop() {
        // Restore production routing no matter how the test ended: a leaked
        // override would silently point a later test at a dead port.
        E2eDeviceKeyClient.baseOverride = null
        runCatching { server.close() }
        thread.interrupt()
    }

    private fun serve(socket: Socket) {
        val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
        var contentLength = 0
        while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
            headers += line
            if (line.startsWith("Content-Length:", ignoreCase = true)) {
                contentLength = line.substringAfter(':').trim().toInt()
            }
        }
        if (contentLength > 0) {
            val buf = CharArray(contentLength)
            var read = 0
            while (read < contentLength) {
                val n = reader.read(buf, read, contentLength - read)
                if (n < 0) break
                read += n
            }
            bodies += String(buf, 0, read)
        }
        val bytes = payload.toByteArray(Charsets.UTF_8)
        socket.getOutputStream().apply {
            write(
                ("HTTP/1.1 $status\r\nContent-Type: application/json\r\n" +
                    "Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n")
                    .toByteArray(Charsets.UTF_8)
            )
            write(bytes)
            flush()
        }
        served.countDown()
    }

    private fun headerNamed(name: String): String? = headers.toList()
        .firstOrNull { it.substringBefore(':').equals(name, ignoreCase = true) }

    @Test
    fun register_sends_a_Bearer_and_no_Origin() {
        status = "200 OK"
        payload = """{"key":{"deviceId":"d1","kind":"phone","publicKey":"AAAA",""" +
            """"label":null,"revokedAt":null},"rotated":false,"userId":"u_wire1"}"""

        val result = E2eDeviceKeyClient.register(
            phoneToken = "tok-abc",
            deviceId = "d1",
            publicKeySec1 = ByteArray(65).also { it[0] = 4 },
            label = "Pixel",
        )

        assertTrue(served.await(10, TimeUnit.SECONDS))
        assertTrue("result was $result", result is E2eDeviceKeyClient.Result.Ok)

        assertTrue(headers.toList().toString(), headers.any { it.startsWith("POST /api/devicekeys/register") })
        assertEquals("Authorization: Bearer tok-abc", headerNamed("Authorization"))

        // THE assertion. The route only CSRF-checks the cookie path; a phone
        // sending an Origin it has no business owning would be cargo cult, and
        // a phone forced to send one could never register at all.
        assertNull("the phone must send no Origin header", headerNamed("Origin"))

        // And the body carries no userId: the route takes the caller from the
        // bearer and ignores a body userId entirely (B8).
        assertTrue(bodies.toList().toString(), bodies.single().contains("\"deviceId\":\"d1\""))
        assertTrue(bodies.single().contains("\"kind\":\"phone\""))
        assertTrue("a body userId would be ignored — do not send one",
            !bodies.single().contains("userId"))

        // R-BH: the account id comes back on the RESPONSE, from the top level,
        // and this is the phone's only channel to it. Parsed off real HTTP
        // rather than a hand-built JSONObject, because "the server says it" is
        // the claim, not "the parser can parse it".
        assertEquals(
            "u_wire1",
            (result as E2eDeviceKeyClient.Result.Ok).value.userId,
        )
    }

    /**
     * R-BH, the fail-closed half: a deployment that does not send the field
     * must read as NULL, never as `""`. An empty account id is the exact value
     * that produced A6-P61B-8 — the phone sealing every wrap under a context
     * the page cannot even represent — so the parser must never manufacture
     * one, and the refusal happens upstream where it can be seen.
     */
    @Test
    fun a_register_response_without_a_userId_parses_as_null_not_empty() {
        status = "200 OK"
        payload = """{"key":{"deviceId":"d1","kind":"phone","publicKey":"AAAA",""" +
            """"label":null,"revokedAt":null},"rotated":false}"""

        val result = E2eDeviceKeyClient.register(
            phoneToken = "tok-abc",
            deviceId = "d1",
            publicKeySec1 = ByteArray(65).also { it[0] = 4 },
        )

        assertTrue(served.await(10, TimeUnit.SECONDS))
        assertTrue("result was $result", result is E2eDeviceKeyClient.Result.Ok)
        assertNull(
            "an absent userId is null, never the empty string",
            (result as E2eDeviceKeyClient.Result.Ok).value.userId,
        )
    }

    @Test
    fun register_409_becomes_PairingInFlight() {
        status = "409 Conflict"
        payload = """{"error":"pairing_in_flight","code":"pairing_in_flight"}"""

        val result = E2eDeviceKeyClient.register(
            phoneToken = "tok-abc",
            deviceId = "d1",
            publicKeySec1 = ByteArray(65).also { it[0] = 4 },
        )

        assertTrue(served.await(10, TimeUnit.SECONDS))
        // Not Unavailable, not Forbidden: P1 refuses a key landing mid-
        // handshake on purpose, and the registrar retries rather than treating
        // it as a failure. Collapsing it into Unavailable would make the phone
        // give up on the one error it is supposed to shrug off.
        assertEquals(E2eDeviceKeyClient.Result.PairingInFlight, result)
    }
}
