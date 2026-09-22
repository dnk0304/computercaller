'use client';

import React, { useEffect, useId, useState, useSyncExternalStore } from 'react';
import {
  Smartphone,
  XCircle,
  X,
  MessageSquare,
  Bell,
  ShieldX,
  Plug,
  RotateCw,
  Clock,
  Unlink,
} from 'lucide-react';
import { usePhone } from '@/hooks';
import type { LobbyState, LobbyRejectedReason } from '@/lib/lobbyState';
import { isTrustedShellMessage } from '@/lib/extensionBridge';
import {
  batteryFill,
  batteryView,
  newerBattery,
  type BatteryValue,
  type BatteryView,
} from '@/lib/batteryCopy';

/**
 * Connection / lobby pill.
 *
 * Dispatch 2026-05-25 (Connect+Accept pivot): the bridge is now a state
 * machine surfaced as `lobbyState` from usePhoneBridge. This component is
 * a pure render of that state machine — no local connection state, no
 * IP input, no retry timers. Two actions only: requestPairing() to ask
 * the phone to pair, and leaveActive() to drop the session.
 *
 * State machine spec lives in lib/lobbyState.ts.
 */
interface ConnectionStatusProps {
  /**
   * 'default' — the full multi-line pill the dashboard header uses. Unchanged.
   * 'compact' — a single 24px row for the extension header (dispatch PIXEL-B2 /
   *   AC-1). Dennis: the device chip wrapped to three lines and overflowed at
   *   100% zoom. The compact variant is capped at 210px, truncates the device
   *   name with an ellipsis and NEVER wraps; Disconnect collapses from a
   *   full-size button to a 16px ✕ inside the pill.
   *
   * Passing nothing keeps /app byte-identical — that is deliberate, and is why
   * this is a variant rather than a restyle.
   */
  variant?: 'default' | 'compact';
}

