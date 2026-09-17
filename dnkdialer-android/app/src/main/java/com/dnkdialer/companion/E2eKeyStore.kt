package com.dnkdialer.companion

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PublicKey
import java.security.spec.ECGenParameterSpec

/**
 * E2E programme, phase P4 Part 1 (SCAFFOLD). The app's first AndroidKeyStore
 * usage — before this there was none; [TokenStore] only ever reached the
 * Keystore indirectly, through androidx.security.crypto's MasterKey.
 *
 * THIS FILE DOES NO CRYPTOGRAPHY. It generates and holds a long-lived device
 * key pair and hands out its public bytes. There is deliberately no ECDH, no
 * HKDF, no AES-GCM, no SAS and no sealing here — those land in Part 2, after
 * the Gate 1 design freeze fixes the byte layouts. The one thing Part 1 must
 * get right is that the key it generates is the key Part 2 can actually use,
 * which is why the key is created with PURPOSE_AGREE_KEY rather than a
 * signing purpose: a Keystore key's purposes are immutable after generation,
 * so a "placeholder" signing key would have to be thrown away and the user's
 * pairing re-verified.
 *
 * ## Alias scheme (RESUME-PROTOCOL v2 rule 6 — versioned stored records)
 *
 *     cc-e2e-dev-v<ALIAS_VERSION>-<curve>        e.g. cc-e2e-dev-v1-p256
 *
 * The `v` tag is the stored-record version. [assertNoUnknownVersions] fails
 * LOUDLY on any `cc-e2e-dev-v<n>-*` alias whose n is not [ALIAS_VERSION] —
 * a resumer or a downgraded build must never silently "work on my machine"
 * against a record it does not understand.
 *
 * The alias also carries the CURVE NAME. X25519-vs-P-256 is decided at
 * Gate 1 (E2E-PLAN decision e), and the curve is baked into a Keystore key
 * at generation. Keying the alias on the curve lets both coexist during the
 * switch instead of forcing a destructive migration: the loser's alias is
 * simply never generated, and [clearAll] removes whatever is present.
 *
 * ## What the platform actually allows (measured, not assumed — see the
 * (s3) commit message for the emulator run)
 *
 *  - AndroidKeyStore supports the NIST curves only. **X25519 cannot be held
 *    in AndroidKeyStore at all** on any current Android release. If Gate 1
 *    picks X25519 for the web/extension side, the Android side either picks
 *    P-256 (mixed-curve negotiation) or holds a SOFTWARE X25519 key that is
 *    not hardware-backed. [curveSupport] reports this rather than guessing.
 *  - `PURPOSE_AGREE_KEY` — the purpose an ECDH key needs — is API 31+.
 *    minSdk here is 26, so on API 26–30 there is NO Keystore-backed key
 *    agreement available. [capability] returns [E2eKeyBackend.UNSUPPORTED]
 *    with a reason on those devices; it does not silently fall back to a
 *    software key, because whether to do that is a Gate 1 decision and not
 *    one this scaffold may make quietly.
 *  - `setIsStrongBoxBacked` is API 28+, and StrongBox is only present when
 *    the device declares FEATURE_STRONGBOX_KEYSTORE. StrongBox is attempted
 *    when declared and falls back to TEE on StrongBoxUnavailableException,
 *    which some OEM builds throw despite declaring the feature.
 *
 * `setUserAuthenticationRequired(false)` throughout, per the brief: the key
 * must be usable while the screen is locked, because the phone relays calls
 * and messages in the background with no user present.
 */
object E2eKeyStore {

    private const val TAG = "E2eKeyStore"

    private const val PROVIDER = "AndroidKeyStore"

    /** Stored-record version for the alias scheme. Bump on ANY change to what
     *  the key is or how it is generated; add a migration at the same time. */
    const val ALIAS_VERSION = 1

    private const val ALIAS_PREFIX = "cc-e2e-dev-v"

    /** Matches any generation's alias, so the unknown-version guard can see
     *  records written by a build newer than this one. */
    private val ANY_VERSION_ALIAS = Regex("""^cc-e2e-dev-v(\d+)-([a-z0-9]+)$""")

    private const val API_AGREE_KEY = Build.VERSION_CODES.S          // 31
    private const val API_STRONGBOX = Build.VERSION_CODES.P          // 28

    /** Curves this scaffold knows how to name. Which one ships is Gate 1's
     *  call; [curveSupport] says which are actually generatable here. */
    enum class Curve(val wireName: String, val aliasTag: String, val stdName: String?) {
        /** NIST P-256 / secp256r1 — the only curve AndroidKeyStore can hold. */
        P256("P-256", "p256", "secp256r1"),

        /** Curve25519 ECDH. Not an AndroidKeyStore curve; software only. */
        X25519("X25519", "x25519", null),
    }

    enum class E2eKeyBackend {
        /** Hardware-isolated secure element. */
        ANDROID_KEYSTORE_STRONGBOX,

        /** TEE / KeyMint, the normal hardware-backed case. */
        ANDROID_KEYSTORE_TEE,

