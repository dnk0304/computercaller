package com.dnkdialer.companion

import android.content.Context
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * E2E P4 Part 2 (a2) — instrumented proof that P-256 ECDH actually works on a
 * real Android runtime, on BOTH paths.
 *
 * A JVM unit test cannot prove any of this: `AndroidKeyStore` does not exist on
 * the unit-test classpath, and the whole question the Gate 1 ruling turns on —
 * whether a Keystore-confined private key can do key agreement at all — is a
 * device fact.
 *
 * The load-bearing assertion in this file is [ecdh_is_symmetric]. Everything
 * else can pass while the two sides derive different secrets; that one cannot.
 */
@RunWith(AndroidJUnit4::class)
class E2eKeyAgreementTest {

    private val ctx: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private fun pairContext() = E2eKdf.PairContext(
        pairingId = "pair-instrumented",
        userId = "user-t",
        phoneDeviceId = "phone-t",
        peerDeviceId = "web-t",
        pairEpoch = 3L,
    )

    // ------------------------------------------------------ platform facts

    @Test
    fun backend_matches_the_api_level_rule() {
        val api = Build.VERSION.SDK_INT
        val expected = if (api >= 31) {
            E2eKeyAgreement.Backend.ANDROID_KEYSTORE
        } else {
            E2eKeyAgreement.Backend.SOFTWARE_WRAPPED
        }
        assertEquals("API $api must select $expected", expected, E2eKeyAgreement.backend())
        // Recorded in the gate JSON / commit message as the measured Keystore
        // fact. Log.i, not println: `am instrument` discards a passing test's
        // stdout entirely, so a println here is invisible on exactly the runs
        // whose facts we want to record. logcat is the only channel that
        // survives a green run.
        val cap = E2eKeyStore.capability(ctx)
        android.util.Log.i(
            "E2E-FACT",
            "api=$api backend=${E2eKeyAgreement.backend()} " +
                "strongBoxDeclared=${cap.strongBoxDeclared} " +
                "keystoreBackend=${cap.backend} reason=${cap.reason}"
        )
    }

    @Test
    fun device_public_key_is_a_valid_65_byte_sec1_point_and_is_stable() {
        val a = E2eKeyAgreement.devicePublicSec1(ctx)
        assertEquals("wire key is uncompressed SEC1", 65, a.size)
        assertEquals(0x04.toByte(), a[0])
        E2eKeyEncoding.validate(a) // throws if off-curve
        val b = E2eKeyAgreement.devicePublicSec1(ctx)
        assertArrayEquals("generate-on-first-use must not regenerate per call", a, b)
    }

    // --------------------------------------------------------- the real ECDH

    /**
     * The one assertion that cannot pass by accident: the phone's static key
     * agreeing with an ephemeral, and that ephemeral agreeing with the phone's
     * static key, must produce the SAME 32 bytes.
     *
     * If the wire encoding is wrong, if the curve is wrong, or if the Keystore
     * provider is silently doing something else, these two byte strings differ
     * — which is exactly the failure that would otherwise surface months later
     * as "the SAS digits never match".
     */
    @Test
    fun ecdh_is_symmetric() {
        val devicePub = E2eKeyAgreement.devicePublicSec1(ctx)
        E2eKeyAgreement.mintEphemeral().use { eph ->
            val fromEphemeral = eph.agreeWith(devicePub)
            val fromDevice = E2eKeyAgreement.agreeWithDeviceKey(ctx, eph.publicSec1)
            assertEquals("P-256 ECDH output size", 32, fromDevice.size)
            assertArrayEquals(
                "the two sides of one ECDH must agree byte for byte",
                fromEphemeral,
                fromDevice
            )
            // Negative control: a DIFFERENT ephemeral must not reproduce it.
            E2eKeyAgreement.mintEphemeral().use { other ->
                assertNotEquals(
                    "control — an unrelated ephemeral must give a different secret",
                    E2eKdf.toHex(fromDevice),
                    E2eKdf.toHex(other.agreeWith(devicePub))
                )
            }
        }
    }

