import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  canTransition,
  A2A_TERMINAL_STATES,
  A2A_INTERRUPTED_STATES,
  A2A_ERROR,
  A2A_METHODS,
} from '../src/mcp/a2aCompliance';
import type { A2ATaskState } from '../src/mcp/a2aCompliance';

describe('A2A State Machine', () => {
  it('allows valid transitions from SUBMITTED', () => {
    assert.ok(canTransition('SUBMITTED', 'WORKING'));
    assert.ok(canTransition('SUBMITTED', 'COMPLETED'));
    assert.ok(canTransition('SUBMITTED', 'FAILED'));
    assert.ok(canTransition('SUBMITTED', 'CANCELED'));
    assert.ok(canTransition('SUBMITTED', 'REJECTED'));
  });

  it('rejects invalid transitions from SUBMITTED', () => {
    assert.ok(!canTransition('SUBMITTED', 'INPUT_REQUIRED'));
    assert.ok(!canTransition('SUBMITTED', 'AUTH_REQUIRED'));
    assert.ok(!canTransition('SUBMITTED', 'SUBMITTED'));
  });

  it('allows valid transitions from WORKING', () => {
    assert.ok(canTransition('WORKING', 'COMPLETED'));
    assert.ok(canTransition('WORKING', 'FAILED'));
    assert.ok(canTransition('WORKING', 'CANCELED'));
    assert.ok(canTransition('WORKING', 'INPUT_REQUIRED'));
    assert.ok(canTransition('WORKING', 'AUTH_REQUIRED'));
  });

  it('terminal states have no outgoing transitions', () => {
    for (const state of A2A_TERMINAL_STATES) {
      assert.ok(!canTransition(state as A2ATaskState, 'WORKING'));
      assert.ok(!canTransition(state as A2ATaskState, 'COMPLETED'));
      assert.ok(!canTransition(state as A2ATaskState, 'FAILED'));
    }
  });

  it('interrupted states can return to WORKING or CANCELED', () => {
    assert.ok(canTransition('INPUT_REQUIRED', 'WORKING'));
    assert.ok(canTransition('INPUT_REQUIRED', 'CANCELED'));
    assert.ok(canTransition('AUTH_REQUIRED', 'WORKING'));
    assert.ok(canTransition('AUTH_REQUIRED', 'CANCELED'));
  });

  it('A2A_TERMINAL_STATES includes all 4 terminal states', () => {
    assert.ok(A2A_TERMINAL_STATES.has('COMPLETED'));
    assert.ok(A2A_TERMINAL_STATES.has('FAILED'));
    assert.ok(A2A_TERMINAL_STATES.has('CANCELED'));
    assert.ok(A2A_TERMINAL_STATES.has('REJECTED'));
    assert.strictEqual(A2A_TERMINAL_STATES.size, 4);
  });

  it('A2A_INTERRUPTED_STATES includes non-terminal blocking states', () => {
    assert.ok(A2A_INTERRUPTED_STATES.has('INPUT_REQUIRED'));
    assert.ok(A2A_INTERRUPTED_STATES.has('AUTH_REQUIRED'));
    assert.strictEqual(A2A_INTERRUPTED_STATES.size, 2);
  });

  it('A2A_ERROR codes are unique', () => {
    const codes = Object.values(A2A_ERROR);
    const unique = new Set(codes);
    assert.strictEqual(codes.length, unique.size);
  });

  it('A2A_METHODS covers all required methods', () => {
    const required = [
      'message/send',
      'message/stream',
      'tasks/get',
      'tasks/list',
      'tasks/cancel',
      'tasks/resubscribe',
      'agent/getCard',
    ];
    for (const method of required) {
      assert.ok(Object.values(A2A_METHODS).includes(method), `Missing: ${method}`);
    }
  });
});
