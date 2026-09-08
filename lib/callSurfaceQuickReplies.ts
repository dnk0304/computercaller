// ---------------------------------------------------------------------------
// Shared fallback quick-reply chips for every live-call surface.
//
// Single source of truth for the four hardcoded defaults that render ONLY when
// the user has zero saved entries in the quick-reply store
// (`useQuickReplyTemplates()`). Once they have >= 1, their list takes over
// entirely — no mixing. Previously this array was copy-pasted into CallModal,
// CallQueueBand and GlobalDialer; Dashboard's incoming-call card became the
// fourth consumer, so it moved here (2026-09-08, Pixel).
//
// Deliberately framework-free and dependency-free so any surface — client
// component, hook, or test — can import it without pulling in React.
// ---------------------------------------------------------------------------

export interface CallSurfaceQuickReply {
  /** Stable key. `default-N` for these fallbacks; the DTO id for saved ones. */
  id: string;
  /** Short label shown on the chip. */
  name: string;
  /** SMS body sent when tapped. For hardcoded defaults, label === body. */
  body: string;
}

export const DEFAULT_QUICK_REPLIES: ReadonlyArray<CallSurfaceQuickReply> = [
  { id: 'default-0', name: "Can't talk right now", body: "Can't talk right now" },
  { id: 'default-1', name: "I'll call you back",   body: "I'll call you back" },
  { id: 'default-2', name: 'On my way',            body: 'On my way' },
  { id: 'default-3', name: 'Call you later',       body: 'Call you later' },
];
