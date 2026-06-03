// Trace test for chat-mixing bug (2026-06-03).
// Reproduces the loose-tail-match + accumulation behaviour and proves the
// canonical conversationKey + scoped-replace fixes close the bleed.
//
// Mirrors lib/normalizeNumber.ts EXACTLY. If you change the helper there,
// update this copy or the trace will diverge. Plain JS so we can run it
// straight with `node tests/repro-chat-mixing.mjs` — no compile step.

function conversationKey(raw) {
  if (!raw) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return `#${trimmed.toLowerCase()}`;
  if (digits.length >= 7) return `p:${digits.slice(-7)}`;
  return `s:${digits}`;
}

function sameConversation(a, b) {
  const ka = conversationKey(a);
  const kb = conversationKey(b);
  return ka !== '' && ka === kb;
}

// ── 1. Per Ken's brief: the OLD loose tail logic from Dashboard.tsx:927-935.
//     Reproduce it so we can show the bleed scenario that the new key blocks.
function oldLooseTailMatch(selectedThread, addr) {
  const digits = (n) => (n || '').replace(/\D/g, '');
  const targetDigits = digits(selectedThread);
  if (!targetDigits) {
    return (addr ?? '').toLowerCase() === (selectedThread ?? '').toLowerCase();
  }
  const matchLen = Math.min(targetDigits.length, 10);
  const targetTail = targetDigits.slice(-matchLen);
  const addrDigits = digits(addr);
  if (!addrDigits) return (addr ?? '').toLowerCase() === (selectedThread ?? '').toLowerCase();
  const addrTail = addrDigits.slice(-matchLen);
  return addrTail === targetTail;
}

const tests = [];
function t(name, cond, detail) {
  tests.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

// ── 2. Similar-tail collision: two real distinct numbers sharing last 4 digits.
//     Bug behaviour: tail collapses to 4 → match. Fix: full last-10 keys differ.
const phoneA = '+15551234999';   // last7 = 1234999
const phoneB = '+447400000999';  // last7 = 0000999 — distinct subscriber portion, just shares the literal "999" tail
t(
  'OLD: short selectedThread "999" loose-matches both A and B (BUG)',
  oldLooseTailMatch('999', phoneA) && oldLooseTailMatch('999', phoneB),
);
t(
  'NEW: conversationKey("999") collides with neither A nor B',
  !sameConversation('999', phoneA) && !sameConversation('999', phoneB),
);
t(
  'NEW: A and B still resolve to DIFFERENT keys',
  conversationKey(phoneA) !== conversationKey(phoneB),
  `A=${conversationKey(phoneA)} B=${conversationKey(phoneB)}`,
);

// ── 3. Short-code vs phone with matching tail: classic chat-mixing scenario.
const shortCode = '2226';                   // service sender
const phoneEndingIn2226 = '+15555552226';   // unrelated 10-digit phone
t(
  'OLD: opening thread "2226" bleeds messages from +15555552226 (BUG)',
  oldLooseTailMatch(shortCode, phoneEndingIn2226),
);
t(
  'NEW: short code "2226" does NOT match +15555552226',
  !sameConversation(shortCode, phoneEndingIn2226),
  `short=${conversationKey(shortCode)} phone=${conversationKey(phoneEndingIn2226)}`,
);

// ── 4. Country-code variants of the SAME person STILL collapse (Ken's req).
t(
  'NEW: "+4745720075" === "4745720075" === "45720075"',
  sameConversation('+4745720075', '4745720075') &&
    sameConversation('4745720075', '45720075'),
);

// ── 5. Alpha service IDs match only themselves.
t(
  'NEW: "Google" matches "Google" but not "Google2226" or any phone',
  sameConversation('Google', 'google') &&
    !sameConversation('Google', 'Google2226') &&
    !sameConversation('Google', '+15555550100'),
);

// ── 6. End-to-end: simulate the threadMessages filter on a mixed global store.
const store = [
  { id: 'a1', address: phoneA, body: 'Hi from A' },
  { id: 'a2', address: phoneA, body: 'A second message' },
  { id: 'b1', address: phoneB, body: 'Hi from B' },
  { id: 's1', address: shortCode, body: 'Verification code 12345' },
  { id: 'p1', address: phoneEndingIn2226, body: 'Hello from +1 555 555 2226' },
  { id: 'g1', address: 'Google', body: 'G-123456' },
];

function newFilter(selected) {
  const tk = conversationKey(selected);
  if (!tk) return [];
  return store.filter((m) => conversationKey(m.address) === tk);
}

const aView = newFilter(phoneA);
const bView = newFilter(phoneB);
const shortView = newFilter(shortCode);
const phoneTailView = newFilter(phoneEndingIn2226);

t('A view contains exactly A1+A2', aView.length === 2 && aView.every((m) => m.address === phoneA));
t('B view contains exactly B1', bView.length === 1 && bView[0].id === 'b1');
t(
  'A view has ZERO messages from B (no bleed)',
  !aView.some((m) => m.address === phoneB),
);
t(
  'B view has ZERO messages from A (no bleed)',
  !bView.some((m) => m.address === phoneA),
);
t(
  'Short-code "2226" view has ONLY the short-code msg',
  shortView.length === 1 && shortView[0].id === 's1',
);
t(
  'Phone-ending-in-2226 view has ONLY the long-phone msg',
  phoneTailView.length === 1 && phoneTailView[0].id === 'p1',
);

// ── 7. Switch-back: re-opening A after viewing B still shows A intact (no
//     accumulated A rows getting double-filtered into B's slot).
const aViewAgain = newFilter(phoneA);
t(
  'Re-open A after viewing B: A still intact',
  aViewAgain.length === 2 && aViewAgain.every((m) => m.address === phoneA),
);

// ── 8. Scoped-replace simulation: opening B should not require purging A's
//     rows from the store — they stay in the global cache but are invisible
//     to B's filter because keys differ.
const newRowsForB = [
  { id: 'b2', address: phoneB, body: 'Newer fetched B msg 1' },
  { id: 'b3', address: phoneB, body: 'Newer fetched B msg 2' },
];
const scopedKey = conversationKey(phoneB);
const afterScopedReplace = [
  ...store.filter((m) => conversationKey(m.address) !== scopedKey),
  ...newRowsForB,
];
const bAfter = afterScopedReplace.filter((m) => conversationKey(m.address) === conversationKey(phoneB));
const aAfter = afterScopedReplace.filter((m) => conversationKey(m.address) === conversationKey(phoneA));
t(
  'Scoped-replace for B keeps A rows untouched',
  aAfter.length === 2,
);
t(
  'Scoped-replace for B installs fresh B rows (no stale b1)',
  bAfter.length === 2 && bAfter.every((m) => ['b2', 'b3'].includes(m.id)),
);

const failed = tests.filter((x) => !x.ok);
console.log(`\n${tests.length - failed.length}/${tests.length} passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log('  -', f.name);
  process.exit(1);
}
