import test from 'node:test';
import assert from 'node:assert/strict';

import { CircuitBreaker, ProbeOutcome } from '../src/index.js';

// A deterministic clock: tests advance it explicitly instead of sleeping.
function makeClock(start = 1_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function failing() {
  return Promise.reject(new Error('boom'));
}

function succeeding(value) {
  return Promise.resolve(value);
}

test('passes through when closed and counts consecutive failures', async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 100, now: clock.now });

  assert.equal(breaker.state, 'closed');
  const ok = await breaker.execute(() => succeeding(42));
  assert.deepEqual(ok, { outcome: ProbeOutcome.SUCCESS, value: 42 });
  assert.equal(breaker.failureCount, 0);

  await breaker.execute(failing);
  await breaker.execute(failing);
  assert.equal(breaker.failureCount, 2);
  assert.equal(breaker.state, 'closed');
});

test('success resets the consecutive failure count', async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 100, now: clock.now });

  await breaker.execute(failing);
  await breaker.execute(failing);
  assert.equal(breaker.failureCount, 2);

  await breaker.execute(() => succeeding('ok'));
  assert.equal(breaker.failureCount, 0);
  assert.equal(breaker.state, 'closed');
});

test('trips open once the threshold is reached', async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 100, now: clock.now });

  await breaker.execute(failing);
  await breaker.execute(failing);
  assert.equal(breaker.state, 'open');
});

test('rejects calls while open and before the reset window elapses', async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: clock.now });

  await breaker.execute(failing);
  assert.equal(breaker.state, 'open');

  let called = false;
  const result = await breaker.execute(() => {
    called = true;
    return succeeding('nope');
  });
  assert.deepEqual(result, { outcome: ProbeOutcome.REJECTED });
  assert.equal(called, false, 'operation must not run while open');
});

test('transitions to half-open after the reset window', async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: clock.now });

  await breaker.execute(failing);
  clock.advance(100);
  assert.equal(breaker.state, 'half-open');
});

test('a successful probe closes the breaker', async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: clock.now });

  await breaker.execute(failing);
  clock.advance(100);

  const result = await breaker.execute(() => succeeding('recovered'));
  assert.deepEqual(result, { outcome: ProbeOutcome.SUCCESS, value: 'recovered' });
  assert.equal(breaker.state, 'closed');
  assert.equal(breaker.failureCount, 0);
});

test('a failed probe re-opens and restarts the reset window', async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: clock.now });

  await breaker.execute(failing);
  clock.advance(100);

  const result = await breaker.execute(failing);
  assert.equal(result.outcome, ProbeOutcome.FAILURE);
  assert.equal(breaker.state, 'open');

  // Only 50ms have passed since the failed probe, so still open.
  clock.advance(50);
  assert.equal(breaker.state, 'open');
  const rejected = await breaker.execute(() => succeeding('x'));
  assert.deepEqual(rejected, { outcome: ProbeOutcome.REJECTED });

  // Another 50ms reaches the new window.
  clock.advance(50);
  assert.equal(breaker.state, 'half-open');
});

test('only one probe is admitted at a time in half-open', async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: clock.now });

  await breaker.execute(failing);
  clock.advance(100);

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const first = breaker.execute(async () => {
    await gate;
    return 'first';
  });

  // Give the first call a tick to register its in-flight probe.
  await Promise.resolve();

  const second = await breaker.execute(() => succeeding('second'));
  assert.deepEqual(second, { outcome: ProbeOutcome.REJECTED });

  release();
  const firstResult = await first;
  assert.deepEqual(firstResult, { outcome: ProbeOutcome.SUCCESS, value: 'first' });
  assert.equal(breaker.state, 'closed');
});

test('reports operation errors as FAILURE outcomes, not thrown rejections', async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 100, now: clock.now });

  const boom = new Error('downstream down');
  const result = await breaker.execute(() => Promise.reject(boom));
  assert.equal(result.outcome, ProbeOutcome.FAILURE);
  assert.equal(result.error, boom);
  assert.equal(breaker.failureCount, 1);
});

test('rejects invalid constructor options', () => {
  assert.throws(() => new CircuitBreaker({ failureThreshold: 0 }), RangeError);
  assert.throws(() => new CircuitBreaker({ failureThreshold: 1.5 }), RangeError);
  assert.throws(() => new CircuitBreaker({ resetTimeoutMs: -1 }), RangeError);
  assert.throws(() => new CircuitBreaker({ now: 123 }), TypeError);
});

test('rejects a non-function operation', async () => {
  const clock = makeClock();
  const breaker = new CircuitBreaker({ now: clock.now });
  await assert.rejects(() => breaker.execute('not a function'), TypeError);
});

test('exposes a frozen ProbeOutcome enum', () => {
  assert.ok(Object.isFrozen(ProbeOutcome));
  assert.equal(ProbeOutcome.SUCCESS, 'success');
  assert.equal(ProbeOutcome.FAILURE, 'failure');
  assert.equal(ProbeOutcome.REJECTED, 'rejected');
});
