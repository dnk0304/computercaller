package com.dnkdialer.companion

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.PublicKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec

/**
 * E2E programme, phase P4 Part 2 (a1) — the ON-WIRE encoding of a P-256 public
 * key, and the validation every foreign key must survive before it is used.
 *
 * ## Why this file exists at all
 *
 * Part 1's [E2eKeyStore.publicKeyBytes] returned `PublicKey.getEncoded()`,
 * which on every JCE provider is **X.509 SubjectPublicKeyInfo** — a DER
 * structure that wraps the point in an AlgorithmIdentifier. The Gate 1 ruling
 * pins the wire format to something else entirely:
 *
 *     uncompressed SEC1: 0x04 || X (32 bytes, big-endian) || Y (32 bytes)
 *     base64url on the wire
 *
 * The distinction is not cosmetic and it is not catchable by a smoke test. The
 * SAS transcript (E2E-SPEC §13.3) length-prefixes and hashes each static public
 * key *as bytes*. An SPKI-encoded P-256 key is 91 bytes; the same key in SEC1 is
 * 65. Feed the wrong one in and the digits are simply different numbers — the
 * phone shows 12345, the browser shows 67890, and the only symptom is "encrypted
 * mode never pairs". The tempting fix at that point is to weaken the transcript
 * until the digits agree, which is exactly how a verification code becomes
 * decoration. So the conversion lives here, on its own, with a round-trip test
 * in both directions.
 *
 * ## Why validation lives here too
 *
 * A peer's public key arrives over a relay we do not trust. Before it reaches
 * `KeyAgreement`, it must be proven to be a real point of the right group:
 *
 *  - **Prefix.** Only 0x04 (uncompressed) is accepted. Compressed points (0x02 /
 *    0x03) are rejected rather than decompressed — accepting two encodings of
 *    one key would mean two different SAS transcripts for one pairing.
 *  - **Range.** X and Y must each be in [0, p). A coordinate ≥ p is not a field
 *    element; some providers reduce it silently, which turns one key into two
 *    accepted encodings again.
 *  - **On-curve.** y² ≡ x³ + ax + b (mod p). This is the check that stops an
 *    invalid-curve attack, where a peer sends a point on a *different*, weaker
 *    curve and reads bits of our private scalar out of the resulting shared
 *    secret. Android's ECDH does not reliably do this for us.
 *  - **Identity.** The point at infinity is rejected. It has no 65-byte
 *    uncompressed encoding (SEC1 encodes it as the single byte 0x00), so the
 *    length check already excludes it; the explicit all-zero-coordinates check
 *    exists because `0x04 || 0^32 || 0^32` is the shape an attacker actually
 *    sends, and (0,0) is not on P-256 anyway (b ≠ 0) so it also fails on-curve.
 *    Both guards are kept: defence in depth costs two comparisons.
 *  - **Small order.** The Gate 1 ruling requires small-order rejection. On
 *    P-256 the cofactor is **h = 1**: the curve group has prime order n, so
 *    *every* point other than the identity has order exactly n. On-curve plus
 *    not-identity therefore **proves** full-subgroup membership, and an explicit
 *    `[n]Q == O` multiplication would be dead code that only makes the handshake
 *    slower. This is stated rather than assumed because the same sentence would
 *    be false on a cofactor-h curve, and a future curve change must revisit it.
 *
 * Pure JCE + BigInteger, no hand-rolled EC arithmetic in the key-agreement path
 * (the on-curve test is a field equation, not point arithmetic). Runs unchanged
 * on the JVM, so every rule above is unit-tested without an emulator.
 */
object E2eKeyEncoding {

    /** SEC1 tag for an uncompressed point. The only prefix we accept. */
    const val UNCOMPRESSED_TAG: Byte = 0x04

    /** Bytes per coordinate for P-256. */
    const val COORD_BYTES = 32

    /** Length of a P-256 public key on the wire: tag + X + Y. */
    const val SEC1_UNCOMPRESSED_LENGTH = 1 + 2 * COORD_BYTES

    private const val CURVE_STD_NAME = "secp256r1"

    // ---- P-256 domain parameters (FIPS 186-4 D.1.2.3 / SEC 2 §2.4.2) --------
    // Hard-coded so validation never depends on a provider handing us the right
    // curve: the whole point of the check is to not trust what we were given.

    private val P: BigInteger = BigInteger(
        "ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16
    )

