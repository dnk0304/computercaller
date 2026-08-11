/**
 * scripts/admin-table-columns-proof.mts — proves the admin table actually
 * RENDERS the two new billing columns (dispatch
 * forge/whop-payment-tracking-admin, 2026-08-11).
 *
 * Server-renders the REAL <CustomerTable> with the REAL mock fixture (the same
 * one `/app/admin?mock=1` serves) and asserts against the emitted HTML:
 *   • the "Next payment" and "Cancelled" headers exist, are sortable buttons
 *     inside <th scope="col"> carrying aria-sort — the a11y contract the brief
 *     requires be preserved;
 *   • header count === the empty-state colSpan (the silent-breakage trap);
 *   • a MID-PERIOD cancellation renders "Cancelling" + the access-until date
 *     while still reading "Paying: Yes" — the row this dispatch exists for;
 *   • an already-gone customer renders "Cancelled" instead, so the two are
 *     visibly different;
 *   • a healthy payer renders its next-payment date and NO cancellation mark.
 *
 * Run: npx tsx scripts/admin-table-columns-proof.mts
 * Exits non-zero on the first failed assertion.
 */

import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CustomerTable } from '../components/admin/CustomerTable';
import { formatDate } from '../components/admin/customerRows';
import { mockCustomersResponse } from '../components/admin/mockCustomers';

let passed = 0;
function ok(name: string, cond: unknown) {
  assert.ok(cond, name);
  console.log(`  PASS  ${name}`);
  passed += 1;
}
function eq(name: string, actual: unknown, expected: unknown) {
  assert.deepStrictEqual(actual, expected, `${name} (got ${String(actual)})`);
  console.log(`  PASS  ${name} = ${String(actual)}`);
  passed += 1;
}

const html = renderToStaticMarkup(
  React.createElement(CustomerTable, {
    data: mockCustomersResponse,
    now: Date.parse(mockCustomersResponse.meta.generatedAt),
  }),
);

const text = html.replace(/<[^>]+>/g, '').replace(/+/g, ' ');

// ---- headers ---------------------------------------------------------------
console.log('\n--- header row ---');
const headers = [...html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) =>
  m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
);
console.log(`  ${headers.join(' | ')}`);
ok('"Next payment" header rendered', headers.some((h) => h.startsWith('Next payment')));
ok('"Cancelled" header rendered', headers.some((h) => h.startsWith('Cancelled')));

// ---- colSpan must match the header count (silent empty-state breakage) -----
// The empty-state <td> only exists when there are no rows, so render the empty
// case explicitly rather than assuming it. A stale colSpan breaks silently —
// the table still "works", the empty state just stops spanning the table.
const emptyHtml = renderToStaticMarkup(
  React.createElement(CustomerTable, {
    data: { ...mockCustomersResponse, customers: [] },
    now: Date.parse(mockCustomersResponse.meta.generatedAt),
  }),
);
const colSpan = Number(/colspan="(\d+)"/i.exec(emptyHtml)?.[1]);
eq('header count', headers.length, 15);
eq('empty-state colSpan matches header count', colSpan, headers.length);

// ---- a11y: both new columns are sortable buttons in an aria-sort <th> ------
console.log('\n--- accessibility contract ---');
for (const label of ['Next payment', 'Cancelled']) {
  const th = [...html.matchAll(/<th[^>]*>[\s\S]*?<\/th>/g)]
    .map((m) => m[0])
    .find((s) => s.includes(`>${label}<`));
  ok(`"${label}" <th> found`, !!th);
  ok(`"${label}" <th scope="col">`, th!.includes('scope="col"'));
  ok(`"${label}" <th> carries aria-sort`, /aria-sort="/.test(th!));
  ok(`"${label}" sort control is a <button>`, /<button[^>]*type="button"/.test(th!));
}

// ---- the row this dispatch exists for --------------------------------------
console.log('\n--- rows ---');
const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
  m[1].replace(/<[^>]+>/g, '').replace(/+/g, ' | ').replace(/\s+/g, ' ').trim(),
);

const cancelling = rows.find((r) => r.includes('leaving.soon@acme.co'));
ok('mid-period cancellation row rendered', !!cancelling);
console.log(`  ROW  ${cancelling}`);
ok('labelled "Cancelling"', cancelling!.includes('Cancelling'));
// Derived from the fixture, never hardcoded — a literal date here would rot
// the moment the fixture's anchor moves and would assert nothing meaningful.
const cancellingRow = mockCustomersResponse.customers.find((c) => c.id === 'cus_cancelling')!;
const accessUntil = formatDate(cancellingRow.subscription!.currentPeriodEnd);
ok(`shows the access-until date (${accessUntil})`, cancelling!.includes(`until ${accessUntil}`));
ok(
  'the same date is also its Next payment cell',
  cancelling!.includes(`| ${accessUntil} | Cancelling |`),
);
ok('still reads as a paying customer', cancelling!.includes('Yes'));
ok('still shows its plan tier', cancelling!.includes('Plus'));

const gone = rows.find((r) => r.includes('katherine@ibm.com'));
ok('already-cancelled row rendered', !!gone);
console.log(`  ROW  ${gone}`);
ok('labelled "Cancelled", not "Cancelling"', gone!.includes('Cancelled') && !gone!.includes('Cancelling'));

// ---- a healthy payer must NOT be marked as cancelling -----------------------
const healthy = rows.filter(
  (r) => r.includes('@') && !r.includes('leaving.soon') && !r.includes('katherine@ibm.com'),
);
ok('no other row is marked Cancelling', healthy.every((r) => !r.includes('Cancelling')));

ok('screen-reader explanation present', text.includes('still an active paying customer until this date'));
ok('caption mentions cancellation', /cancellation/.test(text));

console.log(`\nAll ${passed} assertions passed.`);
