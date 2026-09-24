package com.dnkdialer.companion

import android.content.Context
import android.widget.TextView
import com.google.android.material.switchmaterial.SwitchMaterial

/**
 * vc63 (T-VC63-MAIN-SCREEN) — the one painter for the "Encrypted mode" row,
 * shared by [SettingsActivity] and [MainActivity].
 *
 * Dennis, 2026-09-23: "shouldn't have to go into settings in the android
 * app." Putting the control on Home means the same row now exists twice, and
 * the failure mode of a duplicated control is not that it looks different —
 * it is that the two halves disagree about the same stored fact. So there is
 * exactly one painter, over exactly one preference ([E2eSettings]), with
 * exactly one copy table ([E2eModeRowCopy]). Flip on Home, open Settings: the
 * same state, because there is nothing that could be out of sync.
 *
 * What this class owns and the copy table does not: the repaint guard. Both
 * screens repaint in `onResume`, assigning `isChecked` fires the listener,
 * and a repaint read as a tap would rewrite the preference every time the
 * user merely looked at the screen. [suppressCallback] is the same guard
 * SettingsActivity carried before this refactor, moved in with the painter so
 * a third caller cannot forget it.
 *
 * ## Rule 2 — no new pairing behaviour
 *
 * Flipping persists the preference and says it applies to the next
 * connection. It does NOT disconnect, re-pair, or raise a SAS: the mode of a
 * live pair is latched at Accept (E2E-SPEC-v1.0 §13.1) and a mode that could
 * flip mid-pair would be a downgrade channel. That is today's Settings
 * behaviour, unchanged.
 *
 * ## Rule 3 — the live pair's mode sits next to the switch
 *
 * [livePairMode] is the honest-state input. When a pair is active the reason
 * line leads with what that pair ACTUALLY is, and adds the next-connection
 * caveat whenever the switch disagrees with it. Null means "no active pair",
 * and then the line is the capability copy Settings has always shown.
 *
 * @param title  dimmed with the row; may be null where the caller has no
 *               separate title view.
 */
class E2eModeRowBinder(
    private val ctx: Context,
    private val toggle: SwitchMaterial,
    private val title: TextView?,
    private val sub: TextView?,
    private val reason: TextView,
) {

    /**
     * The live pair's effective mode, or null when nothing is paired.
     *
     * Settings leaves this null: it has no bound PhoneService and therefore
     * no honest answer, and inventing one there would be the INC-0923 mistake
     * in the other direction. Home sets it from the same `e2eState` the
     * status line is painted from, on the same tick, so the two can never
     * disagree.
     */
    var livePairMode: E2eStatusCopy.State? = null

    /** Guards [toggle] so a repaint from the store cannot be read as a tap. */
    private var suppressCallback = false

    /**
     * Install the listener. [onChanged] runs AFTER the preference is written
     * and the row repainted, for callers that want to log or announce more.
     *
     * A disabled SwitchMaterial does not deliver onCheckedChanged, so the
     * "an inoperable switch never stores a preference" guarantee is the
     * platform's rather than this class's.
     */
    fun bind(onChanged: (Boolean) -> Unit = {}) {
        toggle.setOnCheckedChangeListener { _, isChecked ->
            if (suppressCallback) return@setOnCheckedChangeListener
            E2eSettings.setEncryptedModeEnabled(ctx, isChecked)
            val line = afterFlipText(isChecked)
            reason.text = line
            applyA11y(line)
            // A change to a node that is not focused is not announced, so a
            // TalkBack user would otherwise hear "on" and never learn that
            // "on" applies to the next connection rather than this one.
            toggle.announceForAccessibility(line)
            onChanged(isChecked)
        }
    }

    /** Repaint the whole row from the store and the capability provider. */
    fun refresh() {
        val copy = E2eModeRowCopy.forState(
            E2ePeerCapability.current(ctx),
            E2eSettings.isEncryptedModeEnabled(ctx),
        )
        toggle.isEnabled = copy.enabled
        suppressCallback = true
        toggle.isChecked = copy.checked
        suppressCallback = false

        title?.alpha = copy.alpha
        sub?.alpha = copy.alpha
        toggle.alpha = copy.alpha

        val line = reasonText(copy)
        reason.text = line
        applyA11y(line)
    }

    /**
     * The reason line.
     *
     * Order matters: the live fact first, because "what is my connection
     * right now" is the question the switch's presence provokes, and the
     * caveat last, because it qualifies everything before it.
     *
     * A disabled row ALWAYS carries its capability reason — a greyed control
     * with no explanation is the thing users file bugs about — so the
     * capability copy is appended even while paired.
     */
    private fun reasonText(copy: E2eModeRowCopy.RowCopy): String {
        val live = livePairMode
        val parts = ArrayList<String>(3)
        if (live != null) parts.add(ctx.getString(E2eModeRowCopy.liveModeLine(live)))
        if (live == null || !copy.enabled) parts.add(ctx.getString(copy.reasonRes))
        // INC-0924. Appended AFTER the capability reason, never instead of it:
        // "your computer is too old" is why the control is grey, and "it is on
        // and will apply when you pair" is what the grey ON state means. A user
        // who is shown only the second has no idea why they cannot change it.
        copy.onWhileDisabledRes?.let { parts.add(ctx.getString(it)) }
        if (live != null && copy.enabled &&
            !E2eModeRowCopy.switchAgreesWithLiveMode(copy.checked, live)
        ) {
            parts.add(ctx.getString(R.string.home_e2e_next_only))
        }
        return parts.joinToString(" ")
    }

    /**
     * What the row says right after a flip. While a pair is live the live
     * fact stays on screen: the user just changed something, and dropping
     * "this connection is not encrypted" at that exact moment is how a user
     * concludes the flip encrypted the session they are in.
     */
    private fun afterFlipText(checked: Boolean): String {
        val live = livePairMode
        val flip = ctx.getString(E2eModeRowCopy.afterFlipLine(checked))
        return if (live == null) flip else {
            ctx.getString(E2eModeRowCopy.liveModeLine(live)) + " " + flip
        }
    }

    /**
     * TalkBack reads a switch as "Encrypted mode, off. Switch." and stops. On
     * a disabled switch that is actively misleading, and the reason line is a
     * separate node the user may never reach. Fold the reason into the
     * switch's own description so the control explains itself wherever focus
     * lands.
     */
    private fun applyA11y(line: String) {
        toggle.contentDescription = ctx.getString(
            R.string.settings_encrypted_mode_a11y,
            ctx.getString(R.string.row_encrypted_mode_title),
            line,
        )
    }
}