    /** a = p - 3. */
    private val A: BigInteger = P.subtract(BigInteger.valueOf(3))

    private val B: BigInteger = BigInteger(
        "5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16
    )

    /**
     * The group order n. Unused in arithmetic (see the cofactor note in the
     * class doc) but kept as the documented reason no `[n]Q` check is needed:
     * n is prime and h = 1.
     */
    val GROUP_ORDER: BigInteger = BigInteger(
        "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16
    )

    /** Cofactor of P-256. The value that makes the small-order check redundant. */
    const val COFACTOR = 1

    /** Thrown when a byte string is not a valid, usable P-256 public key. */
    class InvalidPublicKeyException(message: String) : IllegalArgumentException(message)

    // ------------------------------------------------------------ to SEC1

    /**
     * Encode a P-256 public key as uncompressed SEC1.
     *
     * Coordinates are LEFT-PADDED to exactly 32 bytes. This is the detail that
     * breaks implementations written from the prose: roughly one key in 256 has
     * an X or Y whose big-endian representation is 31 bytes or fewer, and
     * `BigInteger.toByteArray()` returns exactly those bytes — plus, for a value
     * with the high bit set, a leading 0x00 sign byte that must be stripped. A
     * naive `toByteArray()` therefore produces a 64- or 66-byte "key" that is
     * wrong only some of the time, on some keys, which is the worst failure
     * shape available.
     */
    fun toSec1(key: PublicKey): ByteArray {
        val ec = key as? ECPublicKey
            ?: throw InvalidPublicKeyException(
                "not an EC public key (${key.algorithm}/${key.javaClass.name})"
            )
        val out = ByteArray(SEC1_UNCOMPRESSED_LENGTH)
        out[0] = UNCOMPRESSED_TAG
        writeFixedWidth(ec.w.affineX, out, 1)
        writeFixedWidth(ec.w.affineY, out, 1 + COORD_BYTES)
        // Re-validate our OWN key: a provider bug that hands back an off-curve
        // point would otherwise be published to every peer and only surface as
        // "the digits never match".
        validate(out)
        return out
    }

    private fun writeFixedWidth(value: BigInteger, dest: ByteArray, offset: Int) {
        if (value.signum() < 0) {
            throw InvalidPublicKeyException("negative coordinate")
        }
        val raw = value.toByteArray()
        // Strip a leading 0x00 sign byte, then left-pad into the fixed window.
        val start = if (raw.size > 1 && raw[0] == 0.toByte()) 1 else 0
        val len = raw.size - start
        if (len > COORD_BYTES) {
            throw InvalidPublicKeyException("coordinate wider than $COORD_BYTES bytes ($len)")
        }
        java.util.Arrays.fill(dest, offset, offset + COORD_BYTES, 0.toByte())
        System.arraycopy(raw, start, dest, offset + COORD_BYTES - len, len)
    }

    // ---------------------------------------------------------- from SEC1

    /**
     * Decode and VALIDATE an uncompressed SEC1 P-256 public key.
     *
     * Every path that turns peer bytes into a [PublicKey] goes through here —
     * there is deliberately no "trusting" variant, because an unvalidated peer
     * point handed to `KeyAgreement` is the invalid-curve attack.
     */
    fun fromSec1(sec1: ByteArray): ECPublicKey {
        validate(sec1)
        val x = BigInteger(1, sec1.copyOfRange(1, 1 + COORD_BYTES))
        val y = BigInteger(1, sec1.copyOfRange(1 + COORD_BYTES, SEC1_UNCOMPRESSED_LENGTH))
        val spec = ECPublicKeySpec(ECPoint(x, y), p256Params())
        return KeyFactory.getInstance("EC").generatePublic(spec) as ECPublicKey
    }

    /**
     * The P-256 [ECParameterSpec], obtained from the platform rather than
     * hand-built. Hand-building it is how a curve typo becomes a silent
     * different-curve key.
     */
    fun p256Params(): ECParameterSpec {
        val params = AlgorithmParameters.getInstance("EC")
        params.init(ECGenParameterSpec(CURVE_STD_NAME))
        return params.getParameterSpec(ECParameterSpec::class.java)
    }

    // -------------------------------------------------------- validation

