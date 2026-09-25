/**
 * tests/notification-title.test.ts — ALERT-TITLE: the phone's doubled sender
 * (`Conv: Sender · Sender`) is repaired at render time, and nothing else is
 * touched. Vectors from Ken's brief (Dennis 2026-09-25 11:53Z screenshot).
 *
 *   node tests/notification-title.test.ts
 */

import { cleanNotificationTitle } from '../lib/notificationTitle.ts';

let pass = 0;
let fail = 0;
const failures: string[] = [];
function eq(name: string, got: unknown, want: unknown): void {
  if (got === want) { pass += 1; return; }
  fail += 1;
  const line = `${name} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`;
  failures.push(line);
  console.log(`  FAIL  ${line}`);
}
const c = cleanNotificationTitle;

// Dennis's screenshot, row by row.
eq('Teams 1:1 Frank', c('Frank Jørgensen: Frank Jørgensen · Frank Jørgensen'), 'Frank Jørgensen');
eq('Teams 1:1 Ole-Magne', c('Ole-Magne Kaald Husby: Ole-Magne Kaald Husby · Ole-Magne Kaald Husby'), 'Ole-Magne Kaald Husby');
eq('Teams group', c('EIDSIVA CREW: Ole-Magne Kaald Husby · Ole-Magne Kaald Husby'), 'EIDSIVA CREW · Ole-Magne Kaald Husby');
eq('Discord channel', c('Niki HQ #niki: Niki · Niki'), 'Niki HQ #niki · Niki');
eq('Messages number unchanged', c('92 60 17 60'), '92 60 17 60');

// Normalisation: case + whitespace for comparison; first occurrence's casing kept.
eq('case/space-insensitive', c('frank  jørgensen: Frank Jørgensen · FRANK JØRGENSEN'), 'frank jørgensen');
eq('NFC vs NFD compare equal', c('José: ' + 'José'.normalize('NFD') + ' · José'), 'José');

// Conservative pass-through.
eq('Frank · Frank', c('Frank · Frank'), 'Frank');
eq('Group: Frank unchanged', c('Group: Frank'), 'Group: Frank');
eq('Meeting: 10:00 unchanged', c('Meeting: 10:00'), 'Meeting: 10:00');
eq('Anna · Bob unchanged', c('Anna · Bob'), 'Anna · Bob');
eq('empty', c(''), '');
eq('three distinct names unchanged', c('Crew: Anna · Bob'), 'Crew: Anna · Bob');
eq('raw whitespace kept when unchanged', c('  Re:  invoice  '), '  Re:  invoice  ');
eq('conversation with a dot of its own', c('A · B: C · C'), 'A · B · C');
eq('empty conversation dropped', c(': Frank · Frank'), 'Frank');
eq('non-string is safe', c(undefined as unknown as string), '');

console.log(`\nnotification-title: ${pass} passed, ${fail} failed`);
if (fail) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
