package com.dnkdialer.companion

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * E2E P4.4 / R-BH — [TokenStore]'s account id, on real Keystore-backed
 * EncryptedSharedPreferences.
 *
 * Instrumented rather than unit, and that is the point: the persist-once rule
 * and the sign-out wipe are both claims about what survives ON DISK, and the
 * disk here is `EncryptedSharedPreferences` with an Android Keystore master
 * key. A `SharedPreferences` fake would agree with itself about all of it.
 *
 * What is being defended: the account id is a SPEC 13.10.3 pairContext input,
 * so every pairing's key schedule depends on it. Two rules follow, and they
 * pull in opposite directions, which is why both are pinned here:
 *
 *  - it must never change UNDER a signed-in session (persist-once), because a
 *    silent change re-keys every pairing and the only symptom is that traffic
 *    stops decrypting;
 *  - it must ALWAYS be gone after sign-out, because a phone that logs into a
 *    second account while holding the first account's id would either derive
 *    under a stranger's identity or sit in the mismatch refusal forever.
 */
@RunWith(AndroidJUnit4::class)
class E2eUserIdStoreTest {

    private val ctx = InstrumentationRegistry.getInstrumentation().targetContext

    @Before
    fun wipe() {
        TokenStore.clear(ctx)
    }

    @Test
    fun an_unlearned_account_id_reads_null() {
        assertNull(TokenStore.getUserId(ctx))
    }

    @Test
    fun the_first_id_is_stored_and_reads_back() {
        assertEquals(TokenStore.UserIdWrite.STORED, TokenStore.putUserId(ctx, "acct-1"))
        assertEquals("acct-1", TokenStore.getUserId(ctx))
    }

    @Test
    fun re_offering_the_same_id_is_a_no_op() {
        TokenStore.putUserId(ctx, "acct-1")
        assertEquals(TokenStore.UserIdWrite.UNCHANGED, TokenStore.putUserId(ctx, "acct-1"))
        assertEquals("acct-1", TokenStore.getUserId(ctx))
    }

    /**
     * THE rule. A second, different id for a token that resolves to exactly one
     * User row is not a normal event, so the stored value wins and the caller
     * is told — which is what lets the Accept path refuse instead of re-keying.
     */
    @Test
    fun a_different_id_is_refused_and_the_stored_one_survives() {
        TokenStore.putUserId(ctx, "acct-1")
        assertEquals(TokenStore.UserIdWrite.MISMATCH, TokenStore.putUserId(ctx, "acct-2"))
        assertEquals("acct-1", TokenStore.getUserId(ctx))
    }

    /**
     * `""` is the value that caused A6-P61B-8. It is never written, and it is
     * never allowed to displace a real id either.
     */
    @Test
    fun a_blank_or_absent_id_is_never_written_and_never_displaces() {
        assertEquals(TokenStore.UserIdWrite.UNCHANGED, TokenStore.putUserId(ctx, null))
        assertEquals(TokenStore.UserIdWrite.UNCHANGED, TokenStore.putUserId(ctx, ""))
        assertEquals(TokenStore.UserIdWrite.UNCHANGED, TokenStore.putUserId(ctx, "   "))
        assertNull("a blank must not have been stored", TokenStore.getUserId(ctx))

        TokenStore.putUserId(ctx, "acct-1")
        assertEquals(TokenStore.UserIdWrite.UNCHANGED, TokenStore.putUserId(ctx, ""))
        assertEquals("acct-1", TokenStore.getUserId(ctx))
    }

    /**
     * Sign-out takes the token and the id TOGETHER. They live in one prefs file
     * precisely so there is no second place to forget.
     */
    @Test
    fun sign_out_clears_the_account_id_with_the_token() {
        TokenStore.save(ctx, "tok-abc", "Pixel")
        TokenStore.putUserId(ctx, "acct-1")
        assertEquals("acct-1", TokenStore.getUserId(ctx))

        TokenStore.clear(ctx)

        assertNull("the token is gone", TokenStore.getPhoneToken(ctx))
        assertNull("and so is the account id", TokenStore.getUserId(ctx))
        // …and the slot is genuinely free, not merely unreadable: a fresh
        // login to ANOTHER account must be able to store its own id.
        assertEquals(TokenStore.UserIdWrite.STORED, TokenStore.putUserId(ctx, "acct-2"))
        assertEquals("acct-2", TokenStore.getUserId(ctx))
    }
}