    /**
     * Prove [sec1] is a usable P-256 public key, or throw
     * [InvalidPublicKeyException] naming the exact rule that failed.
     *
     * Throwing rather than returning a boolean is deliberate: a boolean gets
     * dropped at a call site one refactor later, and an unchecked key is
     * indistinguishable from a checked one at runtime.
     */
    fun validate(sec1: ByteArray) {
        if (sec1.size != SEC1_UNCOMPRESSED_LENGTH) {
            throw InvalidPublicKeyException(
                "public key must be $SEC1_UNCOMPRESSED_LENGTH bytes of uncompressed SEC1, " +
                    "got ${sec1.size} (an X.509 SubjectPublicKeyInfo P-256 key is 91)"
            )
        }
        if (sec1[0] != UNCOMPRESSED_TAG) {
            throw InvalidPublicKeyException(
                "public key prefix must be 0x04 (uncompressed); got " +
                    "0x%02x — compressed points are rejected, not decompressed".format(sec1[0])
            )
        }
        val x = BigInteger(1, sec1.copyOfRange(1, 1 + COORD_BYTES))
        val y = BigInteger(1, sec1.copyOfRange(1 + COORD_BYTES, SEC1_UNCOMPRESSED_LENGTH))

        if (x.signum() == 0 && y.signum() == 0) {
            throw InvalidPublicKeyException("public key is the all-zero point (identity)")
        }
        if (x >= P) throw InvalidPublicKeyException("X coordinate is not in [0, p)")
        if (y >= P) throw InvalidPublicKeyException("Y coordinate is not in [0, p)")

        // y^2 == x^3 + a*x + b (mod p)
        val lhs = y.multiply(y).mod(P)
        val rhs = x.multiply(x).mod(P).multiply(x).mod(P)
            .add(A.multiply(x).mod(P))
            .add(B)
            .mod(P)
        if (lhs != rhs) {
            throw InvalidPublicKeyException(
                "public key is not a point on P-256 (invalid-curve attack or corrupt key)"
            )
        }
        // Small-order / subgroup: nothing further to check. P-256 has cofactor
        // h = COFACTOR = 1 and prime order n = GROUP_ORDER, so every on-curve
        // point that is not the identity has order exactly n. See the class doc.
    }

    /** True when [sec1] is a valid P-256 public key. For tests and logging only. */
    fun isValid(sec1: ByteArray): Boolean =
        try {
            validate(sec1)
            true
        } catch (e: InvalidPublicKeyException) {
            false
        }

    // ------------------------------------------------------------ base64url

    /**
     * base64url, unpadded — the wire encoding named in the Gate 1 ruling.
     *
     * Hand-rolled over [android.util.Base64]'s flags because this object must
     * also run on the JVM unit-test classpath, where `android.util.Base64` is a
     * stub that throws. The alphabet is RFC 4648 §5.
     */
    fun toBase64Url(bytes: ByteArray): String {
        val sb = StringBuilder((bytes.size + 2) / 3 * 4)
        var i = 0
        while (i < bytes.size) {
            val b0 = bytes[i].toInt() and 0xff
            val b1 = if (i + 1 < bytes.size) bytes[i + 1].toInt() and 0xff else -1
            val b2 = if (i + 2 < bytes.size) bytes[i + 2].toInt() and 0xff else -1
            sb.append(B64URL[b0 ushr 2])
            sb.append(B64URL[((b0 and 0x03) shl 4) or (if (b1 >= 0) b1 ushr 4 else 0)])
            if (b1 >= 0) {
                sb.append(B64URL[((b1 and 0x0f) shl 2) or (if (b2 >= 0) b2 ushr 6 else 0)])
            }
            if (b2 >= 0) sb.append(B64URL[b2 and 0x3f])
            i += 3
        }
        return sb.toString()
    }

    /** Inverse of [toBase64Url]. Rejects padding and any non-alphabet character. */
    fun fromBase64Url(s: String): ByteArray {
        if (s.contains('=')) throw InvalidPublicKeyException("base64url must be unpadded")
        val out = java.io.ByteArrayOutputStream(s.length * 3 / 4 + 3)
        var acc = 0
        var bits = 0
        for (ch in s) {
            val v = B64URL.indexOf(ch)
            if (v < 0) throw InvalidPublicKeyException("not base64url: '$ch'")
            acc = (acc shl 6) or v
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write((acc ushr bits) and 0xff)
            }
        }
        return out.toByteArray()
    }

    private const val B64URL =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
}
