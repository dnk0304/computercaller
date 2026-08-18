package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure JVM unit test (no Android Context) for the warn-and-continue
 * REQUIRED-set contract. PermissionChecker.REQUIRED_PERMISSION_IDS is the
 * single source of truth that decides which missing checklist rows trigger
 * the "it may not work properly … continue anyway?" dialog. If a future
 * change silently reclassifies a permission, this test fails.
 *
 * Mirrors the dispatch brief (2026-08-18) REQUIRED set.
 */
class PermissionCheckerRequiredSetTest {

    /** Exactly the brief's REQUIRED set — no more, no less. */
    @Test
    fun requiredSetMatchesBrief() {
        val expected = setOf(
            "post_notifications",
            "notification_listener",
            "call_phone",
            "read_phone_state",
            "answer_phone_calls",
            "read_contacts",
            "read_call_log",
            "read_sms",
            "send_sms",
            "receive_sms",
            "battery_optimization",
        )
        assertEquals(expected, PermissionChecker.REQUIRED_PERMISSION_IDS)
    }

    /** The phone/SMS/contacts core grants must always warn if missing. */
    @Test
    fun coreCallAndSmsGrantsAreRequired() {
        listOf(
            "call_phone", "read_phone_state", "answer_phone_calls",
            "read_contacts", "read_call_log",
            "read_sms", "send_sms", "receive_sms",
        ).forEach {
            assertTrue("$it must be REQUIRED", PermissionChecker.REQUIRED_PERMISSION_IDS.contains(it))
        }
    }

    /** The two special-access grants named in the brief are REQUIRED. */
    @Test
    fun specialAccessRequiredItems() {
        assertTrue(PermissionChecker.REQUIRED_PERMISSION_IDS.contains("notification_listener"))
        assertTrue(PermissionChecker.REQUIRED_PERMISSION_IDS.contains("battery_optimization"))
        assertTrue(PermissionChecker.REQUIRED_PERMISSION_IDS.contains("post_notifications"))
    }

    /**
     * OPTIONAL/SOFT items must NOT be in the required set — they never
     * trigger the warn dialog. Camera, Bluetooth and the auto-revoke
     * whitelist are reliability/secondary, and OEM auto-start toggles are
     * undetectable (guidance only).
     */
    @Test
    fun softItemsAreNotRequired() {
        listOf("camera", "bluetooth_connect", "auto_revoke").forEach {
            assertFalse("$it must be SOFT (not required)", PermissionChecker.REQUIRED_PERMISSION_IDS.contains(it))
        }
    }
}
