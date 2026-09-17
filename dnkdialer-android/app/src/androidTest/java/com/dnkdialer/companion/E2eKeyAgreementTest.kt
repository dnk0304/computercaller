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

    /** The software path's prefs file (E2eKeyAgreement.SoftwareDeviceKey.PREFS). */
    private val SW_PREFS = "computercaller_e2e_swkey"

    /** A scratch record used ONLY by the negative control; deleted in its finally. */
    private val NEG_CONTROL_PREFS = "computercaller_e2e_swkey_negctl"

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

    /**
     * The security property, proven by ASKING THE QUESTION AN ATTACKER ASKS:
     * given everything the app wrote to disk under `shared_prefs`, can the
     * software-path private key be recovered from it?
     *
     * WHY THIS IS NOT THE ASSERTION IT USED TO BE (the P5b(a) fix). The previous
     * version asserted `blob[0] != 0x30` - "ciphertext must not start with the
     * DER SEQUENCE tag". The wrapped blob is AES-256-GCM output, i.e. uniformly
     * random bytes, so that assertion failed with probability 1/256 on a
     * perfectly sealed key and for no other reason. It did exactly that once on
     * the P4 lane ("stored blob looks like plaintext DER. Actual: 48"). The
     * flake was in the TEST, not the product: a security property was being
     * checked through a probabilistic proxy. [E2eKeyAgreement]'s software path
     * is unchanged by this fix.
     *
     * The replacement has no probabilistic branch. It slides a 32-byte window
     * over every byte the app persisted - the raw prefs XML AND the decoded
     * value of every string it stores - treats each window as a candidate P-256
     * scalar, and performs a real ECDH with it against a probe public key. If
     * any window reproduces the secret the PRODUCT produces for that same probe,
     * the private key is recoverable from disk and the test fails. Recovering
     * the key from bytes that do not contain it would mean guessing a 256-bit
     * scalar, so a pass is deterministic, not lucky.
     *
     * [a_deliberately_readable_key_makes_the_scan_FAIL] is the control: it runs
     * this same helper over a record that stores the key in the clear and
     * asserts the helper raises. Without it, a scan that silently examined
     * nothing would pass forever.
     */
    @Test
    fun software_wrapped_private_key_is_not_readable_from_the_prefs_file() {
        E2eKeyAgreement.softwarePathRotate(ctx)
        val swPub = E2eKeyAgreement.softwarePathPublicSec1(ctx)
        val prefs = ctx.getSharedPreferences(SW_PREFS, Context.MODE_PRIVATE)

        val wrapped = prefs.getString("priv_wrapped_b64", null)
        assertTrue("the wrapped private key must be stored", wrapped != null)

        // The stored blob must not be loadable as a key. Catching Throwable, not
        // GeneralSecurityException: which exception a DER decoder throws on
        // random input is a provider detail, and a narrow catch would turn a
        // correctly-sealed key into a test ERROR on some future provider.
        val blob = E2eKeyEncoding.fromBase64Url(wrapped!!)
        try {
            java.security.KeyFactory.getInstance("EC")
                .generatePrivate(java.security.spec.PKCS8EncodedKeySpec(blob))
            fail("the stored blob loaded as a private key - it is not sealed")
        } catch (e: Throwable) {
            assertTrue(e.toString().isNotEmpty())
        }
        assertTrue(
            "the public point must not appear in the sealed blob",
            indexOf(blob, swPub.copyOfRange(1, 17)) < 0
        )

        // The real question. The probe is an ephemeral whose public half we own,
        // so the target secret is one the product computes with the very key we
        // are claiming is unreadable.
        E2eKeyAgreement.mintEphemeral().use { probe ->
            val target = E2eKeyAgreement.softwarePathAgree(ctx, probe.publicSec1)
            assertEquals(32, target.size)
            assertPrivateKeyNotRecoverable(SW_PREFS, probe.publicSec1, target)
        }
    }

    /**
     * NEGATIVE CONTROL for the scan above. Writes a prefs record that stores an
     * EC private key the way a careless implementation would - the PKCS#8 and
     * the bare scalar, base64 like everything else - and requires
     * [assertPrivateKeyNotRecoverable] to FAIL on it.
     *
     * A green [software_wrapped_private_key_is_not_readable_from_the_prefs_file]
     * means nothing unless this one is also green: together they say the scan
     * fires when the key is readable and stays quiet when it is not.
     */
    @Test
    fun a_deliberately_readable_key_makes_the_scan_FAIL() {
        val gen = java.security.KeyPairGenerator.getInstance("EC")
        gen.initialize(java.security.spec.ECGenParameterSpec("secp256r1"))
        val kp = gen.generateKeyPair()
        val scalar = (kp.private as java.security.interfaces.ECPrivateKey).s
        val scalarBytes = ByteArray(32).also { out ->
            val raw = scalar.toByteArray()
            val src = if (raw.size > 32) raw.copyOfRange(raw.size - 32, raw.size) else raw
            System.arraycopy(src, 0, out, 32 - src.size, src.size)
        }

        val p = ctx.getSharedPreferences(NEG_CONTROL_PREFS, Context.MODE_PRIVATE)
        try {
            p.edit()
                .putInt("v", 1)
                // Base64, not raw bytes: a plaintext leak in a prefs file looks
                // exactly like a sealed one to the naked eye, which is why the
                // scan decodes every stored string instead of only reading the
                // XML.
                .putString("priv_wrapped_b64", E2eKeyEncoding.toBase64Url(kp.private.encoded))
                .putString("priv_scalar_b64", E2eKeyEncoding.toBase64Url(scalarBytes))
                .putString(
                    "pub_sec1_b64",
                    E2eKeyEncoding.toBase64Url(E2eKeyEncoding.toSec1(kp.public))
                )
                .commit()

            E2eKeyAgreement.mintEphemeral().use { probe ->
                val ka = javax.crypto.KeyAgreement.getInstance("ECDH")
                ka.init(kp.private)
                ka.doPhase(E2eKeyEncoding.fromSec1(probe.publicSec1), true)
                val target = ka.generateSecret()

                try {
                    assertPrivateKeyNotRecoverable(NEG_CONTROL_PREFS, probe.publicSec1, target)
                    fail(
                        "CONTROL FAILED: the scan did not notice a private key stored in the " +
                            "clear, so a pass of the positive test proves nothing"
                    )
                } catch (expected: AssertionError) {
                    assertTrue(
                        "the control must fail for the right reason: ${expected.message}",
                        expected.message!!.contains("RECOVERABLE")
                    )
                }
            }
        } finally {
            p.edit().clear().commit()
            java.io.File(prefsFile(NEG_CONTROL_PREFS)).delete()
        }
    }

    // ------------------------------------------ the scan, shared by both tests

    private fun prefsFile(name: String): String =
        java.io.File(java.io.File(ctx.applicationContext.dataDir, "shared_prefs"), "$name.xml").path

    /**
     * Fails iff the P-256 private key behind [target] can be reconstructed from
     * anything the app persisted under [prefsName].
     *
     * Vacuity guards, because an empty scan is the failure mode that would make
     * this whole file decorative: the XML must exist and be non-empty on disk,
     * and the scan must actually have tried at least one candidate scalar.
     */
    private fun assertPrivateKeyNotRecoverable(
        prefsName: String,
        probePub: ByteArray,
        target: ByteArray,
    ) {
        val prefs = ctx.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
        // SharedPreferences.apply() writes to disk asynchronously; a commit() on
        // the same instance blocks until the queued writes have drained, so the
        // file read below is the file the product actually wrote. Without this
        // the scan could read a stale or absent XML and pass vacuously.
        prefs.edit().putLong("zz_test_disk_flush", System.nanoTime()).commit()

        val file = java.io.File(prefsFile(prefsName))
        assertTrue("prefs XML not on disk at ${file.path} - the scan would be vacuous", file.isFile)
        val fileBytes = file.readBytes()
        assertTrue("prefs XML is empty - the scan would be vacuous", fileBytes.size > 32)

        val sources = LinkedHashMap<String, ByteArray>()
        sources["prefs-xml"] = fileBytes
        for ((k, v) in prefs.all) {
            if (v !is String) continue
            try {
                sources["b64($k)"] = E2eKeyEncoding.fromBase64Url(v)
            } catch (ignored: Throwable) {
                // not base64 - the raw XML source already covers its bytes
            }
        }

        val params = E2eKeyEncoding.p256Params()
        val kf = java.security.KeyFactory.getInstance("EC")
        val probeKey = E2eKeyEncoding.fromSec1(probePub)
        var tried = 0
        for ((label, bytes) in sources) {
            if (bytes.size < 32) continue
            for (i in 0..bytes.size - 32) {
                val s = java.math.BigInteger(1, bytes.copyOfRange(i, i + 32))
                if (s.signum() <= 0 || s >= params.order) continue
                val secret = try {
                    tried++
                    val priv = kf.generatePrivate(java.security.spec.ECPrivateKeySpec(s, params))
                    javax.crypto.KeyAgreement.getInstance("ECDH").let {
                        it.init(priv)
                        it.doPhase(probeKey, true)
                        it.generateSecret()
                    }
                } catch (ignored: Throwable) {
                    continue
                }
                if (secret.contentEquals(target)) {
                    fail(
                        "PRIVATE KEY RECOVERABLE from $prefsName: the scalar at byte $i of " +
                            "$label reproduces the product's own ECDH output"
                    )
                }
            }
        }
        // Not `tried > 0`: a single candidate would satisfy that while covering
        // none of the record. The smallest thing worth calling a scan is the
        // whole XML minus a 32-byte window, and the XML is always longer than
        // the base64 of a 65-byte public key.
        val floor = fileBytes.size - 32
        assertTrue(
            "the scan examined $tried candidate scalars in $prefsName across " +
                "${sources.size} sources, below the floor of $floor - it proved nothing",
            tried >= floor
        )
        android.util.Log.i(
            "E2E-FACT",
            "keyscan prefs=$prefsName sources=" +
                sources.entries.joinToString(",") { "${it.key}:${it.value.size}B" } +
                " candidateScalars=$tried floor=$floor"
        )
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