        /** No Keystore key-agreement key is possible; see [Capability.reason]. */
        UNSUPPORTED,
    }

    /**
     * What this device can actually do. Callers MUST branch on
     * [backend] == [E2eKeyBackend.UNSUPPORTED] and keep encrypted mode
     * unavailable rather than assuming a key exists.
     */
    data class Capability(
        val backend: E2eKeyBackend,
        val curve: Curve?,
        val apiLevel: Int,
        val strongBoxDeclared: Boolean,
        val reason: String,
    ) {
        val isSupported: Boolean get() = backend != E2eKeyBackend.UNSUPPORTED
    }

    /** Thrown when this device cannot hold an E2E device key at all. */
    class E2eKeyUnsupportedException(message: String) : RuntimeException(message)

    /**
     * Thrown when the Keystore holds an alias from a DIFFERENT generation of
     * the alias scheme. Fails loudly by design (RESUME-PROTOCOL rule 6):
     * never guess at a record this build does not understand.
     */
    class E2eKeyVersionException(val foundAlias: String, val foundVersion: Int) :
        RuntimeException(
            "E2E key alias '$foundAlias' is scheme v$foundVersion but this build " +
                "understands only v$ALIAS_VERSION. Refusing to touch it — a migration " +
                "is required (see E2eKeyStore.ALIAS_VERSION)."
        )

    /** Thrown when key generation or Keystore access fails outright. */
    class E2eKeyUnavailableException(message: String, cause: Throwable?) :
        RuntimeException(message, cause)

    // ---------------------------------------------------------------- alias

    fun aliasFor(curve: Curve): String = "$ALIAS_PREFIX$ALIAS_VERSION-${curve.aliasTag}"

    // ----------------------------------------------------------- capability

    /**
     * Which curves can be generated in AndroidKeyStore on this device. Pure
     * platform fact, no key is created. Gate 1 input.
     */
    fun curveSupport(): Map<Curve, Boolean> = mapOf(
        Curve.P256 to (Build.VERSION.SDK_INT >= API_AGREE_KEY),
        // AndroidKeyStore has never accepted an XDH/X25519 key. Not a version
        // check — there is no Android release where this is true.
        Curve.X25519 to false,
    )

    /**
     * Report what this device supports. Never throws; call it before
     * [publicKeyBytes] and surface [Capability.reason] in the UI.
     */
    fun capability(ctx: Context, curve: Curve = Curve.P256): Capability {
        val api = Build.VERSION.SDK_INT
        val strongBoxDeclared = Build.VERSION.SDK_INT >= API_STRONGBOX &&
            ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

        if (curve.stdName == null) {
            return Capability(
                E2eKeyBackend.UNSUPPORTED, curve, api, strongBoxDeclared,
                "${curve.wireName} cannot be held in AndroidKeyStore on any Android " +
                    "release; only the NIST curves are supported."
            )
        }
        if (api < API_AGREE_KEY) {
            return Capability(
                E2eKeyBackend.UNSUPPORTED, curve, api, strongBoxDeclared,
                "KeyProperties.PURPOSE_AGREE_KEY requires API $API_AGREE_KEY; this " +
                    "device is API $api. No Keystore-backed key agreement is possible."
            )
        }
        val backend = if (strongBoxDeclared) {
            E2eKeyBackend.ANDROID_KEYSTORE_STRONGBOX
        } else {
            E2eKeyBackend.ANDROID_KEYSTORE_TEE
        }
        return Capability(
            backend, curve, api, strongBoxDeclared,
            "OK — ${curve.wireName} in $PROVIDER (${backend.name})"
        )
    }

    // --------------------------------------------------------- public bytes

    /**
     * The device key's public bytes, generating the key on first use.
     *
     * Encoding is X.509 SubjectPublicKeyInfo (`PublicKey.getEncoded()`). The
     * ON-WIRE encoding of a public key is frozen at Gate 1 (the SAS ikm
     * layout length-prefixes each static pubkey), so Part 2 may wrap or
     * re-encode this; Part 1 deliberately does not invent a wire format.
     *
     * @throws E2eKeyUnsupportedException  device cannot hold such a key
     * @throws E2eKeyVersionException      a foreign-version alias is present
     * @throws E2eKeyUnavailableException  Keystore access / generation failed
     */
    fun publicKeyBytes(ctx: Context, curve: Curve = Curve.P256): ByteArray =
        ensureKey(ctx, curve).encoded

    /**
     * Delete the device key and generate a fresh one, returning the NEW
     * public bytes. Called on Reset / sign-out (wired in Part 2).
     *
     * A rotation invalidates every pairing that pinned the old key: peers
     * must re-verify via SAS. That is the point — it is the user's "this
     * device is compromised" escape hatch — so it is never called implicitly.
     */
    fun rotate(ctx: Context, curve: Curve = Curve.P256): ByteArray {
        val alias = aliasFor(curve)
        val ks = openKeyStore()
        assertNoUnknownVersions(ks)
        if (ks.containsAlias(alias)) {
            try {
                ks.deleteEntry(alias)
            } catch (e: java.security.KeyStoreException) {
                throw E2eKeyUnavailableException("failed to delete $alias during rotate", e)
            }
        }
        if (BuildConfig.DEBUG) Log.d(TAG, "rotate(): regenerating $alias")
        return generate(ctx, curve).encoded
    }

