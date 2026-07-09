// Unit tests for lib/permissionsStatus.ts (permission-ping web side,
// 2026-07-09). Runner-less by design — run with Node's native type stripping:
//
//   node tests/permissions-status.test.ts
//
// Exits non-zero on the first failing assertion.

import { strict as assert } from 'node:assert';
import {
  UNKNOWN_PERMISSIONS_STATUS,
  PERMISSION_LABEL,
  mergePermissionsStatus,
  fixPermissionFrame,
  GET_PERMISSIONS_STATUS_FRAME,
  PERMISSION_REFRESH_BACKOFF_MS,
  type PermissionsStatus,
} from '../lib/permissionsStatus.ts';

let passed = 0;
function test(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// ---------- mergePermissionsStatus -----------------------------------------

test('initial state is all-null (unknown)', () => {
  assert.deepEqual(UNKNOWN_PERMISSIONS_STATUS, {
    sms: null, callLog: null, contacts: null, notifications: null,
  });
});

test('full payload overwrites every key', () => {
  const next = mergePermissionsStatus(UNKNOWN_PERMISSIONS_STATUS, {
    sms: true, callLog: false, contacts: true, notifications: false,
  });
  assert.deepEqual(next, { sms: true, callLog: false, contacts: true, notifications: false });
});

test('partial payload merges — missing keys keep previous value', () => {
  const prev: PermissionsStatus = { sms: true, callLog: false, contacts: null, notifications: true };
  const next = mergePermissionsStatus(prev, { callLog: true });
  assert.deepEqual(next, { sms: true, callLog: true, contacts: null, notifications: true });
});

test('a partial frame never resets a known key back to unknown', () => {
  const prev: PermissionsStatus = { sms: false, callLog: true, contacts: true, notifications: false };
  const next = mergePermissionsStatus(prev, {});
  assert.deepEqual(next, prev);
});

test('non-boolean junk values are ignored, not coerced', () => {
  const prev: PermissionsStatus = { sms: true, callLog: null, contacts: null, notifications: null };
  const next = mergePermissionsStatus(prev, {
    sms: 'false', callLog: 1, contacts: null, notifications: undefined,
  });
  assert.deepEqual(next, prev);
});

test('null / undefined / non-object payloads are safe no-ops', () => {
  const prev: PermissionsStatus = { sms: true, callLog: false, contacts: null, notifications: null };
  assert.deepEqual(mergePermissionsStatus(prev, null), prev);
  assert.deepEqual(mergePermissionsStatus(prev, undefined), prev);
});

test('does not mutate the previous state object', () => {
  const prev: PermissionsStatus = { ...UNKNOWN_PERMISSIONS_STATUS };
  mergePermissionsStatus(prev, { sms: true });
  assert.deepEqual(prev, UNKNOWN_PERMISSIONS_STATUS);
});

test('legacy NOTIFICATION_PERMISSION mirror shape merges cleanly', () => {
  // usePhoneBridge mirrors {notifications: payload.granted === true} into the map
  const next = mergePermissionsStatus(UNKNOWN_PERMISSIONS_STATUS, { notifications: true });
  assert.equal(next.notifications, true);
  assert.equal(next.sms, null);
});

// ---------- fixPermissionFrame ----------------------------------------------

test('notifications routes to the legacy REQUEST_NOTIFICATION_ACCESS command', () => {
  assert.equal(fixPermissionFrame('notifications'), 'REQUEST_NOTIFICATION_ACCESS:{}');
});

test('sms / callLog / contacts use the v49 REQUEST_PERMISSION command', () => {
  assert.equal(fixPermissionFrame('sms'), 'REQUEST_PERMISSION:{"permission":"sms"}');
  assert.equal(fixPermissionFrame('callLog'), 'REQUEST_PERMISSION:{"permission":"callLog"}');
  assert.equal(fixPermissionFrame('contacts'), 'REQUEST_PERMISSION:{"permission":"contacts"}');
});

test('GET_PERMISSIONS_STATUS frame matches the locked protocol name', () => {
  assert.equal(GET_PERMISSIONS_STATUS_FRAME, 'GET_PERMISSIONS_STATUS:{}');
});

// ---------- misc -------------------------------------------------------------

test('refresh backoff is the 5s/15s/30s schedule from the brief', () => {
  assert.deepEqual([...PERMISSION_REFRESH_BACKOFF_MS], [5000, 15000, 30000]);
});

test('every permission key has a human label', () => {
  for (const key of ['sms', 'callLog', 'contacts', 'notifications'] as const) {
    assert.ok(PERMISSION_LABEL[key].length > 0);
  }
});

console.log(`\npermissions-status: ${passed} tests passed`);
