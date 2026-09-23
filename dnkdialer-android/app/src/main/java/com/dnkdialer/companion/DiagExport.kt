package com.dnkdialer.companion

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import androidx.core.content.FileProvider
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * T-VC63-EXPORT-DIAGNOSTICS — `Settings > Export diagnostics`.
 *
 * Builds the archive [DiagZip] defines, hands it to the system share sheet via
 * a narrowly scoped [FileProvider], and prunes old exports. Everything that can
 * be decided without a `Context` lives in [DiagZip] / [DiagStore] / [Redact] so
 * the unit suite can reach it; what is left here is the Android plumbing.
 *
 * ## Why a share sheet and not an upload
 *
 * The brief forbids a network upload, and that is the right call twice over:
 * an upload endpoint would be a new unauthenticated ingest surface holding
 * exactly the data we are trying not to hold, and it would turn "send us your
 * logs" into a consent question we cannot answer inside a toast. The share
 * sheet makes the user the one who chooses the recipient, every time.
 *
 * ## Why `logcat -d --pid=<me>` needs no permission
 *
 * Since API 16 an app may read its OWN process's logcat lines without
 * READ_LOGS; the platform filters by uid. READ_LOGS itself is signature-level
 * and requesting it is a Play review flag on an app that already carries
 * SMS + Call Log — see the manifest header. So the pid filter is not an
 * optimisation, it is the entire reason this is shippable.
 */
object DiagExport {

    private const val TAG = "DiagExport"

    /** Subdirectory of `cacheDir` the FileProvider exposes. Nothing else is. */
    const val EXPORT_DIR = "diag-export"

    /** Exports older than this are deleted on export and at app start. */
    const val EXPORT_RETENTION_MS = 24L * 60 * 60 * 1000

    private fun authority(context: Context) = context.packageName + ".diagnostics"

    private fun utcStamp(): String =
        SimpleDateFormat("yyyyMMdd-HHmm", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }
            .format(Date())

    /**
     * Build the zip. Blocking, disk + process IO — call from a worker thread.
     *
     * @throws java.io.IOException if the archive itself cannot be written. A
     *   failure to collect logcat is NOT an error (see [DiagZip]).
     */
    fun build(context: Context): File {
        val app = context.applicationContext
        // The last lines before the tap are the interesting ones, so get the
        // ring onto disk before reading the files.
        DiagLog.flushBlocking()
        pruneExports(app)
        val diagId = DiagLog.diagId(app)
        val out = File(
            File(app.cacheDir, EXPORT_DIR),
            "computercaller-diag-$diagId-${utcStamp()}.zip",
        )
        val store = DiagStore(DiagLog.dir(app))
        return DiagZip.write(
            out = out,
            logFiles = store.logFiles(),
            ringTail = DiagLog.ringSnapshot(),
            countersJson = countersJson(),
            deviceTxt = deviceTxt(app, diagId),
            logcat = { readOwnLogcat() },
        )
    }

    /**
     * Counters as written by the live process. Read through [DiagLog] rather
     * than off disk so an export taken seconds after a flap storm shows the
     * storm, not the last flush.
     */
    private fun countersJson(): String {
        val snap = DiagLog.snapshotCounters()
        return buildString {
            append("{\n")
            val e = snap.entries.toList()
            e.forEachIndexed { i, en ->
                append("  \"").append(en.key).append("\": ").append(en.value)
                if (i < e.size - 1) append(",")
                append("\n")
            }
            append("}\n")
        }
    }

    /**
     * `logcat -d -v threadtime --pid=<me>`.
     *
     * Allowed to throw; [DiagZip] converts the throwable into the entry's
     * body. `destroy()` in a finally, because a logcat that never exits would
     * otherwise leave a child process attached to the app for the rest of its
     * life.
     */
    private fun readOwnLogcat(): String {
        val p = Runtime.getRuntime().exec(
            arrayOf("logcat", "-d", "-v", "threadtime", "--pid=" + android.os.Process.myPid()),
        )
        return try {
            p.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            try {
                p.destroy()
            } catch (t: Throwable) {
            }
        }
    }

    /**
     * The human-readable half of the archive.
     *
     * Every field here is either a build fact, a permission STATE (never a
     * value), or a hash. `pairingId` is truncated to 6 hex of its SHA-256 —
     * enough for Ken to line the zip up against a relay room, not enough to
     * address one. Granted permissions are listed by NAME only; the point is
     * "did the OS revoke READ_SMS again", which is a yes/no per name.
     */
    fun deviceTxt(context: Context, diagId: String): String {
        val sb = StringBuilder()
        fun row(k: String, v: Any?) = sb.append(k).append(": ").append(v).append('\n')

        row("diagnosticsId", diagId)
        row("generatedUtc", SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date()))
        sb.append('\n')

