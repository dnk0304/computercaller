package com.dnkdialer.companion

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters
import java.io.File

/**
 * Instrumented tests for [E2eKeyStore] (P4 Part 1, (s3)).
 *
 * Two of these are ORDINARY in-process tests. The process-death proof is NOT:
 * a test cannot outlive the process it asserts about, so the survival check is
 * split into two methods that must be invoked in SEPARATE instrumentation runs
 * with an `am force-stop` between them. `tools/run-keystore-test.ps1` drives
 * that; running the class in one go still passes but proves only persistence
 * across a fresh KeyStore load, which is the weaker claim — the driver script
 * is what makes it a real process-death proof.
 *
 * The expected public bytes are written to the app's filesDir, because the
 * whole point is that nothing in memory survives to carry them across.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class E2eKeyStoreTest {

    private val ctx get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val fingerprintFile: File
        get() = File(ctx.filesDir, "e2e-keystore-test-pubkey.bin")

    @Before
    fun requireSupportedDevice() {
        val cap = E2eKeyStore.capability(ctx)
        org.junit.Assume.assumeTrue(
            "device cannot hold an E2E key: ${cap.reason}",
            cap.isSupported
        )
    }

    // ------------------------------------------------ process-death phase 1

    /**
     * Phase 1: generate the key and record its public bytes on disk.
     * Invoke alone, then `am force-stop`, then [phase2_keySurvivesProcessDeath].
     */
    @Test
    fun phase1_generateAndRecordPublicKey() {
        E2eKeyStore.clearAll()
        assertFalse("clearAll() left a key behind", E2eKeyStore.hasKey())

        val pub = E2eKeyStore.publicKeyBytes(ctx)
        assertNotNull(pub)
        assertTrue("public key suspiciously short: ${pub.size} bytes", pub.size > 32)
        assertTrue("hasKey() false right after generation", E2eKeyStore.hasKey())

        fingerprintFile.writeBytes(pub)
    }

    /**
     * Phase 2: in a BRAND NEW process, the same alias must still yield the
     * identical public bytes — i.e. the key lives in the Keystore and not in
     * this app's memory or its SharedPreferences.
     */
    @Test
    fun phase2_keySurvivesProcessDeath() {
        val f = fingerprintFile
        if (!f.exists()) {
            fail(
                "phase 1 has not run: ${f.absolutePath} is missing. This method is " +
                    "only meaningful after phase1 ran in a PREVIOUS process — use " +
                    "tools/run-keystore-test.ps1."
            )
        }
        val expected = f.readBytes()

        assertTrue("key did not survive the process restart", E2eKeyStore.hasKey())
        // No generation should occur here; the bytes must already match.
        assertArrayEquals(
            "public key changed across process death",
            expected,
            E2eKeyStore.publicKeyBytes(ctx)
        )
    }

    // ------------------------------------------------------- in-process tests

    /** [E2eKeyStore.rotate] must delete + regenerate, yielding DIFFERENT bytes. */
    @Test
    fun rotateChangesThePublicBytes() {
        val before = E2eKeyStore.publicKeyBytes(ctx)
        val after = E2eKeyStore.rotate(ctx)

        assertEquals("rotate() changed the key encoding format", before.size, after.size)
        assertFalse(
            "rotate() returned the SAME public key — the old key was not deleted",
            before.contentEquals(after)
        )
        // And the rotated key is the one now stored, not a transient.
        assertArrayEquals(
            "rotate()'s return value is not what the store now holds",
            after,
            E2eKeyStore.publicKeyBytes(ctx)
        )
    }

    /** Generation is idempotent: a second read must not mint a new key. */
    @Test
    fun publicKeyBytesIsStableAcrossCalls() {
        val a = E2eKeyStore.publicKeyBytes(ctx)
        val b = E2eKeyStore.publicKeyBytes(ctx)
        assertArrayEquals("generate-on-first-use ran twice", a, b)
    }

    /** The alias carries both the scheme version and the curve name. */
    @Test
    fun aliasSchemeCarriesVersionAndCurve() {
        assertEquals("cc-e2e-dev-v1-p256", E2eKeyStore.aliasFor(E2eKeyStore.Curve.P256))
        assertEquals("cc-e2e-dev-v1-x25519", E2eKeyStore.aliasFor(E2eKeyStore.Curve.X25519))
        assertEquals(1, E2eKeyStore.ALIAS_VERSION)
    }

    /**
     * X25519 is not an AndroidKeyStore curve on ANY release, so asking for it
     * must fail loudly rather than quietly handing back a P-256 key. This is
     * the fact Gate 1's curve decision (decision e) turns on.
     */
    @Test
    fun x25519IsReportedUnsupportedNotSilentlySubstituted() {
        assertFalse(
            "curveSupport() claims AndroidKeyStore X25519",
            E2eKeyStore.curveSupport()[E2eKeyStore.Curve.X25519] ?: true
        )
        val cap = E2eKeyStore.capability(ctx, E2eKeyStore.Curve.X25519)
        assertFalse(cap.isSupported)
        try {
            E2eKeyStore.publicKeyBytes(ctx, E2eKeyStore.Curve.X25519)
            fail("X25519 key generation should have thrown E2eKeyUnsupportedException")
        } catch (expected: E2eKeyStore.E2eKeyUnsupportedException) {
            assertTrue(
                "exception message should name the curve",
                expected.message!!.contains("X25519")
            )
        }
    }

    /** [E2eKeyStore.clearAll] must leave nothing behind. */
    @Test
    fun zz_clearAllRemovesTheKey() {
        E2eKeyStore.publicKeyBytes(ctx)
        assertTrue(E2eKeyStore.hasKey())
        E2eKeyStore.clearAll()
        assertFalse("clearAll() left the key in the Keystore", E2eKeyStore.hasKey())
        fingerprintFile.delete()
    }
}