    @Test
    fun both_sides_derive_the_same_kek() {
        val c = pairContext()
        val devicePub = E2eKeyAgreement.devicePublicSec1(ctx)
        E2eKeyAgreement.mintEphemeral().use { eph ->
            val sender = E2eKdf.deriveKek(eph.agreeWith(devicePub), c, devicePub)
            val recipient = E2eKdf.deriveKek(
                E2eKeyAgreement.agreeWithDeviceKey(ctx, eph.publicSec1), c, devicePub
            )
            assertArrayEquals("the wrap must open on the recipient side", sender, recipient)
            assertEquals(32, sender.size)
        }
    }

    @Test
    fun ephemeral_is_unusable_after_close() {
        val devicePub = E2eKeyAgreement.devicePublicSec1(ctx)
        val eph = E2eKeyAgreement.mintEphemeral()
        eph.agreeWith(devicePub) // control: works before close
        eph.close()
        try {
            eph.agreeWith(devicePub)
            fail("a closed ephemeral still performed ECDH")
        } catch (e: E2eKeyAgreement.AgreementException) {
            assertTrue(e.message!!.contains("closed"))
        }
    }

    // ------------------------------------------------------ hostile inputs

    /**
     * An invalid peer point must be rejected BEFORE it reaches `KeyAgreement`.
     * This is the invalid-curve attack: feed a point on a weaker curve and read
     * the private scalar out of the resulting secrets, one agreement at a time.
     */
    @Test
    fun hostile_peer_points_are_refused_before_ecdh() {
        val good = E2eKeyAgreement.devicePublicSec1(ctx)

        val identity = ByteArray(65).also { it[0] = 0x04 }
        val offCurve = good.copyOf().also { it[40] = (it[40].toInt() xor 0x01).toByte() }
        val compressed = good.copyOf(33).also { it[0] = 0x02 }
        val spkiShaped = ByteArray(91) { 0x04 }
        val empty = ByteArray(0)

        for ((label, bad) in listOf(
            "identity" to identity,
            "off-curve" to offCurve,
            "compressed" to compressed,
            "x509-length" to spkiShaped,
            "empty" to empty,
        )) {
            try {
                E2eKeyAgreement.agreeWithDeviceKey(ctx, bad)
                fail("ECDH accepted a $label peer point")
            } catch (e: E2eKeyEncoding.InvalidPublicKeyException) {
                assertTrue("$label: ${e.message}", e.message!!.isNotEmpty())
            }
            E2eKeyAgreement.mintEphemeral().use { eph ->
                try {
                    eph.agreeWith(bad)
                    fail("the ephemeral path accepted a $label peer point")
                } catch (e: E2eKeyEncoding.InvalidPublicKeyException) {
                    assertTrue(e.message!!.isNotEmpty())
                }
            }
        }
        // Control: the unmodified key still works, so the test is not passing
        // because agreement is broken for everything.
        E2eKeyAgreement.mintEphemeral().use { assertEquals(32, it.agreeWith(good).size) }
    }

    // --------------------------------------------- the API 26-30 fallback

    /**
     * Drives the software-wrapped path explicitly. On this emulator [backend]
     * selects the Keystore path, so without this test the code that runs on
     * every API 26–30 phone would never execute at all.
     *
     * Note what is proven here and what is not: the wrapped-at-rest store, the
     * generate-once behaviour, the ECDH itself and rotation are all proven on
     * any API level. That `PURPOSE_AGREE_KEY` is unavailable below 31 — the
     * reason this path exists — can only be shown on a real API 26 image.
     */
    @Test
    fun software_wrapped_path_performs_a_symmetric_ecdh() {
        E2eKeyAgreement.softwarePathRotate(ctx) // start from a known state
        val swPub = E2eKeyAgreement.softwarePathPublicSec1(ctx)
        assertEquals(65, swPub.size)
        E2eKeyEncoding.validate(swPub)
        assertArrayEquals(
            "the software key must be generated once, not per call",
            swPub,
            E2eKeyAgreement.softwarePathPublicSec1(ctx)
        )

        E2eKeyAgreement.mintEphemeral().use { eph ->
            assertArrayEquals(
                "software-path ECDH must be symmetric",
                eph.agreeWith(swPub),
                E2eKeyAgreement.softwarePathAgree(ctx, eph.publicSec1)
            )
        }
    }

