package com.dnkdialer.companion

import android.view.View
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding

/**
 * Edge-to-edge insets helper (API 35 / Android 15 target bump, v29).
 *
 * On API 35 edge-to-edge is ENFORCED: the system stops drawing
 * status-bar/nav-bar backgrounds and android:statusBarColor /
 * android:navigationBarColor (themes.xml) are ignored. Activity content
 * therefore draws under the system bars. Without insets handling the
 * wordmark clips under the status bar and the bottom-most action clips
 * under the gesture nav bar.
 *
 * [applySystemBarInsets] attaches an androidx.core insets listener that
 * pads [contentView] by the union of systemBars() (status + nav) and
 * displayCutout() (notch / punch-hole, for landscape + cutout devices).
 * It captures the view's *original* design-time padding once and always
 * adds the insets on top of that, so re-dispatched insets never compound.
 *
 * Pair this with WindowCompat.setDecorFitsSystemWindows(window, false) in
 * the Activity right after setContentView. The opaque windowBackground
 * (bg_app_solid = @color/surface_base) keeps filling behind the bars, so
 * there is no white gap — only the content gets inset.
 *
 * Behaviour is correct on API 35 AND non-regressing on minSdk 26–34:
 * pre-35 the listener simply resolves to the (then-visible) bar heights,
 * which is what fitsSystemWindows would have applied anyway.
 */
object InsetsUtils {

    fun applySystemBarInsets(contentView: View) {
        // Snapshot the design-time padding so repeated inset dispatches
        // (rotation, IME show/hide, multi-window resize) stay idempotent.
        val basePaddingLeft = contentView.paddingLeft
        val basePaddingTop = contentView.paddingTop
        val basePaddingRight = contentView.paddingRight
        val basePaddingBottom = contentView.paddingBottom

        ViewCompat.setOnApplyWindowInsetsListener(contentView) { view, windowInsets ->
            val bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout()
            )
            view.updatePadding(
                left = basePaddingLeft + bars.left,
                top = basePaddingTop + bars.top,
                right = basePaddingRight + bars.right,
                bottom = basePaddingBottom + bars.bottom
            )
            // Return the unconsumed insets so any nested listeners still see
            // them; nothing else in these single-pane layouts consumes them.
            windowInsets
        }

        // Request a dispatch in case the view is already attached (e.g. a
        // setContentView swap on an already-resumed Activity, as MainActivity
        // does when toggling between the main and permissions panes).
        ViewCompat.requestApplyInsets(contentView)
    }
}
