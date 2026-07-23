package com.dnkdialer.companion

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.text.format.DateUtils
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat

/**
 * On-device viewer for the SMS messages + call log this app syncs.
 *
 * WHY THIS EXISTS (Google Play verifiability fix — v40, 2026-06-21)
 * -----------------------------------------------------------------
 * Play rejected the app under the SMS & Call-Log Permissions policy with
 * "Unable to verify core functionality." The restricted-permission use
 * (READ_SMS / RECEIVE_SMS / READ_CALL_LOG) was only demonstrable on the
 * DESKTOP web app after pairing a second device — a reviewer with one phone
 * could not SEE the permission being exercised, so it read as unjustified.
 *
 * This Activity reads the device's OWN providers and renders them in-app with
 * NO desktop / no live pairing required:
 *   - Messages : SmsHandler.getMessages(...)   → content://sms
 *   - Calls    : CallLogsHandler.getCallLogs(...) → CallLog.Calls.CONTENT_URI
 * Both are the exact same read paths the sync feature uses. A reviewer grants
 * the permission and immediately sees their own data populate — the
 * grant→populate moment is the demonstration.
 *
 * Deliberately self-contained: no RecyclerView/adapter, no relay, no service
 * binding, no network. Rows are built programmatically. This must WORK and be
 * screen-recordable; Pixel can polish later if Niki dispatches it.
 *
 * Does NOT make the app the default SMS/Phone handler. Read/display only.
 */
class SyncedDataActivity : AppCompatActivity() {

    private enum class Tab { MESSAGES, CALLS }

    private var currentTab = Tab.MESSAGES

    private lateinit var tabMessages: Button
    private lateinit var tabCalls: Button
    private lateinit var permissionPane: LinearLayout
    private lateinit var permissionText: TextView
    private lateinit var grantButton: Button
    private lateinit var scrollView: ScrollView
    private lateinit var listContainer: LinearLayout
    private lateinit var emptyText: TextView

    private val smsHandler by lazy { SmsHandler(this) }
    private val callLogsHandler by lazy { CallLogsHandler(this) }

    companion object {
        private const val REQ_SMS = 7301
        private const val REQ_CALL_LOG = 7302
        // Cap the on-device preview so an enormous inbox/log doesn't build
        // thousands of views on the main thread. The reviewer only needs to
        // SEE the data — a recent slice is plenty to demonstrate the perm.
        private const val PREVIEW_LIMIT = 200
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_synced_data)

        // API 36 (Android 16) edge-to-edge is ENFORCED with no opt-out
        // (windowOptOutEdgeToEdgeEnforcement is ignored at targetSdk 36).
        // Without this the header wordmark clips under the status bar and the
        // bottom-most list row / empty-state clips under the gesture nav bar.
        // Mirror MainActivity / SignInActivity (v29 work): let the opaque
        // surface_base windowBackground fill behind the bars and pad the root
        // vertical stack by systemBars()+displayCutout(). syncedRoot is the
        // full-bleed container holding header, tabs, scroll list and empty
        // state, so padding it insets every child correctly.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        InsetsUtils.applySystemBarInsets(findViewById(R.id.syncedRoot))

        tabMessages = findViewById(R.id.tabMessages)
        tabCalls = findViewById(R.id.tabCalls)
        permissionPane = findViewById(R.id.syncedPermissionPane)
        permissionText = findViewById(R.id.syncedPermissionText)
        grantButton = findViewById(R.id.syncedGrantButton)
        scrollView = findViewById(R.id.syncedScroll)
        listContainer = findViewById(R.id.syncedListContainer)
        emptyText = findViewById(R.id.syncedEmptyText)

        findViewById<Button>(R.id.syncedBackButton).setOnClickListener { finish() }

        tabMessages.setOnClickListener { switchTab(Tab.MESSAGES) }
        tabCalls.setOnClickListener { switchTab(Tab.CALLS) }

        grantButton.setOnClickListener { requestPermissionForCurrentTab() }

