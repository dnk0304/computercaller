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

// ── 9. Message-DUPLICATES fix (2026-06-03 follow-up to 3c02462).
//     The scoped-replace branch in MESSAGES_CHUNK was appending `incoming`
//     verbatim, so when Android's SMS provider returned the same logical
//     message twice (dual-SIM / OEM row-split / observer+receiver), both
//     copies persisted. mergeMessages() now dedupes by id OR composite
//     (conversationKey + type + body) within a 10s window. Mirrors the
//     repro shape and helpers below — kept in sync with hooks/usePhoneBridge.ts.

const MESSAGE_COMPOSITE_WINDOW_MS = 10000;

function messageCompositeSig(m) {
  return `${conversationKey(m.address)}|${m.type || ''}|${(m.body || '').trim()}`;
}

function mergeMessages(prev, incoming) {
  const byId = new Set();
  const sigBuckets = new Map();
  const out = [];
  const accept = (m) => {
    if (!m || !m.id) return;
    if (byId.has(m.id)) return;
    const sig = messageCompositeSig(m);
    const d = m.date || 0;
    const bucket = sigBuckets.get(sig);
    if (bucket && bucket.some((pd) => Math.abs(pd - d) <= MESSAGE_COMPOSITE_WINDOW_MS)) return;
    byId.add(m.id);
    if (bucket) bucket.push(d);
    else sigBuckets.set(sig, [d]);
    out.push(m);
  };
  for (const m of incoming) accept(m);
  for (const m of prev) accept(m);
  return out.sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
}

// Simulate the scoped-replace branch with the FIX applied.
function scopedReplaceWithFix(prev, incoming, scopedKey) {
  const filteredPrev = prev.filter((m) => conversationKey(m.address) !== scopedKey);
  const dedupedIncoming = mergeMessages([], incoming);
  return [...filteredPrev, ...dedupedIncoming].sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
}

// Simulate the OLD scoped-replace branch from 3c02462 (the regression).
function scopedReplaceOLD(prev, incoming, scopedKey) {
  return [
    ...prev.filter((m) => conversationKey(m.address) !== scopedKey),
    ...incoming,
  ].sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
}

const baseDate = 1717420000000;

// ── 9A. Same `_id` re-emitted (observer + receiver double-fire).
{
  const incomingDupSameId = [
    { id: 'm1', address: phoneA, body: 'Hello dup', date: baseDate, type: 'inbox' },
    { id: 'm1', address: phoneA, body: 'Hello dup', date: baseDate, type: 'inbox' },
  ];
  const oldResult = scopedReplaceOLD([], incomingDupSameId, conversationKey(phoneA));
  const fixResult = scopedReplaceWithFix([], incomingDupSameId, conversationKey(phoneA));
  t(
    'OLD scoped-replace: same-_id dup renders TWICE (REGRESSION)',
    oldResult.length === 2,
    `len=${oldResult.length}`,
  );
  t(
    'FIX scoped-replace: same-_id dup renders ONCE',
    fixResult.length === 1 && fixResult[0].id === 'm1',
    `len=${fixResult.length}`,
  );
}

// ── 9B. SIM-split: different `_id` per SIM row, same logical message.
//     Composite (conv+type+body) + 10s window catches it; id-only set misses.
{
  const incomingSimSplit = [
    { id: 'sim1-a', address: phoneA, body: 'SIM-split body', date: baseDate, type: 'inbox' },
    { id: 'sim1-b', address: phoneA, body: 'SIM-split body', date: baseDate + 2000, type: 'inbox' },
  ];
  const oldResult = scopedReplaceOLD([], incomingSimSplit, conversationKey(phoneA));
  const fixResult = scopedReplaceWithFix([], incomingSimSplit, conversationKey(phoneA));
  t(
    'OLD scoped-replace: SIM-split (diff ids, same body, 2s apart) renders TWICE (REGRESSION)',
    oldResult.length === 2,
  );
  t(
    'FIX scoped-replace: SIM-split logical dup renders ONCE',
    fixResult.length === 1,
    `len=${fixResult.length}`,
  );
}

// ── 9C. ANTI-REGRESSION: two genuinely DISTINCT messages in same convo.
//     Different body → must BOTH be kept.
{
  const incomingDistinct = [
    { id: 'd1', address: phoneA, body: 'First message', date: baseDate, type: 'inbox' },
    { id: 'd2', address: phoneA, body: 'Second message', date: baseDate + 1000, type: 'inbox' },
  ];
  const fixResult = scopedReplaceWithFix([], incomingDistinct, conversationKey(phoneA));
  t(
    'FIX: two DISTINCT messages (different body) in same convo — BOTH kept',
    fixResult.length === 2,
    `len=${fixResult.length}`,
  );
}

