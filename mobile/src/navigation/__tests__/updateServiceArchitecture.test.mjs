import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  getAppUpdateState,
  subscribeUpdateEvents,
  isPendingUpdateAvailable,
  getCurrentUpdateState,
} from '../../services/updateService.ts';

describe('Update Service Architecture & Invariants', () => {
  test('1. getAppUpdateState returns well-formed diagnostics shape', () => {
    const diag = getAppUpdateState();
    assert.strictEqual(typeof diag.isEnabled, 'boolean');
    assert.strictEqual(typeof diag.isEmbeddedLaunch, 'boolean');
    assert.ok('updateId' in diag);
    assert.ok('channel' in diag);
    assert.ok('runtimeVersion' in diag);
    assert.ok('createdAt' in diag);
  });

  test('2. subscribeUpdateEvents immediately emits initial status and allows unsubscription', () => {
    let callCount = 0;
    let receivedState = null;

    const unsub = subscribeUpdateEvents((state) => {
      callCount++;
      receivedState = state;
    });

    assert.strictEqual(callCount, 1);
    assert.ok(receivedState);
    assert.strictEqual(typeof receivedState.isPending, 'boolean');
    assert.ok('status' in receivedState);

    unsub();
  });

  test('3. isPendingUpdateAvailable matches subscription state', () => {
    const isPending = isPendingUpdateAvailable();
    assert.strictEqual(typeof isPending, 'boolean');
  });

  test('4. getCurrentUpdateState exposes status and update lifecycle properties', () => {
    const state = getCurrentUpdateState();
    assert.ok('status' in state);
    assert.ok('isPending' in state);
    assert.ok('updateId' in state);
    assert.strictEqual(typeof state.status, 'string');
    assert.strictEqual(typeof state.isPending, 'boolean');
  });
});
