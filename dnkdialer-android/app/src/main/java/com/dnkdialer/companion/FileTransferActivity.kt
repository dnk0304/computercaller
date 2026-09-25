package com.dnkdialer.companion

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.net.toUri

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
 *
 * ## Why this Activity must NOT be `noHistory`
 *
 * It was, until vc64. `android:noHistory="true"` destroys an Activity the
 * moment it stops being visible - and opening a SAF picker is exactly that:
 * the picker runs in another task on top. The OS therefore tore this Activity
 * down while the user was still choosing a file, `onActivityResult` never ran,
 * and BOTH halves of the feature died: phone->computer send never started, and
 * an incoming offer could never be given a destination. Proven on PROD by
 * ACCEPT-9 (2026-09-23).
 *
 * The original intent behind the flag - "no zombie dialog left behind" - is
 * carried by `excludeFromRecents` (it never appears in recents) plus the
 * `finish()` on every exit path of every dialog below. Neither of those needs
 * the Activity to be destroyed mid-picker.
 *
 * Results are taken through [ActivityResultContracts] rather than the
 * deprecated `startActivityForResult`, so the launchers are registered before
 * `onCreate` returns and a result survives a legitimate recreation (rotation,
 * process death under memory pressure) instead of being dropped.
 */
class FileTransferActivity : AppCompatActivity() {

    companion object {
        const val ACTION_PICK_FILE = "com.dnkdialer.companion.FT_PICK"
        const val ACTION_SHOW_OFFER = "com.dnkdialer.companion.FT_SHOW_OFFER"
        const val ACTION_SHOW_MESSAGE = "com.dnkdialer.companion.FT_SHOW_MESSAGE"

        /** FILE-QUEUE: pick the file again for a needs-file / failed row. */
        const val ACTION_REPICK = "com.dnkdialer.companion.FT_REPICK"

        /** The queue row [ACTION_REPICK] is for. */
        const val EXTRA_QUEUE_KEY = "queue_key"

        /** Skip the confirm dialog and go straight to the picker. */
        const val EXTRA_AUTO_ACCEPT = "auto_accept"

        /** A [FileTransfer.Reason] value to render via [failureCopy]. */
        const val EXTRA_REASON = "reason"
    }

    // Registered at construction time, which is what the contract API
    // requires: a launcher created after onCreate() has returned throws, and
    // one registered here is re-attached for free when the Activity is
    // recreated - which is the whole point of dropping noHistory.
    private val pickSource = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { r -> onSourcePicked(r) }

    private val createDestination = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { r -> onDestinationPicked(r) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setFinishOnTouchOutside(true)
        // Act on the launching intent ONCE. A recreation must not fire a
        // second picker on top of a result that is already on its way.
        if (savedInstanceState == null) dispatch(intent)
    }

    /**
     * Without `noHistory` this Activity survives, and `launchMode="singleTop"`
     * means a second offer notification is delivered here rather than to a
     * fresh instance. Re-pointing [getIntent] and re-dispatching is what keeps
     * that second offer from being silently swallowed.
     */
    override fun onNewIntent(newIntent: Intent) {
        super.onNewIntent(newIntent)
        setIntent(newIntent)
        dispatch(newIntent)
    }

    private fun dispatch(intent: Intent?) {
        when (intent?.action) {
            Intent.ACTION_SEND -> handleShare(
                listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
            )
            // FILE-QUEUE: every shared file is queued, in the order given.
            // The manager still sends one at a time; the queue feeds it.
            Intent.ACTION_SEND_MULTIPLE -> handleShare(
                intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty().filterNotNull()
            )
            ACTION_PICK_FILE -> openSourcePicker(multiple = true)
            ACTION_REPICK -> {
                repickKey = intent.getStringExtra(EXTRA_QUEUE_KEY)
                if (repickKey == null) finish() else openSourcePicker(multiple = false)
            }
            ACTION_SHOW_OFFER -> showOffer(intent.getBooleanExtra(EXTRA_AUTO_ACCEPT, false))
            ACTION_SHOW_MESSAGE -> showMessage(intent.getStringExtra(EXTRA_REASON))
            else -> finish()
        }
    }

    // ---------------------------------------------------------------- send

