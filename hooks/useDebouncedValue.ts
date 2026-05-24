'use client';

import { useEffect, useState } from 'react';

/**
 * useDebouncedValue — returns a debounced copy of `value` that only updates
 * after `delayMs` has elapsed without a new change.
 *
 * Why this exists (dispatch #9, 2026-05-22 — T6 SMS perf diagnostic):
 *   Search inputs in Dashboard.tsx (thread search) and SMSInterface.tsx
 *   (conversation search) were re-running their filter pipelines on EVERY
 *   keystroke. With 500+ SMS messages in memory and a thread-list filter
 *   that falls through to `messages.some(...)` on each thread (O(threads ×
 *   messages) per keystroke), typing in the search field locked up the UI
 *   for ~half a second per character. Debouncing the search query so the
 *   filter only runs ~150ms after the user stops typing makes the input
 *   feel instant while still keeping the result set fresh.
 *
 * Why a custom hook vs `useDeferredValue` or `lodash.debounce`:
 *   - `useDeferredValue` gives React permission to defer the *render*, but
 *     it doesn't gate the value used inside `useMemo` dependencies — the
 *     memo still recomputes every keystroke. We need the dep to update
 *     less frequently, not just the paint.
 *   - `lodash.debounce` would work but pulls in a new dep + has subtle
 *     issues with stale closures inside React effects. A 12-line hook is
 *     cheaper and easier to audit.
 *
 * Usage:
 *   const [query, setQuery] = useState('');
 *   const debouncedQuery = useDebouncedValue(query, 150);
 *   // Use `query` in the controlled input so the typing feels instant.
 *   // Use `debouncedQuery` inside `useMemo([...deps, debouncedQuery])` so
 *   // the expensive filter only runs once typing settles.
 *
 * Caveats:
 *   - The first render returns the initial value synchronously (no delay)
 *     so first paint is correct.
 *   - If the value changes back to its prior state during the wait window,
 *     the timer is reset and the debounced value still updates correctly
 *     when the wait elapses — equality checks happen at flush time, not
 *     mid-flight.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    // Skip the timer when delayMs is 0 — useful for disabling debounce in
    // tests or for caller-controlled toggling.
    if (delayMs <= 0) {
      setDebounced(value);
      return;
    }
    const id = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