export const ConnectionStatus = ({ variant = 'default' }: ConnectionStatusProps = {}) => {
  const phone = usePhone();

  // Defensive destructuring — Forge owns hooks/usePhoneBridge.ts and is
  // adding the new lobby surface in parallel. Once Forge's commit lands, the
  // `(phone as ...)` cast and the optional chains below can tighten. Until
  // then, the cast keeps us off the integration-blocking error path: this
  // file builds against a clean spec, and tsc will only complain on the
  // brief field that Forge hasn't shipped yet.
  const {
    // New lobby-state surface (Forge dispatch, parallel)
    lobbyState,
    phonePresentInLobby,
    lastBrowserRequest,
    requestPairing,
    leaveActive,
    // Dispatch FORGE-J (2026-09-15) — "Reset lobby".
    resetRoom,
    // E2E-P2.3 (b) — "Forget this computer". A REVOCATION, unlike resetRoom.
    forgetThisComputer,
    // FORGE-U's auto-sync in-flight flag (PIXEL-S2 (c)). Already exposed by
    // hooks/usePhoneBridge.ts as `quietSyncing` — "the auto-connect quicksync
    // is running, show the quiet banner, not the modal". No new selector and no
    // hook logic change: this component only READS it.
    quietSyncing,
    // Existing fields kept for the notification-permission banner
    isConnected,
    phoneName,
    // BAT-2 (c) — `{pct,charging,ts} | null`. Kept on disconnect so the header
    // can say "last seen"; nulled on unpair. Read-only here.
    battery,
    notificationPermissionGranted,
    requestNotificationAccess,
  } = phone as ReturnType<typeof usePhone> & {
    lobbyState?: LobbyState;
    phonePresentInLobby?: boolean;
    quietSyncing?: boolean;
    lastBrowserRequest?: {
      ua?: string;
      ip?: string;
      // Dispatch FORGE-1 — friendly browser label shown in APK Accept dialog.
      deviceLabel?: string;
      expiresAt?: number;
      reason?: LobbyRejectedReason;
      reasonText?: string;
    } | null;
    requestPairing?: () => void;
    leaveActive?: () => void;
    resetRoom?: () => void | Promise<void>;
    forgetThisComputer?: () => Promise<void>;
    notificationPermissionGranted?: boolean | null;
    requestNotificationAccess?: () => void;
  };

  // Default to 'lobby' if the hook hasn't shipped the field yet — render the
  // most conservative branch (waiting / Connect-disabled) instead of crashing.
  const state: LobbyState = lobbyState ?? 'lobby';

  // ---------- Phone battery (BAT-3) ----------
  // TWO sources, ONE decision. On the web there is only the hook. Inside the
  // extension the shell also hands over what the service worker persisted in
  // storage.session, which is the only value a just-opened popup has before the
  // phone's next send. newerBattery() picks by `ts` and never merges fields.
  const shellBattery = useShellBattery();
  const shownBattery = newerBattery(battery ?? null, shellBattery);
  // "Present" for the battery means the phone is IN the session — the one state
  // in which the reading describes a live device. `lobby + phone nearby` is a
  // phone we are not paired with, and its last known level is history.
  const batteryPresent = state === 'active';
  const now = useStalenessClock(!!shownBattery && batteryPresent);
  const batteryView_ = batteryView(shownBattery, batteryPresent, now ?? shownBattery?.ts ?? 0);

  // ---------- Reset lobby (dispatch FORGE-J, 2026-09-15) ----------
  // Confirmed because it is genuinely destructive to the CURRENT session: it
  // drops the phone's socket too, and the phone is ~5 s away from coming back.
  // A user who meant "Disconnect" and hit this instead should get the chance to
  // say no. window.confirm rather than a modal is deliberate — this control
  // also renders inside the extension's 24px header where a modal has nowhere
  // to go, and the one-liner IS the whole message.
  const handleReset = () => {
    if (!resetRoom) return;
    const ok =
      typeof window === 'undefined' ||
      window.confirm(
        'Kicks your phone and this computer off; the phone re-joins by itself in a few seconds.',
      );
    if (!ok) return;
    void resetRoom();
  };
  // The hook ships resetRoom unconditionally, so this is always live. The
  // `if (!resetRoom) return` inside handleReset is the belt-and-braces for a
  // stale hook build; it is not a rendering condition (TS correctly points out
  // a function-valued field is always truthy).
  const onReset = handleReset;

  // ---------- Forget this computer (E2E-P2.3 (b), F1 / M-A5-1 (a)) ----------
  // Sits BESIDE Reset lobby and is deliberately a different act. Reset is a
  // TRANSPORT reset — Dennis's words, "empty the lobby so the phone re-joins" —
  // and it KEEPS the pair, which is why it cannot double as the revoke control
  // no matter how convenient that would be. Forget drops this computer's
  // session key, resets the room, and revokes this browser's own DeviceKey row
  // on the server, so the phone has to pair again from scratch.
  //
  // window.confirm for the same reason Reset uses it: this control also renders
  // inside the extension's 24px header, where a modal has nowhere to go.
  const handleForget = () => {
    if (!forgetThisComputer) return;
    const ok =
      typeof window === 'undefined' ||
      window.confirm(
        'Forgets this pairing on this computer; the phone will ask you to pair again.',
      );
    if (!ok) return;
    void forgetThisComputer();
  };
  const onForget = handleForget;

  // ---------- Notification-access banner ----------
  // Render-time gate: only show when (a) connected, (b) phone has explicitly
  // reported permission as missing (null = unknown, true = granted), and (c)
  // the user hasn't dismissed this session. No effect needed to "auto-hide on
  // granted" — flipping granted to true makes the condition fall to false on
  // the next render naturally.
  const [notifBannerDismissed, setNotifBannerDismissed] = useState(false);

  const notificationBanner =
    isConnected && notificationPermissionGranted === false && !notifBannerDismissed ? (
      <div className="fixed top-16 left-1/2 -translate-x-1/2 z-[90] w-[min(560px,calc(100%-1.5rem))]">
        <div className="flex items-start gap-3 px-4 py-3 bg-blue-50 border border-blue-200 rounded-2xl shadow-md">
          <MessageSquare className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-blue-900">Enable RCS &amp; notification sync</p>
            <p className="text-xs text-blue-700 mt-0.5">
              Grant notification access to receive RCS and Google Messages in real time.
            </p>
          </div>
          <button
            onClick={() => requestNotificationAccess?.()}
            className="flex-shrink-0 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors"
          >
            Enable on phone
          </button>
          <button
            onClick={() => setNotifBannerDismissed(true)}
            aria-label="Dismiss"
            className="flex-shrink-0 p-1 text-blue-400 hover:text-blue-600 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    ) : null;

  // ---------- Compact branch (extension header) ----------
  // One row, one pill, one glance. The DOT alone must carry the state — that
  // is the "legible without reading" test, and it is why the dot colour and
  // the word are independent signals rather than the word being the only one.
  if (variant === 'compact') {
    return (
      <>
        {notificationBanner}
        <CompactDevicePill
          state={state}
          syncing={!!quietSyncing}
          phoneName={phoneName}
          battery={batteryView_}
          phonePresent={!!phonePresentInLobby}
          reasonText={lastBrowserRequest?.reasonText}
          onDisconnect={() => leaveActive?.()}
          onConnect={() => requestPairing?.()}
          onReset={onReset}
          onForget={onForget}
        />
      </>
    );
  }

  // ---------- Render branches ----------
  return (
    <>
      {notificationBanner}
      {state === 'active' ? (
        <ActivePill
          phoneName={phoneName}
          battery={batteryView_}
          syncing={!!quietSyncing}
          onDisconnect={() => leaveActive?.()}
          onReset={onReset}
          onForget={onForget}
        />
      ) : state === 'requesting' ? (
        <RequestingPill
          expiresAt={lastBrowserRequest?.expiresAt ?? null}
          onCancel={() => leaveActive?.()}
        />
      ) : state === 'declined' ? (
        <DeclinedPill />
      ) : state === 'timeout' ? (
        <TimeoutPill />
      ) : state === 'rejected' ? (
        <RejectedPill
          reason={lastBrowserRequest?.reason}
          reasonText={lastBrowserRequest?.reasonText}
          onRetry={() => requestPairing?.()}
        />
      ) : (
        // lobby — split on phonePresentInLobby
        <LobbyPill
          phonePresent={!!phonePresentInLobby}
          battery={batteryView_}
          onConnect={() => requestPairing?.()}
          onReset={onReset}
          onForget={onForget}
        />
      )}
    </>
  );
};

// ============================================================================
// Sub-components — one per render branch. Co-located because they're each
// ~30 LOC and only used here; pulling them out would lose context, not gain
// reuse.
// ============================================================================

// ============================================================================
// BAT-3 — the phone battery indicator.
//
// ONE component, BOTH surfaces. The extension header is the hosted app's own
// header rendered inside the shell's iframe (PhoneModeHeader surface="extension"
// -> <ConnectionStatus variant="compact" />), so a second implementation for
// the popup / side panel / pop-out would be two things that have to agree about
// a battery level and cannot be made to. What differs between the surfaces is
// not the component, it is where the VALUE comes from — see useShellBattery().
//
// Everything below is DISPLAY-ONLY (GATE1 Addendum BAT-A1 MUST-3 + the BAT-3
// addendum): it renders what BAT-2 validated, guards null/undefined, and never
// writes cc_battery, never re-validates a frame, never touches mode / pairing /
// tier / quota / session.
// ============================================================================

/** The shell's own namespace tag; `NS` in lib/extensionBridge.ts is private. */
const SHELL_NS = 'cc-ext';

/**
 * The battery value the EXTENSION shell restored from chrome.storage.session.
 *
 * Why this exists at all. Inside the extension, the service worker owns the
 * socket and is evicted routinely, so a freshly opened popup or side panel has
 * no live BATTERY frame and would render nothing until the phone's next send —
 * up to ten minutes of a blank slot on a header that showed a value a moment
 * ago. BAT-2 persists `cc_battery` in storage.session for exactly this;
 * shell.js reads it on open, subscribes to storage.onChanged, and posts it in.
 *
 * TRUST: `isTrustedShellMessage` is the existing origin+source pin — framed by
 * our own parent, and that parent is the extension origin. Nothing else can
 * deliver this message. Shape handling stays at null/undefined guards plus the
 * typeof checks needed to not render `NaN%`; the value was validated at the SW
 * chokepoint (isValidBatteryPayload) before it was ever stored.
 *
 * Outside the extension `window.parent === window`, no message ever arrives,
 * and this hook is a permanent `null` — the web app runs on the hook value
 * alone, exactly as it did before BAT-3.
 */
function useShellBattery(): BatteryValue | null {
  const [value, setValue] = useState<BatteryValue | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || window.parent === window) return;

    const onMessage = (event: MessageEvent) => {
      if (!isTrustedShellMessage(event)) return;
      const data = event.data as { source?: string; type?: string; battery?: unknown };
      if (!data || data.source !== SHELL_NS || data.type !== 'battery') return;

      const b = data.battery as { pct?: unknown; charging?: unknown; ts?: unknown } | null;
      // Cleared (sign-out / unpair) arrives as an explicit null, and must clear
      // the UI rather than leave the last value standing.
      if (!b || typeof b !== 'object') {
        setValue(null);
        return;
      }
      const { pct, charging, ts } = b;
      if (typeof pct !== 'number' || typeof charging !== 'boolean' || typeof ts !== 'number') {
        return;
      }
      setValue((prev) => (prev && prev.ts >= ts ? prev : { pct, charging, ts }));
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return value;
}

/**
 * A once-a-minute clock, used for ONE thing: deciding whether the reading has
 * crossed the 15-minute staleness line.
 *
 * useSyncExternalStore rather than useState + useEffect, and not for style: the
 * value is genuinely EXTERNAL state (wall-clock time), the server has no
 * honest answer for it, and React's own rule against seeding state from an
 * effect body is the rule this shape exists to satisfy. `getServerSnapshot`
 * returns null, which batteryView() treats as not-stale — the conservative
 * side, since the alternative is a header that paints "as of 14:32" during
 * hydration and then takes it back.
 *
 * ONE interval for the whole page, refcounted by subscriber, cleared when the
 * last indicator unmounts. A minute is the right granularity: the threshold is
 * fifteen minutes, and a second-resolution timer would re-render the header
 * sixty times for every boundary it could possibly move.
 */
const MINUTE_MS = 60_000;
let minuteNow: number | null = null;
let minuteTimer: ReturnType<typeof setInterval> | null = null;
const minuteSubscribers = new Set<() => void>();

function subscribeMinute(onChange: () => void): () => void {
  minuteSubscribers.add(onChange);
  if (minuteTimer === null) {
    minuteNow = Date.now();
    minuteTimer = setInterval(() => {
      minuteNow = Date.now();
      minuteSubscribers.forEach((fn) => fn());
    }, MINUTE_MS);
  }
  return () => {
    minuteSubscribers.delete(onChange);
    if (minuteSubscribers.size === 0 && minuteTimer !== null) {
      clearInterval(minuteTimer);
      minuteTimer = null;
      minuteNow = null;
    }
  };
}

/** The inactive store: no timer, no clock, and therefore never stale. */
const subscribeNever = () => () => {};
const readMinute = () => minuteNow;
const readNull = () => null;

/** @param active false when there is nothing to age — no timer is started. */
function useStalenessClock(active: boolean): number | null {
  return useSyncExternalStore(
    active ? subscribeMinute : subscribeNever,
    active ? readMinute : readNull,
    readNull,
  );
}

/**
 * The glyph. An inline SVG rather than a lucide icon because the fill has to be
 * PROPORTIONAL — lucide's Battery is a fixed outline, and swapping between its
 * four discrete variants would make 34% and 64% the identical picture.
 *
 * Non-colour signals, in order, so the indicator never relies on hue alone
 * (WCAG 1.4.1):
 *   1. the numeric "%" is real text beside this glyph — the exact value, always;
 *   2. the fill bar's LENGTH is the level;
 *   3. a bolt is drawn through the cell when charging;
 *   4. a mark appears at the empty end at 20% or below.
 * Colour is the fourth signal, never the first.
 *
 * Purely presentational: aria-hidden, because the accessible name lives on the
 * wrapper as one sentence and announcing the picture again would double it.
 *
 * No transition and no animation anywhere in here: the value changes at most
 * once a minute, and a header that animates on every re-render is noise.
 */
function BatteryGlyph({
  pct,
  charging,
  warn,
  className,
}: {
  pct: number;
  charging: boolean;
  /** 20% or below — draws the warning mark. */
  warn: boolean;
  className?: string;
}) {
  const fill = batteryFill(pct);
  const innerW = 12.4 * fill;
  // A mask needs a document-unique id, and this glyph renders more than once
  // per page (header + any surface that mounts a second ConnectionStatus).
  // useId is the only source of one that survives SSR hydration.
  const maskId = `cc-bat-${useId()}`;

  return (
    <svg viewBox="0 0 22 14" className={className} aria-hidden="true" focusable="false">
      {charging && (
        // The bolt is KNOCKED OUT of the level rather than painted over it in a
        // background colour. A knockout drawn in #fff reads correctly in light
        // and becomes a white scar in dark, and this component has no access to
        // the surface it is sitting on — the mask has no such dependency, so
        // the glyph is correct on any background in either theme.
        <mask id={maskId}>
          <rect x="0" y="0" width="22" height="14" fill="#fff" />
          <path
            d="M10.9 2.6 6.4 8.1h2.9l-1.3 3.7 4.8-5.7h-3z"
            fill="#000"
            stroke="#000"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
        </mask>
      )}
      <rect
        x="1"
        y="2"
        width="16.6"
        height="10"
        rx="2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        opacity="0.55"
      />
      <path d="M19.4 5.4v3.2a2 2 0 0 0 0-3.2z" fill="currentColor" opacity="0.55" />
      <rect
        x="2.6"
        y="3.6"
        width={innerW}
        height="6.8"
        rx="1.3"
        fill="currentColor"
        mask={charging ? `url(#${maskId})` : undefined}
      />
      {charging && (
        <path
          d="M10.9 2.6 6.4 8.1h2.9l-1.3 3.7 4.8-5.7h-3z"
          fill="currentColor"
        />
      )}
      {warn && !charging && (
        <path
          d="M14.8 4.4v4.1M14.8 10.1v0.9"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

/**
 * The indicator itself: glyph + "%" as TEXT, beside the phone name.
 *
 * `variant="compact"` is the extension header's 210px pill — the same decisions,
 * less room. The only difference is which string is VISIBLE: compact shows the
 * percentage and puts the full "Last seen 14:32 · 47%" in the tooltip, because
 * the pill is capped and nowrap and that sentence cannot fit beside a device
 * name without pushing the name out (brief (c): the battery must not make the
 * header wrap).
 *
 * Below 400px the "%" text is hidden and the glyph carries it alone, with the
 * value still in the accessible name — the documented collapse, not a fallback.
 *
 * NO aria-live. The value re-renders whenever a frame lands; announcing each
 * one would talk over whatever the user is actually doing. It is a label on a
 * status surface, read when the user arrives at it.
 */
function BatteryIndicator({
  view,
  variant = 'default',
}: {
  view: BatteryView;
  variant?: 'default' | 'compact';
}) {
  // No reading has ever arrived — render NOTHING. Not "--%", not a grey stub.
  if (!view) return null;

  const offline = view.kind === 'lastSeen';
  const warn = view.tone !== 'normal';

  // Colour is the LAST signal, and greys out entirely once the phone is gone:
  // a red "8%" for a phone that left an hour ago is an alarm about a fact
  // nobody can act on.
  const toneClass = offline
    ? 'text-slate-400'
    : view.tone === 'critical'
      ? 'text-red-600'
      : view.tone === 'low'
        ? 'text-amber-600'
        : 'text-slate-500';

  const glyphSize = variant === 'compact' ? 'h-3 w-[19px]' : 'h-3.5 w-[22px]';

  return (
    <span
      className={
        // COMPACT never shrinks: that pill is capped at 210px and the
        // truncating device name is the one elastic thing in the row.
        //
        // DEFAULT does shrink. The first screenshot of the lobby pill caught
        // exactly why: a nowrap, non-shrinking indicator raised the column's
        // minimum width and pushed "Waiting for phone…" into an ellipsis — the
        // battery cannot be allowed to cost the header its primary line
        // (brief (c)). Here the indicator's own text truncates instead, and the
        // value stays whole in the accessible name either way.
        `cc-battery inline-flex items-center gap-1 whitespace-nowrap ${
          variant === 'compact' ? 'flex-shrink-0' : 'min-w-0'
        } ${toneClass}`
      }
      data-cc-battery={String(view.pct)}
      data-cc-battery-tone={view.tone}
      data-cc-battery-kind={view.kind}
      // ONE accessible name for the pair, on the wrapper. The glyph is
      // aria-hidden and the text is aria-hidden inside it, so a screen reader
      // reads this sentence once instead of "battery image, 47 percent".
      role="img"
      aria-label={view.label}
      title={offline ? view.text : view.label}
    >
      <BatteryGlyph pct={view.pct} charging={view.charging} warn={warn} className={glyphSize} />
      <span
        className={
          variant === 'compact'
            ? // The 360px / sub-400px collapse (brief (c)). Hidden, not removed:
              // the value stays in aria-label and title at every width.
              'hidden min-[400px]:inline text-[11px] font-semibold tabular-nums'
            : 'truncate text-xs font-semibold tabular-nums'
        }
        aria-hidden="true"
      >
        {variant === 'compact' ? `${view.pct}%` : view.text}
      </span>
    </span>
  );
}


/**
 * CompactDevicePill — the extension header's whole status surface, in ONE 24px
 * row (Vinci ART-DIRECTION §4.1, Dennis AC-1).
 *
 * Contract this exists to satisfy:
 *   - min-width 0, `truncate` on the name, `whitespace-nowrap` everywhere. A
 *     30-character device name shortens; it never wraps and never pushes the
 *     row wider. That is the actual AC-1 pass condition.
 *   - The 210px cap below is the /app ceiling and stays for /app. On the
 *     EXTENSION it is RELEASED (EXT-UI-4 M7, `cc-conn-pill` in
 *     app/extension/extension.css): the cap was costing 245px @360 / 285px
 *     @400 of header width that nothing else wanted, and starving the device
 *     name below the 8-visible-character floor at every size/width combo. The
 *     pill is the only truncating item in that row either way, so releasing
 *     the cap cannot make anything else overflow — it just stops throwing the
 *     slack away.
 *   - The dot is the primary signal and is never the ONLY signal: every state
 *     also carries a word, and the word is in the accessible name.
 *   - Disconnect is a 16px ✕ INSIDE the pill, not a sibling button that
 *     competes with the pop-out control for the same 20px of header.
 *
 * States → dot / word / trailing:
 *   active + auto-sync in flight
 *              ● emerald † "Syncing…"           ✕ Disconnect  († pulse, motion-safe)
 *   active     ● emerald   "Active"             ✕ Disconnect
 *   requesting ● amber †   "Connecting"         —            († pulse, motion-safe)
 *   lobby      ● slate     "Waiting for phone"  Connect (text button, if present)
 *              ● slate     "Phone nearby"       ← when phonePresent (FORGE-O)
 *   declined / timeout / rejected  ● red  short reason  —
 */
function CompactDevicePill({
  state,
  syncing,
  phoneName,
  battery,
  phonePresent,
  reasonText,
  onDisconnect,
  onConnect,
  onReset,
  onForget,
}: {
  state: LobbyState;
  /** FORGE-U auto-sync in flight. Only meaningful while `state === 'active'`. */
  syncing: boolean;
  phoneName: string | null;
  /** BAT-3. `null` when nothing was ever received — then nothing is rendered. */
  battery: BatteryView;
  phonePresent: boolean;
  reasonText: string | undefined;
  onDisconnect: () => void;
  onConnect: () => void;
  onReset?: () => void;
  onForget?: () => void;
}) {
  const active = state === 'active';
  const connecting = state === 'requesting';
  const failed = state === 'declined' || state === 'timeout' || state === 'rejected';

  // PIXEL-S2 (c): paired is now TWO states, not one. The pill has always said
  // one word for "the phone answered and everything after that", which left the
  // 5-40s the auto-sync takes looking identical to an idle, finished session —
  // so a user who tapped Accept and then found an empty Texts list had no way to
  // tell "still arriving" from "nothing there". SyncProgressBar was already
  // showing the counts; what was missing was the label at the top saying which
  // of the two you are in.
  //
  // DERIVED, NEVER TIMED. `syncing` is FORGE-U's own in-flight flag: it goes
  // false when the three GET_* responses complete, or immediately when the run
  // is skipped (already synced this epoch / survivor-held), so "nothing to sync"
  // lands on "Active" with no intermediate flash and no timer to get wrong.
  const syncingNow = active && syncing;

  // EXT-UI-5 (M6 ADOPT). The dot used to be one 6px emerald circle for BOTH
  // active states, told apart only by `motion-safe:animate-pulse` — so with
  // reduced motion on, in any still frame, and in every screenshot we ship,
  // "Syncing…" and "Active" were the same pixels. Motion is a decoration of a
  // state channel, never the channel itself.
  //
  // Now SHAPE carries the state and colour reinforces it (see the
  // `.cc-conn-dot` block in app/extension/extension.css for the geometry, the
  // hexes and the measured ratios): circle = joined (filled settled / open
  // ring still working), square = not joined (filled failed / open waiting),
  // diamond = a request in the air. Shape survives colour-blindness and
  // greyscale; nothing here animates or transitions.
  const dotState = active
    ? syncingNow
      ? 'syncing'
      : 'active'
    : connecting
      ? 'connecting'
      : failed
        ? 'failed'
        : 'idle';

  const word = active
    ? syncingNow
      ? 'Syncing…'
      : 'Active'
    : connecting
      ? 'Connecting'
      : state === 'declined'
        ? 'Declined'
        : state === 'timeout'
          ? 'No answer'
          : state === 'rejected'
            ? 'Blocked'
            // FORGE-O: the lobby state has always had TWO meanings and showed
            // one word for both. "Waiting for phone" is right when no phone is
            // there; when a phone IS present and simply unpaired it is actively
            // misleading — it reads as "the phone hasn't arrived yet", so the
            // user waits for something that has already happened instead of
            // pressing the Connect button sitting next to this pill. The full
            // sentence lives in the title/aria below; the pill is 210px and
            // nowrap, so the word here has to stay short.
            : phonePresent
              ? 'Phone nearby'
              : 'Waiting for phone';

  const wordClass = active
    ? 'text-emerald-700'
    : connecting
      ? 'text-amber-700'
      : failed
        ? 'text-red-700'
        : 'text-slate-500';

  // The name only earns its slot when there IS a device. In every other state
  // the word is the whole message and the name would be a placeholder lie.
  const name = active ? (phoneName || 'Phone') : null;

  return (
    <div
      role="status"
      aria-live="polite"
      title={
        failed
          ? reasonText
          // FORGE-O: carries the meaning the 210px pill cannot spell out.
          : (!active && !connecting && phonePresent)
            ? 'Phone nearby — not connected. Press Connect to pair.'
            : undefined
      }
      className="cc-conn-pill inline-flex h-6 min-w-0 max-w-[210px] items-center gap-1.5 whitespace-nowrap rounded-full bg-slate-100 pl-2 pr-1 text-[11.5px] font-medium"
    >
      {/* The dot is the ONE element that carries the state to assistive tech,
          and the visible word beside it is marked aria-hidden. Both are needed
          visually, but exposing both would make every state change announce
          itself twice ("Active, Active"). Labelling the dot rather than the
          word is what satisfies the contract that Syncing and Active must not
          resolve to the same accessible name — they never can, because the
          label IS the word. */}
      <span
        className="cc-conn-dot flex-shrink-0"
        data-dot={dotState}
        role="img"
        aria-label={word}
      />
      {name && (
        <span className="min-w-0 truncate font-semibold text-slate-800" title={name}>
          {name}
        </span>
      )}
      {/* BAT-3: BESIDE the name, and flex-shrink-0 so the 210px cap is absorbed
          by the truncating name rather than by the value. The name is the only
          elastic thing in this row; everything else is already fixed. */}
      <BatteryIndicator view={battery} variant="compact" />
      <span className={`flex-shrink-0 ${wordClass}`} aria-hidden="true">{word}</span>

      {active ? (
        <button
          type="button"
          onClick={onDisconnect}
          aria-label={`Disconnect from ${name}`}
          title="Disconnect this browser from the phone"
          className="ml-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-red-100 hover:text-red-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60"
        >
          <X className="h-2.5 w-2.5" aria-hidden="true" />
        </button>
      ) : phonePresent && state === 'lobby' ? (
        <button
          type="button"
          onClick={onConnect}
          className="ml-0.5 flex-shrink-0 rounded-full px-1.5 text-[11px] font-semibold text-teal-700 transition-colors hover:bg-teal-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
          title="Ask the phone to pair with this browser"
        >
          Connect
        </button>
      ) : (
        <span className="w-0.5 flex-shrink-0" aria-hidden="true" />
      )}
      {/* Icon-only in compact — the pill is capped at 210px and AC-1 says it
          never wraps and never grows, so the word cannot come with it. The
          title + aria-label carry the meaning instead. */}
      {onReset && <ResetLobbyButton onReset={onReset} compact />}
      {onForget && <ForgetComputerButton onForget={onForget} compact />}
    </div>
  );
}

/**
 * Shared pill shell. Keeps the surrounding chrome (rounded glass card with
 * backdrop blur) identical across states — only the icon, palette, and copy
 * shift. Status dot pattern (small colored circle inside an icon disc) is
 * the project-wide convention.
 */
function PillShell({
  tone,
  children,
}: {
  tone: 'slate' | 'blue' | 'emerald' | 'amber' | 'red';
  children: React.ReactNode;
}) {
  const toneClasses: Record<typeof tone, string> = {
    slate: 'bg-slate-50/70 border-slate-200/70',
    blue: 'bg-blue-50/70 border-blue-200/70',
    emerald: 'bg-white/50 border-slate-200/60',
    amber: 'bg-amber-50/70 border-amber-200/70',
    red: 'bg-red-50/70 border-red-200/70',
  };
  return (
    // min-w-0 + max-w-full let the pill actually shrink inside the
    // `min-w-0 flex-1` slot Phone Mode's header gives it. Without them the pill
    // kept its intrinsic width and rode out over the tab bar at 390px
    // (2026-08-10). Padding/gap step up at sm: so desktop is byte-identical.
    <div
      className={`flex min-w-0 max-w-full items-center gap-2 px-3 sm:gap-3 sm:px-5 py-2 backdrop-blur-md rounded-2xl shadow-sm border ${toneClasses[tone]}`}
      role="status"
      aria-live="polite"
    >
      {children}
    </div>
  );
}

/**
 * Lobby — phone may or may not be present. Connect button is the only
 * affordance; disabled (with tooltip + aria-disabled) when phone is absent.
 */
function LobbyPill({
  phonePresent,
  battery,
  onConnect,
  onReset,
  onForget,
}: {
  phonePresent: boolean;
  /**
   * BAT-3. This is the "phone not present" face of the indicator: the hook
   * KEEPS the last reading across a disconnect, so the pill that replaces the
   * active one is where "Last seen 14:32 · 47%" belongs. It is the only place
   * on the web surface that branch can be seen.
   */
  battery: BatteryView;
  onConnect: () => void;
  onReset?: () => void;
  onForget?: () => void;
}) {
  return (
    <PillShell tone="slate">
      <div className="w-8 h-8 flex-shrink-0 rounded-full bg-slate-200 flex items-center justify-center border border-slate-300">
        <Smartphone className="w-4 h-4 text-slate-600" aria-hidden="true" />
      </div>
      {/* min-w-0 is what permits the truncate below to engage — a flex child
          defaults to min-width:auto and refuses to shrink past its text. */}
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-sm font-semibold text-slate-800">
          {/* FORGE-O: "ready to pair" described the RELAY's readiness, not the
              user's connection, and read as reassurance — the state it names is
              NOT connected and needs a click. Say the not-connected part first. */}
          {phonePresent ? 'Phone nearby — not connected' : 'Waiting for phone…'}
        </span>
        {/* The instruction line is the first thing to go on a phone: the pill
            sits in a ~200px slot there and the Connect button carries the
            action. Restored at sm: so the desktop header is unchanged. */}
        {battery ? (
          // The last-seen line REPLACES the instruction line rather than
          // stacking under it. A pill that says "open it on your phone" and
          // "last seen 14:32 · 47%" at once is telling the user to do something
          // they demonstrably already did.
          <BatteryIndicator view={battery} />
        ) : (
          !phonePresent && (
            <span className="hidden truncate text-[11px] text-slate-500 sm:block">
              Open ComputerCaller on your phone and sign in.
            </span>
          )
        )}
      </div>
      <div className="ml-2 hidden h-6 w-px flex-shrink-0 bg-slate-200 sm:block" aria-hidden="true" />
      <button
        type="button"
        onClick={phonePresent ? onConnect : undefined}
        disabled={!phonePresent}
        aria-disabled={!phonePresent}
        title={
          phonePresent
            ? 'Ask the phone to pair with this browser'
            : 'Sign in to ComputerCaller on your phone first.'
        }
        className={
          phonePresent
            ? 'flex flex-shrink-0 items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1'
            : 'flex flex-shrink-0 items-center gap-1.5 px-3 py-1.5 bg-slate-200 text-slate-400 text-xs font-semibold rounded-lg cursor-not-allowed'
        }
      >
        <Plug className="w-3.5 h-3.5" aria-hidden="true" />
        Connect
      </button>
      {/* This is the state Reset exists for: a phone the relay still lists in
          the lobby but which is gone, so Connect offers itself and then times
          out forever. Disconnect is not even rendered here — there is no active
          pair to leave — which is exactly why Reset must be. */}
      {onReset && <ResetLobbyButton onReset={onReset} />}
      {onForget && <ForgetComputerButton onForget={onForget} />}
    </PillShell>
  );
}

/**
 * Requesting — relay is awaiting Accept on the phone. Shows a live MM:SS
 * countdown derived from `expiresAt`. Monospace digits prevent width shift
 * as the value ticks. A soft outer pulse on the icon disc reinforces "active
 * waiting" — disabled under prefers-reduced-motion (the pill itself is enough
 * signal without animation for sensitive users).
 */
function RequestingPill({
  expiresAt,
  onCancel,
}: {
  expiresAt: number | null;
  onCancel: () => void;
}) {
  // Tick once per second. `now` is local-only — the source of truth is
  // `expiresAt` from the hook, so we never accumulate drift; we just rerender
  // to recompute the diff. 250ms tick gives a snappy enough redraw without
  // burning frames.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const remainingMs = expiresAt ? Math.max(0, expiresAt - now) : 0;
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  const countdown = expiresAt
    ? `${mm}:${ss.toString().padStart(2, '0')}`
    : '0:30';

  return (
    <PillShell tone="blue">
      <div className="relative w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center border border-blue-200">
        <Bell className="w-4 h-4 text-blue-700" aria-hidden="true" />
        <span
          className="absolute inset-0 rounded-full border-2 border-blue-400/60 animate-ping motion-reduce:hidden"
          aria-hidden="true"
        />
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-blue-900">
          Waiting for phone to accept…
        </span>
        <span className="text-[11px] text-blue-700 flex items-center gap-1">
          <Clock className="w-3 h-3" aria-hidden="true" />
          <span className="font-mono tabular-nums" aria-label={`${totalSeconds} seconds remaining`}>
            {countdown}
          </span>
          <span className="text-blue-600/80">— check your phone for the prompt</span>
        </span>
      </div>
      <div className="ml-2 h-6 w-px bg-blue-200" aria-hidden="true" />
      <button
        type="button"
        onClick={onCancel}
        className="flex items-center gap-1 px-2.5 py-1 bg-blue-100 hover:bg-blue-200 text-blue-700 text-xs font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-1"
        title="Cancel the pairing request"
      >
        Cancel
      </button>
    </PillShell>
  );
}

/**
 * Active — phone is paired. Primary attention should be on the call/message
 * UI below, so Disconnect is rendered as a quiet secondary button (subtle
 * slate, red on hover only). Two confirming sub-pills (server + phone)
 * persist from the prior design — at-a-glance source-of-truth for "both
 * halves are up".
 */
function ActivePill({
  phoneName,
  battery,
  syncing,
  onDisconnect,
  onReset,
  onForget,
}: {
  phoneName: string | null;
  /** BAT-3. `null` when nothing was ever received — then nothing is rendered. */
  battery: BatteryView;
  /** FORGE-U auto-sync in flight — see the note in CompactDevicePill. */
  syncing: boolean;
  onDisconnect: () => void;
  onReset?: () => void;
  onForget?: () => void;
}) {
  return (
    // data-cc-pill is a TEST HANDLE, and deliberately a stable one: the fit arm
    // of scripts/bat-ui-proof.mjs measures this row's height with and without a
    // battery, so it has to find the row when there is no battery to find it by.
    <div
      data-cc-pill="active"
      className="flex items-center gap-4 px-5 py-2 bg-white/50 backdrop-blur-md rounded-2xl border border-slate-200/60 shadow-sm"
    >
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-emerald-50 flex items-center justify-center border border-emerald-100">
          <Smartphone className="w-4 h-4 text-emerald-600" aria-hidden="true" />
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-700">
            <span className="min-w-0 truncate">{phoneName || 'Phone Connected'}</span>
            {/* BAT-3: on the SAME line as the name, which is what "beside the
                phone name" means here — the status word below it is a second
                fact about the session, not about the device. */}
            <BatteryIndicator view={battery} />
          </span>
          {/* PIXEL-S2 (c): the same two-state label as the compact pill, out of
              the same flag. Both surfaces go through this component precisely so
              they cannot end up describing the same session differently. */}
          <span
            className={
              syncing
                ? 'text-xs font-medium text-emerald-700'
                : 'text-xs font-medium text-emerald-600'
            }
          >
            {syncing ? 'Syncing…' : 'Active'}
          </span>
        </div>
      </div>
      <div className="hidden md:flex items-center gap-1.5" role="status" aria-label="Connection details">
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-[10px] font-medium text-emerald-700 uppercase tracking-wide">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          Server
        </span>
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-[10px] font-medium text-emerald-700 uppercase tracking-wide">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
          Phone paired
        </span>
      </div>
      <div className="h-6 w-px bg-slate-200" aria-hidden="true" />
      <button
        type="button"
        onClick={onDisconnect}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-red-100 hover:text-red-700 text-slate-500 text-xs font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300 focus-visible:ring-offset-1"
        title="Disconnect this browser from the phone"
      >
        <XCircle className="w-3.5 h-3.5" aria-hidden="true" />
        Disconnect
      </button>
      {/* Reset lobby sits NEXT TO Disconnect, deliberately quieter than it:
          same row so it is findable when Disconnect did not work, but
          text-only and dimmer so it never reads as the primary action. */}
      {onReset && <ResetLobbyButton onReset={onReset} />}
      {onForget && <ForgetComputerButton onForget={onForget} />}
    </div>
  );
}

/**
 * ResetLobbyButton — "Reset lobby" (dispatch FORGE-J, 2026-09-15).
 *
 * The escape hatch for the states Disconnect cannot reach. Disconnect
 * (LEAVE_ACTIVE) only moves both peers back into the lobby on the SAME sockets,
 * so a phantom phone — one whose socket died without a FIN and which the relay
 * has not reaped yet — survives it and keeps the room advertising a phone that
 * will never answer Connect. Reset drops every socket and deletes the room.
 *
 * Rendered in every state, not just 'active': the states a user actually needs
 * this from are 'lobby' (a phantom phone) and 'requesting'/'timeout' (a Connect
 * that will never resolve), where there is no active pair to disconnect from.
 *
 * Visual weight is intentionally below Disconnect's — a bare text button. This
 * is the "nothing else worked" control; making it as loud as Disconnect would
 * get it pressed by mistake, and it costs the user a ~5 s phone reconnect.
 */
function ResetLobbyButton({
  onReset,
  compact = false,
}: {
  onReset: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onReset}
      title="Empty the lobby completely — drops your phone and this computer; the phone re-joins by itself in a few seconds."
      className={
        compact
          ? 'ml-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-amber-100 hover:text-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
          : 'flex flex-shrink-0 items-center gap-1.5 px-2 py-1.5 text-slate-400 hover:text-amber-700 text-xs font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-1'
      }
      aria-label="Reset lobby"
    >
      <RotateCw className={compact ? 'h-2.5 w-2.5' : 'w-3.5 h-3.5'} aria-hidden="true" />
      {!compact && 'Reset lobby'}
    </button>
  );
}

/**
 * "Forget this computer" — E2E-P2.3 (b), GATE1 Addendum A5 F1 / MUST M-A5-1 (a).
 *
 * The explicit revocation control, and the ONLY one in the UI. It sits beside
 * Reset lobby because that is where a user looking for "make it stop" will
 * look, but the two are different acts and the confirm text is what tells them
 * apart:
 *
 *   Reset lobby  — TRANSPORT. Empties the room; the phone re-joins by itself
 *                  in a few seconds and the PAIR SURVIVES. Dennis's definition,
 *                  unchanged by P2.3.
 *   Forget this  — REVOCATION. Drops this computer's session key, resets the
 *   computer      room, and revokes this browser's own DeviceKey row on the
 *                 server. The phone must pair again from scratch.
 *
 * Styling is ResetLobbyButton's, verbatim, on purpose (the brief: "reuse the
 * existing button styling verbatim" — no Pixel dispatch needed). Same quiet
 * weight for the same reason: it is destructive and must not be pressed by
 * accident. The icon differs because the ACT differs — an unlink, not a redo.
 */
function ForgetComputerButton({
  onForget,
  compact = false,
}: {
  onForget: () => void;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onForget}
      title="Forget this computer — ends the pairing here and revokes this browser's key; the phone will ask you to pair again."
      className={
        compact
          ? 'ml-0.5 inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-amber-100 hover:text-amber-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60'
          : 'flex flex-shrink-0 items-center gap-1.5 px-2 py-1.5 text-slate-400 hover:text-amber-700 text-xs font-medium rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-1'
      }
      aria-label="Forget this computer"
    >
      <Unlink className={compact ? 'h-2.5 w-2.5' : 'w-3.5 h-3.5'} aria-hidden="true" />
      {!compact && 'Forget this computer'}
    </button>
  );
}

/**
 * Declined — transient (~4s). Hook is responsible for the timer; we just
 * render while the state is set. No affordance — the user just saw their
 * own action on the phone, they don't need another button right now.
 */
function DeclinedPill() {
  return (
    <PillShell tone="red">
      <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center border border-red-200">
        <ShieldX className="w-4 h-4 text-red-700" aria-hidden="true" />
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-red-900">
          Phone declined the connection
        </span>
        <span className="text-[11px] text-red-700">
          Try again — tap Accept on the phone next time.
        </span>
      </div>
    </PillShell>
  );
}

/**
 * Timeout — transient (~4s). Distinct from `declined` because it's not the
 * user's fault — the phone may be locked / off-screen / out of network.
 * Amber, not red, to reflect "no harm done, just retry".
 */
function TimeoutPill() {
  return (
    <PillShell tone="amber">
      <div className="w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center border border-amber-200">
        <Clock className="w-4 h-4 text-amber-700" aria-hidden="true" />
      </div>
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-semibold text-amber-900">
          Phone didn&apos;t respond
        </span>
        <span className="text-[11px] text-amber-700">
          Wake your phone and try again.
        </span>
      </div>
    </PillShell>
  );
}

/**
 * Rejected — the relay refused the request outright (e.g. another session
 * is already paired). Sticky until the user clicks Try Again. We give the
 * user a Try Again button instead of a Connect (semantically distinct —
 * they already tried).
 */
function RejectedPill({
  reason,
  reasonText,
  onRetry,
}: {
  reason: LobbyRejectedReason | undefined;
  reasonText: string | undefined;
  onRetry: () => void;
}) {
  // Map machine reason to user-facing copy. Prefer an explicit reasonText
  // from the payload if the hook/relay supplied one — that's the
  // forward-compatible escape hatch for reasons we haven't enumerated yet.
  const copy =
    reasonText ||
    (reason === 'already_active'
      ? 'Another session is already paired — disconnect there first.'
      : reason === 'already_pending'
        ? 'Another browser is already asking — wait for it to settle.'
        : 'Something went wrong. Try again in a moment.');

  return (
    <PillShell tone="red">
      <div className="w-8 h-8 rounded-full bg-red-100 flex items-center justify-center border border-red-200">
        <ShieldX className="w-4 h-4 text-red-700" aria-hidden="true" />
      </div>
      <div className="flex flex-col leading-tight max-w-[280px]">
        <span className="text-sm font-semibold text-red-900">Cannot connect</span>
        <span className="text-[11px] text-red-700">{copy}</span>
      </div>
      <div className="ml-2 h-6 w-px bg-red-200" aria-hidden="true" />
      <button
        type="button"
        onClick={onRetry}
        className="flex items-center gap-1.5 px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-semibold rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-1"
      >
        <RotateCw className="w-3.5 h-3.5" aria-hidden="true" />
        Try Again
      </button>
    </PillShell>
  );
}