    /**
     * Remove EVERY E2E device key this app has ever written, including
     * foreign-version aliases. The only method that is allowed to touch an
     * unknown version — "delete it all" is safe in a way that "use it" is not.
     */
    fun clearAll() {
        val ks = openKeyStore()
        val doomed = ks.aliases().toList().filter { ANY_VERSION_ALIAS.matches(it) }
        for (alias in doomed) {
            try {
                ks.deleteEntry(alias)
            } catch (e: java.security.KeyStoreException) {
                Log.w(TAG, "clearAll(): could not delete an alias", e)
            }
        }
        if (BuildConfig.DEBUG) Log.d(TAG, "clearAll(): removed ${doomed.size} alias(es)")
    }

    /** True when the key already exists — no generation side effect. */
    fun hasKey(curve: Curve = Curve.P256): Boolean =
        try {
            openKeyStore().containsAlias(aliasFor(curve))
        } catch (e: E2eKeyUnavailableException) {
            Log.w(TAG, "hasKey(): Keystore unavailable", e)
            false
        }

    // -------------------------------------------------------------- internal

    private fun openKeyStore(): KeyStore =
        try {
            KeyStore.getInstance(PROVIDER).apply { load(null) }
        } catch (e: java.security.GeneralSecurityException) {
            throw E2eKeyUnavailableException("cannot open $PROVIDER", e)
        } catch (e: java.io.IOException) {
            throw E2eKeyUnavailableException("cannot open $PROVIDER", e)
        }

    /**
     * RESUME-PROTOCOL rule 6 guard. Any `cc-e2e-dev-v<n>-*` alias whose n is
     * not [ALIAS_VERSION] aborts the operation with a named exception instead
     * of being ignored — an ignored foreign record is exactly how a resumer
     * ends up "working on my machine" against a stale key.
     */
    private fun assertNoUnknownVersions(ks: KeyStore) {
        for (alias in ks.aliases()) {
            val m = ANY_VERSION_ALIAS.matchEntire(alias) ?: continue
            val version = m.groupValues[1].toIntOrNull() ?: continue
            if (version != ALIAS_VERSION) throw E2eKeyVersionException(alias, version)
        }
    }

    private fun ensureKey(ctx: Context, curve: Curve): PublicKey {
        val ks = openKeyStore()
        assertNoUnknownVersions(ks)
        val alias = aliasFor(curve)
        val existing = ks.getCertificate(alias)?.publicKey
        if (existing != null) return existing
        return generate(ctx, curve)
    }

    private fun generate(ctx: Context, curve: Curve): PublicKey {
        val cap = capability(ctx, curve)
        if (!cap.isSupported) throw E2eKeyUnsupportedException(cap.reason)
        val stdName = curve.stdName
            ?: throw E2eKeyUnsupportedException("no AndroidKeyStore name for ${curve.wireName}")
        val alias = aliasFor(curve)

        // [capability] already guarantees SDK_INT >= API_AGREE_KEY here, but
        // lint cannot see through the enum, and a redundant explicit guard is
        // better than a @SuppressLint: it is what makes every PURPOSE_AGREE_KEY
        // / setIsStrongBoxBacked use below provably in-range (both are <= 31).
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            throw E2eKeyUnsupportedException(cap.reason)
        }

        // StrongBox first when declared; some OEM builds declare the feature
        // and still throw StrongBoxUnavailableException for a given spec, so
        // the TEE retry is mandatory rather than defensive.
        if (cap.backend == E2eKeyBackend.ANDROID_KEYSTORE_STRONGBOX) {
            try {
                return generateWith(alias, stdName, strongBox = true)
            } catch (e: android.security.keystore.StrongBoxUnavailableException) {
                Log.w(TAG, "StrongBox declared but unavailable for this spec; using TEE", e)
            }
        }
        return try {
            generateWith(alias, stdName, strongBox = false)
        } catch (e: java.security.GeneralSecurityException) {
            throw E2eKeyUnavailableException("E2E device key generation failed for $alias", e)
        }
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.S)
    private fun generateWith(alias: String, stdName: String, strongBox: Boolean): PublicKey {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_AGREE_KEY)
            .setAlgorithmParameterSpec(ECGenParameterSpec(stdName))
            // The phone relays calls and messages with the screen locked and
            // nobody present, so the key must never require user auth.
            .setUserAuthenticationRequired(false)
            .apply { if (strongBox) setIsStrongBoxBacked(true) }
            .build()

        val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, PROVIDER)
        gen.initialize(spec)
        val pub = gen.generateKeyPair().public
        if (BuildConfig.DEBUG) {
            Log.d(TAG, "generated $alias curve=$stdName strongBox=$strongBox")
        }
        return pub
    }
}
