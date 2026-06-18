// Repro test for the duplicate notification-card bug (2026-06-18).
//
// Symptom: the web notifications strip rendered ONE incoming WhatsApp message
// as TWO identical cards (same sender, same body, both "now"). Intermittent.
//
// Root cause: Android (DnkNotificationListenerService) forwards a messaging
// app's group-SUMMARY notification AND its per-conversation CHILD for the same
// logical message. Both surface the same EXTRA_MESSAGES.last() → identical
// title+body, but DIFFERENT sbn.key. The web flush effect's `add` branch
// deduped ONLY on notificationKey, so the two distinct keys produced two cards.
//
// Fix (hooks/usePhoneBridge.ts): widen the `add`-side dedup to also collapse on
// content-identity (packageName + normalized title + body) within a 10s window.
// Removal stays keyed on the EXACT notificationKey.
//
// This file MIRRORS the helper + reducer in hooks/usePhoneBridge.ts. If you
// change either there, update this copy. Plain ESM — run with:
//   node tests/repro-notification-dup.mjs

// ── Mirror of NOTIFICATION_COMPOSITE_WINDOW_MS + notificationCompositeSig ──
const NOTIFICATION_COMPOSITE_WINDOW_MS = 10000;

function notificationCompositeSig(n) {
  const norm = (s) => (s || '').trim().replace(/\s+/g, ' ');
  return `${n.packageName}|${norm(n.title)}|${norm(n.body)}`;
}

// ── OLD reducer (key-only) — what shipped on 9e30127. Kept to prove the bug ──
function applyOld(prev, events) {
  let result = [...prev];
  for (const event of events) {
    if (event.type === 'add') {
      result = result.filter((n) => n.notificationKey !== event.notif.notificationKey);
      result = [event.notif, ...result];
    } else {
      result = result.filter((n) => n.notificationKey !== event.key);
    }
  }
  return result.slice(0, 50);
}

// ── NEW reducer (key OR content-identity within window) — the fix ──
function applyNew(prev, events) {
  let result = [...prev];
  for (const event of events) {
    if (event.type === 'add') {
      const incomingSig = notificationCompositeSig(event.notif);
      const incomingTs = event.notif.timestamp;
      result = result.filter((n) =>
        n.notificationKey !== event.notif.notificationKey
        && !(
          notificationCompositeSig(n) === incomingSig
          && Math.abs((n.timestamp ?? 0) - incomingTs) <= NOTIFICATION_COMPOSITE_WINDOW_MS
        )
      );
      result = [event.notif, ...result];
    } else {
      result = result.filter((n) => n.notificationKey !== event.key);
    }
  }
  return result.slice(0, 50);
}

// ── tiny assert harness ──
const results = [];
function t(name, cond, detail) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
}

const add = (notif) => ({ type: 'add', notif });
const remove = (key) => ({ type: 'remove', key });

const T0 = 1_700_000_000_000;
const card = (over = {}) => ({
  id: over.notificationKey ?? 'k',
  appName: 'WhatsApp',
  packageName: 'com.whatsapp',
  title: 'WhatsApp · Tony Antonio Rodriguez Cardenes',
  body: 'Ya llegaste ?',
  timestamp: T0,
  hasReply: false,
  replyKey: '',
  notificationKey: 'k',
  read: false,
  ...over,
});

// ── Case A: two frames, SAME notificationKey → ONE card (existing behavior) ──
{
  const events = [
    add(card({ notificationKey: 'sbnKeyA', id: 'sbnKeyA' })),
    add(card({ notificationKey: 'sbnKeyA', id: 'sbnKeyA' })),
  ];
  const out = applyNew([], events);
  t('Case A: same notificationKey collapses to ONE card', out.length === 1, `got ${out.length}`);
}

