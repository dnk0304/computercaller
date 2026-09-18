package com.dnkdialer.companion

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

/**
 * FT-2 (a)(b)(d) — the only Activity this feature adds. Four entry points,
 * one screen that is never really a screen: it is transparent and finishes as
 * soon as its dialog or its picker resolves.
 *
 *  1. **Share-sheet target** — `ACTION_SEND` from any app ("Send to computer").
 *  2. **In-app picker** — [ACTION_PICK_FILE], fired from the app's own UI.
 *  3. **Accept dialog** — [ACTION_SHOW_OFFER], from the offer notification.
 *  4. **Quota / tier copy** — [ACTION_SHOW_MESSAGE], so a refusal the service
 *     learned about over the socket can be shown as a dialog rather than only
 *     as a notification the user may have swiped away.
 *
 * ## Why Accept lives in an Activity
 *
 * Accepting opens `ACTION_CREATE_DOCUMENT`, and a document picker needs an
 * Activity result. It also gives the user the "where do you want it?" choice
 * the brief asks for, with Downloads pre-selected via EXTRA_INITIAL_URI — one
 * extra tap, and the user picks. Routing Accept through a broadcast first
 * would spend the tap on a hop that cannot open a picker.
 *
 * ## Why the destination document is created BEFORE the first chunk
 *
 * The receiver streams to disk; there is nowhere to hold bytes while we ask.
 * So the order is: user accepts → picker creates `<name>.part` → only then
 * does FILE_ACCEPT go out. A FILE_ACCEPT sent before we hold a writable
 * descriptor is a promise we might not be able to keep, and the sender would
 * already be pushing chunks by the time we found out.
 */
class FileTransferActivity : AppCompatActivity() {

    companion object {
        const val ACTION_PICK_FILE = "com.dnkdialer.companion.FT_PICK"
        const val ACTION_SHOW_OFFER = "com.dnkdialer.companion.FT_SHOW_OFFER"
        const val ACTION_SHOW_MESSAGE = "com.dnkdialer.companion.FT_SHOW_MESSAGE"

        /** Skip the confirm dialog and go straight to the picker. */
        const val EXTRA_AUTO_ACCEPT = "auto_accept"

        /** A [FileTransfer.Reason] value to render via [failureCopy]. */
        const val EXTRA_REASON = "reason"

        private const val RQ_PICK_SOURCE = 41
        private const val RQ_CREATE_DEST = 42
    }

    /** Set when the create-document picker is open, so its result knows the name. */
    private var pendingOfferName: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setFinishOnTouchOutside(true)

