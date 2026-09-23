package com.dnkdialer.companion

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * FT-PICKER-NOHISTORY - the Accept path's destination selection, proved on the
 * unit lane.
 *
 * The Activity half of Accept is one line of Intent plumbing; every decision
 * that can be WRONG lives in [FileTransfer.destinationSpec] and is asserted
 * here: the name is sanitised (it arrived over the wire from the peer), it
 * carries the `.part` suffix, the mime is deliberately generic, and the picker
 * opens in Downloads.
 *
 * Single surface: this is phone-side only, so there is no cross-impl vector -
 * nothing on the web/SW side selects a destination on Android.
 */
class FileTransferDestinationSpecTest {

    @Test
    fun `destination is the sanitised name plus part`() {
        val spec = FileTransfer.destinationSpec("holiday.jpg")
        assertEquals("holiday.jpg.part", spec.title)
        assertEquals(FileTransfer.partNameFor(FileTransfer.sanitizeName("holiday.jpg")), spec.title)
    }

    @Test
    fun `a hostile offer name cannot become a path or a hidden file`() {
        // The offer name is peer-controlled; the destination picker is the
        // LAST place it could turn into something else.
        val spec = FileTransfer.destinationSpec("../../etc/pwn.apk")
        assertFalse(spec.title, spec.title.contains("/"))
        assertFalse(spec.title, spec.title.contains("\\"))
        // No separators left, so a surviving ".." is just two characters of a
        // NAME - it cannot traverse. Leading dots are stripped so the file
        // cannot arrive hidden.
        assertFalse(spec.title, spec.title.startsWith("."))
        assertTrue(spec.title, spec.title.endsWith(".part"))
    }

    @Test
    fun `an absent or empty offer name still yields a usable title`() {
        for (raw in listOf(null, "", "   ")) {
            val spec = FileTransfer.destinationSpec(raw)
            assertEquals(
                "$raw",
                FileTransfer.partNameFor(FileTransfer.sanitizeName(raw)),
                spec.title,
            )
            assertTrue("$raw", spec.title.endsWith(".part"))
            assertTrue("$raw", spec.title.length > ".part".length)
        }
    }

    @Test
    fun `the in-progress document is created as octet-stream, never the real mime`() {
        // A real mime would let a gallery or media scanner index a
        // half-written .part as if it were the finished file.
        val spec = FileTransfer.destinationSpec("clip.mp4")
        assertEquals("application/octet-stream", spec.mime)
        assertEquals(FileTransfer.DEST_MIME, spec.mime)
    }

    @Test
    fun `the picker opens in Downloads on the primary volume`() {
        val spec = FileTransfer.destinationSpec("doc.pdf")
        assertEquals(
            "content://com.android.externalstorage.documents/document/primary%3ADownload",
            spec.initialUri,
        )
        assertEquals(FileTransfer.DEST_INITIAL_URI, spec.initialUri)
    }
}