        // Initial tab can be overridden by the launching Intent so MainActivity
        // can deep-link "Call history" straight to the calls tab.
        currentTab = if (intent?.getStringExtra("tab") == "calls") Tab.CALLS else Tab.MESSAGES
        render()
    }

    override fun onResume() {
        super.onResume()
        // Re-render on resume so that a permission granted via the system
        // settings screen (or revoked in the background) is reflected.
        render()
    }

    private fun switchTab(tab: Tab) {
        if (currentTab == tab) return
        currentTab = tab
        render()
    }

    // ---- permission helpers (self-contained; no dependency on PermissionChecker
    //      internals so this screen stands alone) ----

    private fun permissionForTab(tab: Tab): String = when (tab) {
        Tab.MESSAGES -> Manifest.permission.READ_SMS
        Tab.CALLS -> Manifest.permission.READ_CALL_LOG
    }

    private fun isGranted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    private fun requestPermissionForCurrentTab() {
        when (currentTab) {
            Tab.MESSAGES -> ActivityCompat.requestPermissions(
                this, arrayOf(Manifest.permission.READ_SMS), REQ_SMS
            )
            Tab.CALLS -> ActivityCompat.requestPermissions(
                this, arrayOf(Manifest.permission.READ_CALL_LOG), REQ_CALL_LOG
            )
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // Whatever the outcome, re-render: granted → list populates (the
        // money shot for the reviewer's video); denied → empty/permission
        // pane stays, no crash.
        render()
    }

    // ---- rendering ----

    private fun render() {
        paintTabBar()

        val granted = isGranted(permissionForTab(currentTab))
        if (!granted) {
            showPermissionPane()
            return
        }
        showList()
    }

    private fun paintTabBar() {
        val active = R.drawable.bg_button_primary
        val inactive = R.drawable.bg_button_ghost
        val activeColor = ContextCompat.getColor(this, R.color.text_primary)
        val inactiveColor = ContextCompat.getColor(this, R.color.text_secondary)

        if (currentTab == Tab.MESSAGES) {
            tabMessages.setBackgroundResource(active)
            tabMessages.setTextColor(activeColor)
            tabCalls.setBackgroundResource(inactive)
            tabCalls.setTextColor(inactiveColor)
        } else {
            tabCalls.setBackgroundResource(active)
            tabCalls.setTextColor(activeColor)
            tabMessages.setBackgroundResource(inactive)
            tabMessages.setTextColor(inactiveColor)
        }
    }

    private fun showPermissionPane() {
        scrollView.visibility = View.GONE
        emptyText.visibility = View.GONE
        permissionPane.visibility = View.VISIBLE
        permissionText.setText(
            if (currentTab == Tab.MESSAGES) R.string.synced_perm_messages
            else R.string.synced_perm_calls
        )
    }

    private fun showList() {
        permissionPane.visibility = View.GONE
        listContainer.removeAllViews()

        val rows: List<View> = try {
            when (currentTab) {
                Tab.MESSAGES -> smsHandler
                    .getMessages(limit = PREVIEW_LIMIT)
                    .map { buildMessageRow(it) }
                Tab.CALLS -> callLogsHandler
                    .getCallLogs(limit = PREVIEW_LIMIT)
                    .map { buildCallRow(it) }
            }
        } catch (e: SecurityException) {
            // Perm revoked between the check and the query.
            android.util.Log.w("SyncedDataActivity", "read denied: ${e.message}")
            emptyList()
        } catch (e: Exception) {
            // A provider read can throw (e.g. perm revoked between the check
            // and the query, or an OEM provider quirk). Degrade to empty
            // state rather than crash the reviewer's session.
            android.util.Log.w("SyncedDataActivity", "read failed: ${e.message}")
            emptyList()
        }

        if (rows.isEmpty()) {
            scrollView.visibility = View.GONE
            emptyText.visibility = View.VISIBLE
            emptyText.setText(
                if (currentTab == Tab.MESSAGES) R.string.synced_empty_messages
                else R.string.synced_empty_calls
            )
            return
        }

        emptyText.visibility = View.GONE
        scrollView.visibility = View.VISIBLE
        for (row in rows) listContainer.addView(row)
    }

    // ---- row builders (programmatic; mirror the synced data shape) ----

    private fun formatWhen(epochMs: Long): String =
        DateUtils.getRelativeTimeSpanString(
            epochMs,
            System.currentTimeMillis(),
            DateUtils.MINUTE_IN_MILLIS,
            DateUtils.FORMAT_ABBREV_RELATIVE
        ).toString()

    private fun buildMessageRow(msg: SmsMessage): View {
        // direction prefix proves both inbound (RECEIVE_SMS/READ_SMS) and
        // outbound (sent) rows are read from content://sms.
        val direction = if (msg.type == "sent") getString(R.string.synced_dir_sent)
        else getString(R.string.synced_dir_received)
        val who = if (msg.address.isBlank()) getString(R.string.synced_unknown) else msg.address
        val body = if (msg.body.isBlank() && msg.thumbnail != null)
            getString(R.string.synced_image_message) else msg.body
        return buildRow(
            primary = "$direction  $who",
            secondary = body,
            meta = formatWhen(msg.date)
        )
    }

    private fun buildCallRow(call: CallLogEntry): View {
        val typeLabel = when (call.type) {
            "incoming" -> getString(R.string.synced_call_incoming)
            "outgoing" -> getString(R.string.synced_call_outgoing)
            "missed" -> getString(R.string.synced_call_missed)
            else -> call.type
        }
        val who = call.name?.takeIf { it.isNotBlank() }
            ?: call.number.takeIf { it.isNotBlank() }
            ?: getString(R.string.synced_unknown)
        val durationLine = if (call.duration > 0)
            getString(R.string.synced_call_duration, formatDuration(call.duration)) else ""
        return buildRow(
            primary = "$typeLabel  $who",
            secondary = durationLine,
            meta = formatWhen(call.date)
        )
    }

    private fun formatDuration(seconds: Int): String {
        val m = seconds / 60
        val s = seconds % 60
        return if (m > 0) "${m}m ${s}s" else "${s}s"
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun buildRow(primary: String, secondary: String, meta: String): View {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.bottomMargin = dp(14)
            layoutParams = lp
        }

        val titleRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
        }
        val titleView = TextView(this).apply {
            text = primary
            setTextColor(ContextCompat.getColor(this@SyncedDataActivity, R.color.text_primary))
            textSize = 15f
            typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        val metaView = TextView(this).apply {
            text = meta
            setTextColor(ContextCompat.getColor(this@SyncedDataActivity, R.color.text_tertiary))
            textSize = 12f
            gravity = Gravity.END
        }
        titleRow.addView(titleView)
        titleRow.addView(metaView)

        val bodyView = TextView(this).apply {
            text = secondary
            setTextColor(ContextCompat.getColor(this@SyncedDataActivity, R.color.text_secondary))
            textSize = 14f
            maxLines = 2
            ellipsize = android.text.TextUtils.TruncateAt.END
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            )
            lp.topMargin = dp(2)
            layoutParams = lp
        }

        val divider = View(this).apply {
            setBackgroundColor(ContextCompat.getColor(this@SyncedDataActivity, R.color.surface_border))
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(1)
            )
            lp.topMargin = dp(12)
            layoutParams = lp
        }

        container.addView(titleRow)
        if (secondary.isNotBlank()) container.addView(bodyView)
        container.addView(divider)
        return container
    }
}
