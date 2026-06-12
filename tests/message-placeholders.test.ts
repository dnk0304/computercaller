// Unit tests for lib/messagePlaceholders.ts (2026-06-12 "Unknown thread"
// bug — live SMS/MMS frames arriving without a usable sender address).
// Runner-less by design — this repo has no Jest/Vitest harness; run with:
//
//   node tests/message-placeholders.test.ts
//
// Exits non-zero on the first failing assertion.

import { strict as assert } from 'node:assert';
import {
  PLACEHOLDER_HEAL_WINDOW_MS,
  isPlaceholderAddress,
  evictHealedPlaceholders,
} from '../lib/messagePlaceholders.ts';
import type { SmsMessage } from '../hooks/phoneTypes.ts';

const NOW = 1_760_000_000_000;

function msg(partial: Partial<SmsMessage> & { id: string }): SmsMessage {
  return {
    address: '+4791234567',
    body: 'hello',
    date: NOW,
    type: 'inbox',
    ...partial,
  };
}

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// ---- isPlaceholderAddress ----------------------------------------------

test('empty / nullish / whitespace addresses are placeholders', () => {
  assert.equal(isPlaceholderAddress(''), true);
  assert.equal(isPlaceholderAddress('   '), true);
  assert.equal(isPlaceholderAddress(null), true);
  assert.equal(isPlaceholderAddress(undefined), true);
});

test('the Android literal "Unknown" fallback is a placeholder (any casing)', () => {
  assert.equal(isPlaceholderAddress('Unknown'), true);
  assert.equal(isPlaceholderAddress('unknown'), true);
  assert.equal(isPlaceholderAddress('UNKNOWN'), true);
  assert.equal(isPlaceholderAddress(' Unknown '), true);
});

test('real numbers, short codes, and alpha senders are NOT placeholders', () => {
  assert.equal(isPlaceholderAddress('+4748271248'), false);
  assert.equal(isPlaceholderAddress('48271248'), false);
  assert.equal(isPlaceholderAddress('2226'), false);
  assert.equal(isPlaceholderAddress('Google'), false);
  assert.equal(isPlaceholderAddress('PayPal'), false);
});

// ---- evictHealedPlaceholders --------------------------------------------

test('placeholder healed by real-addressed copy with same body within window', () => {
  const placeholder = msg({ id: 'ph', address: 'Unknown', body: 'Vi er på ferie.' });
  const real = msg({ id: 'real', address: '+4791112233', body: 'Vi er på ferie.', date: NOW + 60_000 });
  const out = evictHealedPlaceholders([real, placeholder]);
  assert.deepEqual(out.map(m => m.id), ['real']);
});

test('empty-address placeholder is healed too', () => {
  const placeholder = msg({ id: 'ph', address: '', body: 'hei' });
  const real = msg({ id: 'real', body: 'hei' });
  const out = evictHealedPlaceholders([real, placeholder]);
  assert.deepEqual(out.map(m => m.id), ['real']);
});

test('outside the heal window the placeholder is kept', () => {
  const placeholder = msg({ id: 'ph', address: 'Unknown', body: 'hei' });
  const real = msg({ id: 'real', body: 'hei', date: NOW + PLACEHOLDER_HEAL_WINDOW_MS + 1 });
  const out = evictHealedPlaceholders([real, placeholder]);
  assert.equal(out.length, 2);
});

test('different body does NOT heal', () => {
  const placeholder = msg({ id: 'ph', address: 'Unknown', body: 'A' });
  const real = msg({ id: 'real', body: 'B' });
  assert.equal(evictHealedPlaceholders([real, placeholder]).length, 2);
});

test('direction mismatch (sent vs inbox) does NOT heal', () => {
  const placeholder = msg({ id: 'ph', address: 'Unknown', body: 'hei', type: 'inbox' });
  const real = msg({ id: 'real', body: 'hei', type: 'sent' });
  assert.equal(evictHealedPlaceholders([real, placeholder]).length, 2);
});

test('empty-body placeholder is never evicted (identity too weak)', () => {
  const placeholder = msg({ id: 'ph', address: 'Unknown', body: '   ' });
  const real = msg({ id: 'real', body: '' });
  assert.equal(evictHealedPlaceholders([real, placeholder]).length, 2);
});

test('body match tolerates surrounding whitespace', () => {
  const placeholder = msg({ id: 'ph', address: 'Unknown', body: ' hei \n' });
  const real = msg({ id: 'real', body: 'hei' });
  assert.deepEqual(evictHealedPlaceholders([real, placeholder]).map(m => m.id), ['real']);
});

test('unhealed placeholder stays (no real copy yet)', () => {
  const placeholder = msg({ id: 'ph', address: 'Unknown', body: 'hei' });
  const out = evictHealedPlaceholders([placeholder]);
  assert.deepEqual(out.map(m => m.id), ['ph']);
});

test('no placeholders → same array reference (cheap no-op on every merge)', () => {
  const list = [msg({ id: 'a' }), msg({ id: 'b', body: 'x' })];
  assert.equal(evictHealedPlaceholders(list), list);
});

test('two placeholders, one healed — only the healed one is dropped', () => {
  const ph1 = msg({ id: 'ph1', address: 'Unknown', body: 'healed' });
  const ph2 = msg({ id: 'ph2', address: 'Unknown', body: 'still orphan' });
  const real = msg({ id: 'real', body: 'healed' });
  const out = evictHealedPlaceholders([real, ph1, ph2]);
  assert.deepEqual(out.map(m => m.id).sort(), ['ph2', 'real']);
});

test('placeholder rows never heal each other', () => {
  const ph1 = msg({ id: 'ph1', address: 'Unknown', body: 'hei' });
  const ph2 = msg({ id: 'ph2', address: '', body: 'hei' });
  assert.equal(evictHealedPlaceholders([ph1, ph2]).length, 2);
});

console.log(`\n${passed} tests passed`);
