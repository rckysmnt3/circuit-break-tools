// A minimal circuit breaker focused on half-open probing.
//
// The interesting part of a breaker is the half-open state: after a failure burst
// we want to let a small number of probes through to discover whether the
// downstream dependency recovered, without stampeding it with the full traffic.
// This implementation makes two deliberate choices:
//
//   1. Time is injected as a `now()` function returning milliseconds. Tests pass a
//      fake clock; production callers pass `Date.now` (or the default). This keeps
//      the library deterministic under test and avoids any hidden timer machinery.
//   2. Half-open admits exactly one probe at a time. Additional callers are rejected
//      with `ProbeOutcome.REJECTED` until the in-flight probe resolves. This is the
//      simplest correct policy and avoids needing to reason about partial success
//      across concurrent probes.

export const ProbeOutcome = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  REJECTED: 'rejected',
});

const DEFAULT_OPTIONS = Object.freeze({
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  now: () => Date.now(),
});

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

/**
 * A three-state circuit breaker: closed, open, half-open.
 *
 * - `closed`: calls pass through. Consecutive failures are counted; once the
 *   count reaches `failureThreshold` the breaker trips to `open`.
 * - `open`: calls are rejected without invoking the operation. After
 *   `resetTimeoutMs` has elapsed since the trip, the breaker transitions to
 *   `half-open` on the next call.
 * - `half-open`: exactly one probe is allowed through. Its result decides the
 *   next state: success closes the breaker, failure re-opens it and restarts the
 *   reset timer.
 */
export class CircuitBreaker {
  /**
   * @param {object} [options]
   * @param {number} [options.failureThreshold=5] consecutive failures that trip the breaker.
   * @param {number} [options.resetTimeoutMs=30000] ms to wait in `open` before probing.
   * @param {() => number} [options.now] clock returning epoch milliseconds.
   */
  constructor(options = {}) {
    const merged = { ...DEFAULT_OPTIONS, ...options };
    assertPositiveInteger(merged.failureThreshold, 'failureThreshold');
    assertPositiveInteger(merged.resetTimeoutMs, 'resetTimeoutMs');
    if (typeof merged.now !== 'function') {
      throw new TypeError('now must be a function returning milliseconds');
    }

    this.failureThreshold = merged.failureThreshold;
    this.resetTimeoutMs = merged.resetTimeoutMs;
    this._now = merged.now;

    this._state = 'closed';
    this._failureCount = 0;
    this._openedAt = 0;
    this._probeInFlight = false;
  }

  /** Current state: 'closed', 'open', or 'half-open'. */
  get state() {
    // Reading state must not mutate it, but the transition from open to
    // half-open is time-based. We expose the *logical* state here without
    // consuming the probe; the transition is materialised lazily by `execute`.
    if (this._state === 'open' && this._elapsed() >= this.resetTimeoutMs) {
      return 'half-open';
    }
    return this._state;
  }

  /** Consecutive failures recorded while closed. Resets on success. */
  get failureCount() {
    return this._failureCount;
  }

  /**
   * Run `operation` through the breaker.
   *
   * @template T
   * @param {() => T | Promise<T>} operation
   * @returns {Promise<{ outcome: string, value?: T, error?: unknown }>}
   *   `outcome` is one of `ProbeOutcome`. Rejections are reported as data rather
   *   than thrown, so callers can distinguish "breaker said no" from "operation
   *   threw" without catching.
   */
  async execute(operation) {
    if (typeof operation !== 'function') {
      throw new TypeError('operation must be a function');
    }

    if (this._state === 'open') {
      if (this._elapsed() >= this.resetTimeoutMs) {
        this._state = 'half-open';
        this._probeInFlight = false;
      } else {
        return { outcome: ProbeOutcome.REJECTED };
      }
    }

    if (this._state === 'half-open') {
      if (this._probeInFlight) {
        return { outcome: ProbeOutcome.REJECTED };
      }
      this._probeInFlight = true;
    }

    let value;
    try {
      value = await operation();
    } catch (error) {
      this._onFailure();
      return { outcome: ProbeOutcome.FAILURE, error };
    }

    this._onSuccess();
    return { outcome: ProbeOutcome.SUCCESS, value };
  }

  _elapsed() {
    return this._now() - this._openedAt;
  }

  _onSuccess() {
    this._state = 'closed';
    this._failureCount = 0;
    this._probeInFlight = false;
  }

  _onFailure() {
    if (this._state === 'half-open') {
      // A failed probe re-opens the breaker and restarts the reset window.
      this._state = 'open';
      this._openedAt = this._now();
      this._probeInFlight = false;
      return;
    }

    this._failureCount += 1;
    if (this._failureCount >= this.failureThreshold) {
      this._state = 'open';
      this._openedAt = this._now();
    }
  }
}