        when (intent?.action) {
            Intent.ACTION_SEND -> handleShare(
                intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
            )
            Intent.ACTION_SEND_MULTIPLE -> {
                // One transfer at a time (spec §2). Taking the first and
                // saying so is better than silently dropping the rest.
                val uris = intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
                if ((uris?.size ?: 0) > 1) toast(getString(R.string.ft_one_at_a_time))
                handleShare(uris?.firstOrNull())
            }
            ACTION_PICK_FILE -> openSourcePicker()
            ACTION_SHOW_OFFER -> showOffer(intent.getBooleanExtra(EXTRA_AUTO_ACCEPT, false))
            ACTION_SHOW_MESSAGE -> showMessage(intent.getStringExtra(EXTRA_REASON))
            else -> finish()
        }
    }

    // ---------------------------------------------------------------- send

    private fun handleShare(uri: Uri?) {
        if (uri == null) {
            toast(getString(R.string.ft_no_file)); finish(); return
        }
        confirmAndSend(uri)
    }

    private fun openSourcePicker() {
        val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            // FLAG_GRANT_PERSISTABLE_URI_PERMISSION is what lets a resume
            // re-open the source after the app was killed mid-transfer. Without
            // it the grant dies with the task and a 1 GB resume has nothing to
            // re-slice from — which the spec's own resume clause calls out as
            // the reason v1 originally chose abort-over-resume.
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
        }
        try {
            startActivityForResult(i, RQ_PICK_SOURCE)
        } catch (e: Exception) {
            toast(getString(R.string.ft_no_picker)); finish()
        }
    }

    /**
     * (d) The 1 GB cap is enforced by the server; this refusal is the mirror,
     * worded identically, so a user who hits it on the phone and a user who
     * hits it on the relay are told the same thing.
     */
    private fun confirmAndSend(uri: Uri) {
        val (name, size) = queryMeta(uri)
        if (size > FileTransfer.MAX_FILE_BYTES) {
            AlertDialog.Builder(this)
                .setTitle(R.string.ft_too_large_title)
                .setMessage(getString(R.string.ft_fail_too_large))
                .setPositiveButton(android.R.string.ok) { _, _ -> finish() }
                .setOnDismissListener { finish() }
                .show()
            return
        }
        val svc = PhoneService.fileTransferHandler
        if (svc == null) {
            toast(getString(R.string.ft_not_connected)); finish(); return
        }
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.ft_send_title, FileTransfer.sanitizeName(name)))
            .setMessage(
                getString(
                    R.string.ft_send_body,
                    if (size >= 0) FileTransfer.humanSize(size) else "",
                )
            )
            .setPositiveButton(R.string.ft_send) { _, _ ->
                svc.startSend(uri)
                toast(getString(R.string.ft_send_started))
                finish()
            }
            .setNegativeButton(android.R.string.cancel) { _, _ -> finish() }
            .setOnDismissListener { finish() }
            .show()
    }

    // ------------------------------------------------------------- receive

    private fun showOffer(autoAccept: Boolean) {
        val mgr = PhoneService.fileTransferHandler
        val info = mgr?.pendingOfferInfo()
        if (info == null) {
            // The offer expired or was answered elsewhere. Saying so beats a
            // dialog for a transfer that no longer exists.
            toast(getString(R.string.ft_offer_gone)); finish(); return
        }
        val (_, name, size) = info
        if (autoAccept) {
            pendingOfferName = name
            openDestinationPicker(name)
            return
        }
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.ft_offer_title, name, FileTransfer.humanSize(size)))
            // Not scanned for viruses, said out loud. Spec §6: the receiver
            // seeing name, size and type before accepting is the mitigation,
            // and it is informed consent, not protection.
            .setMessage(R.string.ft_offer_trust)
            .setPositiveButton(R.string.ft_accept) { _, _ ->
                pendingOfferName = name
                openDestinationPicker(name)
            }
            .setNegativeButton(R.string.ft_reject) { _, _ ->
                mgr.rejectOffer()
                finish()
            }
            .setOnCancelListener { mgr.rejectOffer(); finish() }
            .show()
    }

    private fun openDestinationPicker(name: String) {
        val i = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            // The .part document is created as octet-stream on purpose: giving
            // it the real mime would let a gallery or media scanner index a
            // half-written file as if it were the finished one.
            type = "application/octet-stream"
            putExtra(Intent.EXTRA_TITLE, FileTransfer.partNameFor(name))
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                putExtra(
                    android.provider.DocumentsContract.EXTRA_INITIAL_URI,
                    Uri.parse("content://com.android.externalstorage.documents/document/primary%3ADownload")
                )
            }
        }
        try {
            startActivityForResult(i, RQ_CREATE_DEST)
        } catch (e: Exception) {
            PhoneService.fileTransferHandler?.rejectOffer()
            toast(getString(R.string.ft_no_picker)); finish()
        }
    }

    // ---------------------------------------------------------------- misc

    private fun showMessage(reason: String?) {
        AlertDialog.Builder(this)
            .setTitle(R.string.ft_cannot_send_title)
            .setMessage(failureCopy(this, reason ?: FileTransfer.Reason.CONNECTION_LOST))
            .setPositiveButton(android.R.string.ok) { _, _ -> finish() }
            .setOnDismissListener { finish() }
            .show()
    }

    @Deprecated("startActivityForResult is the API the SAF pickers document")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val uri = data?.data
        val mgr = PhoneService.fileTransferHandler
        when (requestCode) {
            RQ_PICK_SOURCE -> {
                if (resultCode != Activity.RESULT_OK || uri == null) { finish(); return }
                persist(uri, write = false)
                confirmAndSend(uri)
            }
            RQ_CREATE_DEST -> {
                if (resultCode != Activity.RESULT_OK || uri == null) {
                    // Backing out of the destination picker is a rejection —
                    // NOT a silent dismissal. The sender is sitting on a 60 s
                    // expiry and deserves to be told now.
                    mgr?.rejectOffer()
                    finish(); return
                }
                persist(uri, write = true)
                mgr?.acceptOffer(uri)
                toast(getString(R.string.ft_receive_started))
                finish()
            }
            else -> finish()
        }
    }

    /** Hold the grant across process death so a resume can re-open the document. */
    private fun persist(uri: Uri, write: Boolean) {
        try {
            var flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
            if (write) flags = flags or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            contentResolver.takePersistableUriPermission(uri, flags)
        } catch (e: Exception) {
            // Not fatal: the transfer works for as long as this task lives.
            // Only a resume after a process death needs the persisted grant.
            android.util.Log.w("FileTransfer", "no persistable grant: ${e.message}")
        }
    }

    private fun queryMeta(uri: Uri): Pair<String?, Long> {
        var name: String? = null
        var size = -1L
        try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                }
            }
        } catch (e: Exception) {
            android.util.Log.w("FileTransfer", "meta query failed: ${e.message}")
        }
        return name to size
    }

    private fun toast(msg: String) =
        android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_LONG).show()
}
