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
 * ## Rule 2 — the switch resets the connection (vc69 account pref)
 *
 * A confirmed flip sends SET_E2E_PREF; the relay saves it and resets the room,
 * so the pair re-forms under the new mode. The mode of a live pair is still
 * latched at Accept (E2E-SPEC-v1.0 §13.1) — the reset is what moves it.
 *
 * ## Rule 3 — the live pair's mode sits next to the switch
 *
 * [livePairMode] is the honest-state input. When a pair is active the reason
 * line leads with what that pair ACTUALLY is; while a flip is reconnecting
 * ([switching]) it says "Switching… reconnecting". Null means "no active
 * pair", and then the line is the capability copy Settings has always shown.
 * vc70 item 10: the vc63 "The switch applies to your next connection" caveat
 * is gone — since the vc69 reset it was false.
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

    /**
     * vc70 item 10 — a flip made during a pair is reconnecting
     * ([PhoneConnStatus.Label.SWITCHING]). Home only; Settings leaves it false.
     */
    var switching: Boolean = false

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
            // vc69 (T-E2E-ACCOUNT-PREF): the switch is the ACCOUNT value. A tap
            // is a request, not a write: snap back to the stored value and ask
            // first (design §8). The switch moves when the server's E2E_PREF
            // confirms it. The legacy local store is read-only from vc69 on.
            refresh()
            confirmAndSet(isChecked, onChanged)
        }
    }

    /** §8: confirm dialog -> SET_E2E_PREF (through the controller), or nothing. */
    private fun confirmAndSet(on: Boolean, onChanged: (Boolean) -> Unit) {
        val activity = ctx as? android.app.Activity ?: return
        android.app.AlertDialog.Builder(activity)
            .setTitle(if (on) R.string.e2e_pref_confirm_on_title else R.string.e2e_pref_confirm_off_title)
            .setMessage(if (on) R.string.e2e_pref_confirm_on_body else R.string.e2e_pref_confirm_off_body)
            .setNegativeButton(R.string.e2e_pref_cancel, null)
            .setPositiveButton(
                if (on) R.string.e2e_pref_confirm_on_action else R.string.e2e_pref_confirm_off_action,
            ) { _, _ ->
                when (E2eAccountPrefController.requestSet(ctx, on)) {
                    E2eAccountPrefController.Result.SENT -> {
                        val line = afterFlipText(on)
                        reason.text = line
                        applyA11y(line)
                        // A change to a node that is not focused is not announced.
                        toggle.announceForAccessibility(line)
                        onChanged(on)
                    }
                    E2eAccountPrefController.Result.OFFLINE -> toast(R.string.e2e_pref_offline)
                    else -> toast(R.string.e2e_pref_toast_failed)
                }
            }
            .show()
    }

    private fun toast(res: Int) {
        android.widget.Toast.makeText(ctx, res, android.widget.Toast.LENGTH_LONG).show()
    }

    /**
     * Repaint the whole row from the ACCOUNT value (vc69) and the capability
     * provider. Checked = the account preference (the last push); before any
     * push, what this phone advertises. Enabled = the relay is open (writes go
     * over the socket, no offline writes, §8) and this phone can do e2e at all.
     */
    fun refresh() {
        val st = E2eAccountPrefController.state(ctx)
        val mirror = st?.mirror
        val checked = mirror?.preference ?: E2eAccountPrefController.advertisedOn(ctx)
        val capability = E2ePeerCapability.current(ctx)
        val copy = E2eModeRowCopy.forState(capability, checked)
        val online = E2eAccountPrefController.isOnline()
        val enabled = online && st != null &&
            capability != E2ePeerCapability.State.DEVICE_UNSUPPORTED
        val alpha = if (enabled) E2eModeRowCopy.FULL_ALPHA else E2eModeRowCopy.DIMMED_ALPHA
        toggle.isEnabled = enabled
        suppressCallback = true
        toggle.isChecked = checked
        suppressCallback = false

        title?.alpha = alpha
        sub?.alpha = alpha
        toggle.alpha = alpha

        val line = reasonText(copy, enabled, online, st)
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
    private fun reasonText(
        copy: E2eModeRowCopy.RowCopy,
        enabled: Boolean,
        online: Boolean,
        st: E2eAccountPref.State?,
    ): String {
        val live = livePairMode
        val parts = ArrayList<String>(6)
        if (switching) {
            parts.add(ctx.getString(R.string.home_e2e_now_switching))
        } else if (live != null) {
            parts.add(ctx.getString(E2eModeRowCopy.liveModeLine(live)))
        }
        val mirror = st?.mirror
        // vc69: "On, paused by ComputerCaller", never a plain "Off" (design §3).
        if (mirror?.pausedByServer == true) parts.add(ctx.getString(R.string.e2e_pref_paused))
        // B1: the account says lower, this phone has not agreed yet.
        if (st?.pendingDowngrade != null) parts.add(ctx.getString(R.string.e2e_pref_latched_line))
        if (!online) parts.add(ctx.getString(R.string.e2e_pref_offline))
        if ((live == null && !switching) || !enabled) parts.add(ctx.getString(copy.reasonRes))
        // INC-0924. Appended AFTER the capability reason, never instead of it:
        // an ON value on an inoperable control is said in words.
        if (!enabled && copy.checked) {
            parts.add(ctx.getString(R.string.settings_encrypted_mode_on_while_disabled))
        }
        mirror?.let { m -> E2eAccountPrefCopy.changedByLine(ctx, m)?.let { parts.add(it) } }
        return parts.joinToString(" ")
    }

    /**
     * What the row says right after a flip. While a pair is live the live
     * fact stays on screen: the user just changed something, and dropping
     * "this connection is not encrypted" at that exact moment is how a user
     * concludes the flip encrypted the session they are in.
     */
    private fun afterFlipText(checked: Boolean): String {
        // vc70 item 10: a flip during a pair resets it, so the line is the
        // transient, not a promise about "your next connection".
        if (livePairMode != null) return ctx.getString(R.string.home_e2e_now_switching)
        return ctx.getString(E2eModeRowCopy.afterFlipLine(checked))
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