// ── 9D. ANTI-REGRESSION: same body but FAR apart (>10s) — both kept.
//     A genuine "ok" sent twice an hour apart must not collapse.
{
  const incomingFarApart = [
    { id: 'f1', address: phoneA, body: 'ok', date: baseDate, type: 'inbox' },
    { id: 'f2', address: phoneA, body: 'ok', date: baseDate + 3_600_000, type: 'inbox' },
  ];
  const fixResult = scopedReplaceWithFix([], incomingFarApart, conversationKey(phoneA));
  t(
    'FIX: same body, >10s apart — BOTH kept (genuine repeat is not a dup)',
    fixResult.length === 2,
  );
}

// ── 9E. ANTI-REGRESSION (chat-mixing): same body in DIFFERENT conversations
//     must NEVER collapse, even within the time window. conversationKey is
//     part of the composite signature so the namespaces stay disjoint.
{
  const incomingCrossConv = [
    { id: 'x1', address: phoneA, body: 'identical body', date: baseDate, type: 'inbox' },
    { id: 'x2', address: phoneB, body: 'identical body', date: baseDate + 1000, type: 'inbox' },
  ];
  const merged = mergeMessages([], incomingCrossConv);
  t(
    'FIX: same body across DIFFERENT conversations — never merged (chat-mixing stays fixed)',
    merged.length === 2 &&
      merged.some((m) => m.address === phoneA) &&
      merged.some((m) => m.address === phoneB),
  );
}

// ── 9F. SMS_RECEIVED prepend + same message in subsequent fetched page.
//     Existing prev contains the live-prepended row; the chunk fetch returns
//     it again (different `_id` because the fetched page got the provider's
//     committed id). mergeMessages must collapse to one.
{
  const liveRow = { id: 'live-tmp', address: phoneA, body: 'just got this', date: baseDate, type: 'inbox' };
  const fetchedPage = [
    { id: 'provider-99', address: phoneA, body: 'just got this', date: baseDate + 500, type: 'inbox' },
    { id: 'provider-98', address: phoneA, body: 'earlier message', date: baseDate - 60_000, type: 'inbox' },
  ];
  const result = scopedReplaceWithFix([liveRow], fetchedPage, conversationKey(phoneA));
  t(
    'FIX: live SMS_RECEIVED + same msg in fetched page — present ONCE',
    result.filter((m) => m.body === 'just got this').length === 1,
    `count=${result.filter((m) => m.body === 'just got this').length}`,
  );
  t(
    'FIX: live + fetched page — distinct "earlier message" still kept',
    result.some((m) => m.body === 'earlier message'),
  );
}

// ── 9G. Merge branch (loadOlderMessages paging) — SIM-split dup across
//     paging boundary. Old code did id-only set → missed it. New code via
//     mergeMessages catches it.
{
  const prev = [
    { id: 'old-a', address: phoneA, body: 'paged body', date: baseDate, type: 'inbox' },
  ];
  const incomingOlderPage = [
    { id: 'old-b', address: phoneA, body: 'paged body', date: baseDate + 1500, type: 'inbox' }, // SIM-split of old-a
    { id: 'old-c', address: phoneA, body: 'genuinely older', date: baseDate - 100_000, type: 'inbox' },
  ];
  const result = mergeMessages(prev, incomingOlderPage);
  t(
    'FIX merge branch: SIM-split across paging boundary — collapsed to ONE',
    result.filter((m) => m.body === 'paged body').length === 1,
  );
  t(
    'FIX merge branch: genuinely older distinct row — kept',
    result.some((m) => m.id === 'old-c'),
  );
}

// ── 9H. Different `type` (inbox vs sent) with same body — kept distinct.
//     A user replying "ok" to an inbox "ok" should never collapse.
{
  const incoming = [
    { id: 'in1', address: phoneA, body: 'ok', date: baseDate, type: 'inbox' },
    { id: 'out1', address: phoneA, body: 'ok', date: baseDate + 500, type: 'sent' },
  ];
  const result = mergeMessages([], incoming);
  t(
    'FIX: same body, different type (inbox vs sent) — BOTH kept',
    result.length === 2,
  );
}

const failed = tests.filter((x) => !x.ok);
console.log(`\n${tests.length - failed.length}/${tests.length} passed`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log('  -', f.name);
  process.exit(1);
}
