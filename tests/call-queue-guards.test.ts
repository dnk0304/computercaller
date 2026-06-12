// Unit tests for lib/callQueueGuards.ts (B1 ringing TTL + B3 empty-number
// active+active collapse). Runner-less by design — this repo has no Jest/
// Vitest harness; run directly with Node's native type stripping:
//
//   node tests/call-queue-guards.test.ts
//
// Exits non-zero on the first failing assertion.

import { strict as assert } from 'node:assert';
import {
  RINGING_TTL_MS,
  expiredRingingCallIds,
  findEmptyNumberActiveFold,
} from '../lib/callQueueGuards.ts';
import type { CallInfo } from '../hooks/phoneTypes.ts';

const NOW = 1_750_000_000_000;

function call(partial: Partial<CallInfo> & { callId: string }): CallInfo {
  return {
    number: '+4791234567',
    isIncoming: true,
    startTime: NOW - 5_000,
    state: 'ringing',
    ...partial,
  };
}

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// ---- B1: expiredRingingCallIds ----------------------------------------

test('ringing row older than TTL expires', () => {
  const calls = [call({ callId: 'a' })];
  const touched = new Map([['a', NOW - RINGING_TTL_MS - 1]]);
  assert.deepEqual(expiredRingingCallIds(calls, touched, NOW), ['a']);
});

test('ringing row within TTL does NOT expire', () => {
  const calls = [call({ callId: 'a' })];
  const touched = new Map([['a', NOW - RINGING_TTL_MS + 1_000]]);
  assert.deepEqual(expiredRingingCallIds(calls, touched, NOW), []);
});

test('ACTIVE row never expires, even when ancient', () => {
  const calls = [call({ callId: 'a', state: 'active' })];
  const touched = new Map([['a', NOW - 10 * RINGING_TTL_MS]]);
  assert.deepEqual(expiredRingingCallIds(calls, touched, NOW), []);
});

test('dialing/held rows never expire', () => {
  const calls = [
    call({ callId: 'd', state: 'dialing' }),
    call({ callId: 'h', state: 'held' }),
  ];
  const touched = new Map([
    ['d', NOW - 10 * RINGING_TTL_MS],
    ['h', NOW - 10 * RINGING_TTL_MS],
  ]);
  assert.deepEqual(expiredRingingCallIds(calls, touched, NOW), []);
});

test('untouched row falls back to startTime (never un-expirable)', () => {
  const calls = [call({ callId: 'a', startTime: NOW - RINGING_TTL_MS - 1 })];
  assert.deepEqual(expiredRingingCallIds(calls, new Map(), NOW), ['a']);
});

test('a fresh event RESETS the TTL clock (re-confirmation rescue)', () => {
  const calls = [call({ callId: 'a', startTime: NOW - 5 * RINGING_TTL_MS })];
  const touched = new Map([['a', NOW - 1_000]]); // re-emitted INCOMING just now
  assert.deepEqual(expiredRingingCallIds(calls, touched, NOW), []);
});

test('mixed list: only the stale ringing rows expire', () => {
  const calls = [
    call({ callId: 'stale1' }),
    call({ callId: 'fresh' }),
    call({ callId: 'act', state: 'active' }),
    call({ callId: 'stale2', number: '' }),
  ];
  const touched = new Map([
    ['stale1', NOW - RINGING_TTL_MS - 5_000],
    ['fresh', NOW - 1_000],
    ['act', NOW - RINGING_TTL_MS - 5_000],
    ['stale2', NOW - RINGING_TTL_MS - 5_000],
  ]);
  assert.deepEqual(expiredRingingCallIds(calls, touched, NOW), ['stale1', 'stale2']);
});

// ---- B3: findEmptyNumberActiveFold ------------------------------------

test('active+active empty-number pair FOLDS', () => {
  const existing = call({ callId: 'old', number: '', state: 'active' });
  const got = findEmptyNumberActiveFold([existing], 'new', '', 'active');
  assert.equal(got?.callId, 'old');
});

test('ringing+ringing empty-number pair does NOT fold (SIM call-waiting)', () => {
  const existing = call({ callId: 'old', number: '', state: 'ringing' });
  assert.equal(findEmptyNumberActiveFold([existing], 'new', '', 'ringing'), undefined);
});

test('incoming active vs existing RINGING empty-number does NOT fold', () => {
  const existing = call({ callId: 'old', number: '', state: 'ringing' });
  assert.equal(findEmptyNumberActiveFold([existing], 'new', '', 'active'), undefined);
});

test('non-empty incoming number never uses the empty fold', () => {
  const existing = call({ callId: 'old', number: '', state: 'active' });
  assert.equal(
    findEmptyNumberActiveFold([existing], 'new', '+4791234567', 'active'),
    undefined
  );
});

test('same callId is not folded into itself (idempotent re-frame)', () => {
  const existing = call({ callId: 'same', number: '', state: 'active' });
  assert.equal(findEmptyNumberActiveFold([existing], 'same', '', 'active'), undefined);
});

console.log(`\n${passed} tests passed`);