    @Test
    fun software_wrapped_private_key_is_not_readable_from_the_prefs_file() {
        E2eKeyAgreement.softwarePathRotate(ctx)
        val swPub = E2eKeyAgreement.softwarePathPublicSec1(ctx)
        val prefs = ctx.getSharedPreferences("computercaller_e2e_swkey", Context.MODE_PRIVATE)

        val wrapped = prefs.getString("priv_wrapped_b64", null)
        assertTrue("the wrapped private key must be stored", wrapped != null)

        // The stored blob must be ciphertext, not a PKCS#8 key: a PKCS#8 EC key
        // opens with the DER SEQUENCE tag 0x30, and it embeds the public point.
        val blob = E2eKeyEncoding.fromBase64Url(wrapped!!)
        assertNotEquals("stored blob looks like plaintext DER", 0x30.toByte(), blob[0])
        assertTrue(
            "the public point must not appear in the sealed blob",
            indexOf(blob, swPub.copyOfRange(1, 17)) < 0
        )
        // And it must not be loadable as a key.
        try {
            java.security.KeyFactory.getInstance("EC")
                .generatePrivate(java.security.spec.PKCS8EncodedKeySpec(blob))
            fail("the stored blob loaded as a private key — it is not sealed")
        } catch (e: java.security.GeneralSecurityException) {
            assertTrue(e.toString().isNotEmpty())
        }
    }

    @Test
    fun software_path_rotation_changes_the_key() {
        E2eKeyAgreement.softwarePathRotate(ctx)
        val before = E2eKeyAgreement.softwarePathPublicSec1(ctx)
        E2eKeyAgreement.softwarePathRotate(ctx)
        val after = E2eKeyAgreement.softwarePathPublicSec1(ctx)
        assertNotEquals(
            "rotate() must mint a new key",
            E2eKdf.toHex(before),
            E2eKdf.toHex(after)
        )
        E2eKeyEncoding.validate(after)
    }

    // ------------------------------------------------------------ rotation

    /**
     * Rotation on the live backend. Ordered last by name convention and
     * deliberately destructive: it invalidates the key the earlier tests used,
     * which is the point — a rotate() that left the old key usable would make
     * the "this device is compromised" escape hatch a no-op.
     */
    @Test
    fun zz_device_key_rotation_invalidates_the_old_secret() {
        val oldPub = E2eKeyAgreement.devicePublicSec1(ctx)
        E2eKeyAgreement.mintEphemeral().use { eph ->
            val oldSecret = E2eKdf.toHex(E2eKeyAgreement.agreeWithDeviceKey(ctx, eph.publicSec1))

            E2eKeyAgreement.rotateDeviceKey(ctx)

            val newPub = E2eKeyAgreement.devicePublicSec1(ctx)
            assertNotEquals("rotate() must change the public key",
                E2eKdf.toHex(oldPub), E2eKdf.toHex(newPub))
            assertNotEquals(
                "the old shared secret must not be reproducible after rotation",
                oldSecret,
                E2eKdf.toHex(E2eKeyAgreement.agreeWithDeviceKey(ctx, eph.publicSec1))
            )
            E2eKeyEncoding.validate(newPub)
        }
    }

    private fun indexOf(haystack: ByteArray, needle: ByteArray): Int {
        outer@ for (i in 0..haystack.size - needle.size) {
            for (j in needle.indices) if (haystack[i + j] != needle[j]) continue@outer
            return i
        }
        return -1
    }
}