        row("manufacturer", Build.MANUFACTURER)
        row("model", Build.MODEL)
        row("device", Build.DEVICE)
        row("sdkInt", Build.VERSION.SDK_INT)
        row("release", Build.VERSION.RELEASE)
        // minSdk is 26, so SECURITY_PATCH (API 23) is unconditionally present;
        // an SDK_INT guard here would be a permanently-dead branch and an
        // ObsoleteSdkInt lint item.
        row("securityPatch", Build.VERSION.SECURITY_PATCH)
        row("locale", Locale.getDefault().toString())
        row("timezone", TimeZone.getDefault().id)
        sb.append('\n')

        row("versionName", BuildConfig.VERSION_NAME)
        row("versionCode", BuildConfig.VERSION_CODE)
        row("applicationId", context.packageName)
        row("installer", installerPackage(context) ?: "unknown")
        row("debugBuild", BuildConfig.DEBUG)
        sb.append('\n')

        row("ignoringBatteryOptimizations", ignoringBatteryOptimizations(context))
        row("notificationListenerGranted", notificationListenerGranted(context))
        row("grantedPermissions", grantedPermissions(context).joinToString(","))
        sb.append('\n')

        val enabled = runCatching { E2eSettings.isEncryptedModeEnabled(context) }.getOrDefault(false)
        val adv = runCatching { E2eSettings.currentPeerAdvertisement(context) }.getOrNull()
        row("e2eToggleEnabled", enabled)
        row("peerAdvertisement", if (adv == null) "none" else if (adv.supported) "SUPPORTED" else "ABSENT:" + adv.absentReason)
        row("peerRecipientKinds", adv?.kinds?.joinToString(",") ?: "-")
        row(
            "e2eEffectiveMode",
            if (adv == null) "n/a (not paired)" else runCatching {
                E2eSettings.effectiveMode(
                    enabled,
                    if (adv.supported) E2eSettings.PeerAdvertisement.OFF else E2eSettings.PeerAdvertisement.ABSENT,
                ).name
            }.getOrDefault("n/a"),
        )
        row("paired", adv != null)
        row("pairingIdHash6", adv?.pairingId?.let { Redact.hash6(it) } ?: "-")
        row("signedIn", runCatching { TokenStore.hasToken(context) }.getOrDefault(false))
        sb.append('\n')

        sb.append("countersNote: counters.json is CUMULATIVE across process starts;\n")
        sb.append("  the FLAP_STORM gauge in app.log is per-process and rolling 60 s.\n")
        sb.append("redactionNote: every app.log and logcat.txt line passed Redact.line —\n")
        sb.append("  7+ digit runs -> num:<6hex>, emails -> email:<6hex>, >160 chars truncated.\n")
        return sb.toString()
    }

    private fun installerPackage(context: Context): String? = runCatching {
        val pm = context.packageManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            pm.getInstallSourceInfo(context.packageName).installingPackageName
        } else {
            @Suppress("DEPRECATION")
            pm.getInstallerPackageName(context.packageName)
        }
    }.getOrNull()

    private fun ignoringBatteryOptimizations(context: Context): Boolean = runCatching {
        (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .isIgnoringBatteryOptimizations(context.packageName)
    }.getOrDefault(false)

    private fun notificationListenerGranted(context: Context): Boolean = runCatching {
        val flat = android.provider.Settings.Secure.getString(
            context.contentResolver,
            "enabled_notification_listeners",
        ) ?: return false
        flat.split(":").any { it.contains(context.packageName) }
    }.getOrDefault(false)

    /** Runtime-permission NAMES that are currently granted. No values, ever. */
    private fun grantedPermissions(context: Context): List<String> = runCatching {
        val info = context.packageManager.getPackageInfo(
            context.packageName,
            PackageManager.GET_PERMISSIONS,
        )
        val declared = info.requestedPermissions ?: return emptyList()
        declared.filter {
            context.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED
        }.map { it.substringAfterLast('.') }.sorted()
    }.getOrDefault(emptyList())

    /**
     * The share chooser for a built archive.
     *
     * `FLAG_GRANT_READ_URI_PERMISSION` on the chooser covers whichever app the
     * user picks; the provider itself is `exported="false"`
     * `grantUriPermissions="true"`, so nothing can read the file without a
     * grant this call made.
     */
    fun shareIntent(context: Context, zip: File, diagId: String): Intent {
        val uri: Uri = FileProvider.getUriForFile(context, authority(context), zip)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "application/zip"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, "ComputerCaller diagnostics $diagId")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return Intent.createChooser(send, context.getString(R.string.diag_export_chooser))
            .apply { addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    }

    /**
     * Delete exports older than [EXPORT_RETENTION_MS].
     *
     * Called at app start and before every build. A diagnostics zip in the
     * cache is the most sensitive artefact this app produces — redacted, but
     * still a complete behavioural trace — so it is not left lying around for
     * the next app that asks for a cache dump.
     */
    fun pruneExports(context: Context) {
        runCatching {
            val dir = File(context.applicationContext.cacheDir, EXPORT_DIR)
            val now = System.currentTimeMillis()
            dir.listFiles()?.forEach { f ->
                if (f.isFile && now - f.lastModified() > EXPORT_RETENTION_MS) f.delete()
            }
        }
    }
}
