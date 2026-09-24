package com.dnkdialer.companion

import android.content.Context
import android.content.res.ColorStateList
import android.view.LayoutInflater
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat

/**
 * vc65, T-ANDROID-PERMISSIONS-SCREEN — the painter for the permission
 * checklist, shared by the first-run pane and the Settings > Permissions
 * screen.
 *
 * This is [MainActivity.renderChecklist] lifted verbatim. It was correct
 * where it was; it was simply in the only place that could use it, and
 * Dennis asked for the same row of permissions in Settings. A second
 * copy would be a second status→colour table to keep in step.
 *
 * Tint mapping (the status-dot vocabulary used elsewhere in the app —
 * emerald = healthy, red = blocker, amber = warning):
 *   GRANTED          → dot_live    (✓ green)
 *   MISSING_REQUIRED → dot_failed  (✗ red)
 *   MISSING_SOFT     → dot_waiting (⚠ amber)
 *
 * The one thing the two callers do differently is the tap target, so
 * that — and only that — is a parameter:
 *
 *  - [onRowTap] null (first-run): a row is clickable only when the item
 *    carries an Intent, which [PermissionChecker] leaves null for
 *    GRANTED rows. Tapping starts that Intent. This is byte-for-byte
 *    the behaviour MainActivity had before the extraction.
 *  - [onRowTap] non-null (Settings > Permissions): EVERY row is
 *    clickable, granted or not, and the callback decides where it goes
 *    ([PermissionDeepLinks]). Dennis's ask is that any row opens its
 *    setting — including the ones already allowed, which is exactly
 *    when you want to go look at them.
 */
object PermissionRows {

    fun bind(
        context: Context,
        container: LinearLayout,
        items: List<PermissionChecker.PermissionStatusItem>,
        onRowTap: ((PermissionChecker.PermissionStatusItem) -> Unit)? = null,
    ) {
        container.removeAllViews()
        val inflater = LayoutInflater.from(context)
        for (item in items) {
            val row = inflater.inflate(R.layout.item_permission_status, container, false)
            row.findViewById<TextView>(R.id.permTitle).text = item.displayName
            row.findViewById<TextView>(R.id.permWhy).text = item.why

            val (colorRes, badgeRes) = when (item.status) {
                PermissionChecker.Status.GRANTED ->
                    R.color.dot_live to R.string.perm_status_granted
                PermissionChecker.Status.MISSING_REQUIRED ->
                    R.color.dot_failed to R.string.perm_status_missing_required
                PermissionChecker.Status.MISSING_SOFT ->
                    R.color.dot_waiting to R.string.perm_status_missing_soft
            }
            val color = ContextCompat.getColor(context, colorRes)
            row.findViewById<View>(R.id.permStatusIcon).backgroundTintList =
                ColorStateList.valueOf(color)
            val badge: TextView = row.findViewById(R.id.permStatusBadge)
            badge.text = context.getString(badgeRes)
            badge.setTextColor(color)

            if (onRowTap != null) {
                // Settings > Permissions: every row is a door.
                row.contentDescription = "${item.displayName}, ${context.getString(badgeRes)}"
                row.setOnClickListener { onRowTap(item) }
            } else {
                // First-run: tap a MISSING row to deep-link straight into
                // the relevant grant surface. Granted rows are
                // non-interactive. Helpful for the user who wants to fix
                // just one thing instead of running the full Grant All flow.
                val tapTarget = item.intent
                if (tapTarget != null) {
                    row.setOnClickListener {
                        try {
                            context.startActivity(tapTarget)
                        } catch (e: Exception) {
                            android.util.Log.w(
                                "PermissionRows",
                                "Per-row tap intent failed for ${item.id}: ${e.message}"
                            )
                        }
                    }
                } else {
                    row.setOnClickListener(null)
                    row.isClickable = false
                }
            }

            container.addView(row)
        }
    }
}