    /** Set while an [ACTION_REPICK] picker is open. Survives recreation via [onSaveInstanceState]. */
    private var repickKey: String? = null

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        repickKey?.let { outState.putString(EXTRA_QUEUE_KEY, it) }
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        repickKey = savedInstanceState.getString(EXTRA_QUEUE_KEY)
    }

    private fun handleShare(uris: List<Uri>) {
        if (uris.isEmpty()) {
            toast(getString(R.string.ft_no_file)); finish(); return
        }
        // A share grant may not be persistable; try anyway, and record
        // whether it took so a restart can tell queued from needs-file.
        confirmAndSend(uris.map { it to persist(it, write = false) })
    }

    private fun openSourcePicker(multiple: Boolean) {
        val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            // FILE-QUEUE: pick several at once; they queue in pick order.
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
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
            pickSource.launch(i)
        } catch (e: Exception) {
            toast(getString(R.string.ft_no_picker)); finish()
        }
    }

    /**
     * (d) The 1 GB cap is enforced by the server; this refusal is the mirror,
     * worded identically, so a user who hits it on the phone and a user who
     * hits it on the relay are told the same thing.
     *
     * FILE-QUEUE: one confirm for the whole batch ("N files, X total"), then
     * every file goes into the queue. A single file keeps its own dialog and
     * the local over-1-GB refusal; in a batch an over-cap file is queued and
     * fails `too_large` on its own row, which fails that file only.
     */
    private fun confirmAndSend(picked: List<Pair<Uri, Boolean>>) {
        val files = picked.map { (uri, persistable) ->
            val m = queryMeta(uri)
            FileTransferQueue.NewFile(
                uri = uri.toString(),
                name = FileTransfer.sanitizeName(m.name),
                size = m.size,
                lastModified = m.lastModified,
                persistable = persistable,
            )
        }
        if (files.size == 1 && files[0].size > FileTransfer.MAX_FILE_BYTES) {
            AlertDialog.Builder(this)
                .setTitle(R.string.ft_too_large_title)
                .setMessage(getString(R.string.ft_fail_too_large))
                .setPositiveButton(android.R.string.ok) { _, _ -> finish() }
                .setOnDismissListener { finish() }
                .show()
            return
        }
        val queue = PhoneService.fileTransferQueue
        if (queue == null) {
            toast(getString(R.string.ft_not_connected)); finish(); return
        }
        val builder = AlertDialog.Builder(this)
        if (files.size == 1) {
            val f = files[0]
            builder.setTitle(getString(R.string.ft_send_title, f.name))
                .setMessage(
                    getString(R.string.ft_send_body, if (f.size >= 0) FileTransfer.humanSize(f.size) else "")
                )
        } else {
            val total = files.sumOf { maxOf(it.size, 0L) }
            builder.setTitle(
                resources.getQuantityString(R.plurals.ft_send_multi_title, files.size, files.size)
            ).setMessage(getString(R.string.ft_send_multi_body, FileTransfer.humanSize(total)))
        }
        builder
            .setPositiveButton(R.string.ft_send) { _, _ ->
                queue.enqueue(files)
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
        // Every value below is decided by the pure spec (unit-proved); this
        // method only turns that spec into an Intent. The .part document is
        // created as octet-stream on purpose: giving it the real mime would
        // let a gallery or media scanner index a half-written file as if it
        // were the finished one.
        val spec = FileTransfer.destinationSpec(name)
        val i = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = spec.mime
            putExtra(Intent.EXTRA_TITLE, spec.title)
            // Downloads by default; the user can still pick anywhere. No SDK
            // guard: EXTRA_INITIAL_URI is API 26 and minSdk is 26.
            putExtra(
                android.provider.DocumentsContract.EXTRA_INITIAL_URI,
                spec.initialUri.toUri()
            )
        }
        try {
            createDestination.launch(i)
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

    private fun onSourcePicked(r: ActivityResult) {
        val data = r.data
        // EXTRA_ALLOW_MULTIPLE: several picks arrive as clipData, one as data.
        val uris = ArrayList<Uri>()
        data?.clipData?.let { c -> for (k in 0 until c.itemCount) c.getItemAt(k).uri?.let(uris::add) }
        if (uris.isEmpty()) data?.data?.let(uris::add)
        if (r.resultCode != Activity.RESULT_OK || uris.isEmpty()) { finish(); return }
        val key = repickKey
        if (key != null) {
            // Re-pick: the user already confirmed this send once.
            val uri = uris[0]
            val persistable = persist(uri, write = false)
            val m = queryMeta(uri)
            val queue = PhoneService.fileTransferQueue
            if (queue == null) {
                toast(getString(R.string.ft_not_connected))
            } else {
                queue.repick(
                    key,
                    FileTransferQueue.NewFile(
                        uri.toString(), FileTransfer.sanitizeName(m.name), m.size, m.lastModified, persistable,
                    ),
                )
            }
            finish(); return
        }
        confirmAndSend(uris.map { it to persist(it, write = false) })
    }

    private fun onDestinationPicked(r: ActivityResult) {
        val mgr = PhoneService.fileTransferHandler
        val uri = r.data?.data
        if (r.resultCode != Activity.RESULT_OK || uri == null) {
            // Backing out of the destination picker is a rejection -
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

    /**
     * Hold the grant across process death so a resume can re-open the document.
     * @return true if the grant is now persisted (FILE-QUEUE: a queued row
     * that survives a restart as queued rather than needs-file).
     */
    private fun persist(uri: Uri, write: Boolean): Boolean {
        return try {
            var flags = Intent.FLAG_GRANT_READ_URI_PERMISSION
            if (write) flags = flags or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            contentResolver.takePersistableUriPermission(uri, flags)
            true
        } catch (e: Exception) {
            // Not fatal: the transfer works for as long as this task lives.
            // Only a resume after a process death needs the persisted grant.
            android.util.Log.w("FileTransfer", "no persistable grant: ${e.message}")
            false
        }
    }

    private class Meta(val name: String?, val size: Long, val lastModified: Long)

    private fun queryMeta(uri: Uri): Meta {
        var name: String? = null
        var size = -1L
        var modified = 0L
        try {
            contentResolver.query(uri, null, null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                    val mi = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED)
                    if (mi >= 0 && !c.isNull(mi)) modified = c.getLong(mi)
                }
            }
        } catch (e: Exception) {
            android.util.Log.w("FileTransfer", "meta query failed: ${e.message}")
        }
        return Meta(name, size, modified)
    }

    private fun toast(msg: String) =
        android.widget.Toast.makeText(this, msg, android.widget.Toast.LENGTH_LONG).show()
}