// ── Case B: two frames, DIFFERENT keys, same pkg+title+body within 10s → ONE ──
// This is THE bug (group-summary + child). Prove OLD made 2, NEW makes 1.
{
  const summary = add(card({ notificationKey: 'whatsapp_summary_0', id: 'whatsapp_summary_0', timestamp: T0 }));
  const child = add(card({ notificationKey: 'whatsapp|conv:34xxx|99', id: 'whatsapp|conv:34xxx|99', timestamp: T0 + 1200 }));
  const oldOut = applyOld([], [summary, child]);
  const newOut = applyNew([], [summary, child]);
  t('Case B: OLD reducer reproduces the bug (TWO cards)', oldOut.length === 2, `old got ${oldOut.length}`);
  t('Case B: NEW reducer collapses different-key dup to ONE card', newOut.length === 1, `new got ${newOut.length}`);
  t('Case B: surviving card is the NEWEST frame (child wins slot)',
    newOut.length === 1 && newOut[0].notificationKey === 'whatsapp|conv:34xxx|99',
    `kept ${newOut[0]?.notificationKey}`);
}

// ── Case B2: dup arrives across separate flush ticks (prev already has card) ──
{
  const first = applyNew([], [add(card({ notificationKey: 'sumKey', id: 'sumKey', timestamp: T0 }))]);
  const second = applyNew(first, [add(card({ notificationKey: 'childKey', id: 'childKey', timestamp: T0 + 800 }))]);
  t('Case B2: cross-tick group-summary+child still ONE card', second.length === 1, `got ${second.length}`);
}

// ── Case C: ANTI-REGRESSION — different body, same thread, close in time → TWO ──
{
  const m1 = add(card({ notificationKey: 'kc1', id: 'kc1', body: 'Ya llegaste ?', timestamp: T0 }));
  const m2 = add(card({ notificationKey: 'kc2', id: 'kc2', body: 'Estoy aqui', timestamp: T0 + 3000 }));
  const out = applyNew([], [m1, m2]);
  t('Case C: two DIFFERENT bodies <10s apart stay TWO cards', out.length === 2, `got ${out.length}`);
}

// ── Case C2: same body but DIFFERENT package → never merged (two cards) ──
{
  const wa = add(card({ notificationKey: 'wa', id: 'wa', packageName: 'com.whatsapp', timestamp: T0 }));
  const tg = add(card({ notificationKey: 'tg', id: 'tg', packageName: 'org.telegram.messenger', timestamp: T0 + 500 }));
  const out = applyNew([], [wa, tg]);
  t('Case C2: same text, different package → TWO cards', out.length === 2, `got ${out.length}`);
}

// ── Case C3: same body but OUTSIDE the window (>10s) → TWO cards (genuine resend) ──
{
  const a = add(card({ notificationKey: 'a', id: 'a', timestamp: T0 }));
  const b = add(card({ notificationKey: 'b', id: 'b', timestamp: T0 + 15000 }));
  const out = applyNew([], [a, b]);
  t('Case C3: identical text 15s apart → TWO cards (outside window)', out.length === 2, `got ${out.length}`);
}

// ── Case D: NOTIFICATION_REMOVED removes the right card by EXACT key ──
{
  const start = applyNew([], [
    add(card({ notificationKey: 'keepKey', id: 'keepKey', body: 'Hola', timestamp: T0 })),
    add(card({ notificationKey: 'dropKey', id: 'dropKey', body: 'Adios', timestamp: T0 + 4000 })),
  ]);
  const after = applyNew(start, [remove('dropKey')]);
  t('Case D: removal drops exactly the dismissed key',
    after.length === 1 && after[0].notificationKey === 'keepKey',
    `remaining ${after.map((n) => n.notificationKey).join(',')}`);
}

// ── Case D2: removal of a content-dup-collapsed card uses the surviving key ──
// After B, only the child key remains; a REMOVED for the summary key is a no-op
// (the summary card was already collapsed). This is acceptable — the visible
// card is removed when its OWN key is dismissed.
{
  const collapsed = applyNew([], [
    add(card({ notificationKey: 'sumKey', id: 'sumKey', timestamp: T0 })),
    add(card({ notificationKey: 'childKey', id: 'childKey', timestamp: T0 + 1000 })),
  ]);
  const afterStaleRemove = applyNew(collapsed, [remove('sumKey')]);
  t('Case D2: REMOVED for the collapsed (gone) key is a safe no-op',
    afterStaleRemove.length === 1 && afterStaleRemove[0].notificationKey === 'childKey',
    `remaining ${afterStaleRemove.map((n) => n.notificationKey).join(',')}`);
}

// ── summary ──
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.error('FAILURES:', failed.map((r) => r.name).join('; '));
  process.exit(1);
}
