# circuit-break-tools

A small circuit breaker for JavaScript with a deliberate half-open probing policy: exactly one probe is admitted at a time.

```js
import { CircuitBreaker, ProbeOutcome } from 'circuit-break-tools';

const breaker = new CircuitBreaker({
  failureThreshold: 3,
  resetTimeoutMs: 5_000,
});

const result = await breaker.execute(() => fetch('https://example.test/data'));

if (result.outcome === ProbeOutcome.SUCCESS) {
  console.log('ok', result.value);
} else if (result.outcome === ProbeOutcome.FAILURE) {
  console.error('downstream failed', result.error);
} else {
  console.warn('breaker is open; call skipped');
}
```

## Why this exists

A breaker that only counts failures is easy to write, but the recovery path is where implementations tend to get vague. When the reset window elapses, do you send the full load back, or one request? Sending everything back at once is what knocks over a dependency that is still warming up. This library sends exactly one probe and waits for it to resolve before admitting another, so a flapping dependency is never hit by a thundering herd from this process.

The trade-off is throughput during recovery. A single in-flight probe means that while the probe is pending, every other caller gets `ProbeOutcome.REJECTED` even though the dependency might be healthy. That is intentional: the state machine stays simple and the failure mode is "reject fast" rather than "guess whether it is safe yet".

## API

### `new CircuitBreaker(options?)`

- `options.failureThreshold` (positive integer, default `5`): consecutive failures that trip the breaker.
- `options.resetTimeoutMs` (positive integer, default `30000`): milliseconds to stay open before a probe is allowed.
- `options.now` (function returning milliseconds, default `Date.now`): injected clock. Tests should pass a fake clock; nothing in the library reads wall-clock time directly.

Properties: `state` (`'closed'`, `'open'`, or `'half-open'`) and `failureCount`.

### `breaker.execute(operation)`

Runs `operation`, which may return a value or a promise. Resolves to an object, never rejects for operation errors:

- `{ outcome: ProbeOutcome.SUCCESS, value }`
- `{ outcome: ProbeOutcome.FAILURE, error }`
- `{ outcome: ProbeOutcome.REJECTED }`

Throws a `TypeError` synchronously if `operation` is not a function.

### `ProbeOutcome`

A frozen object: `SUCCESS`, `FAILURE`, `REJECTED`.

## The awkward edge

Because state transitions are lazy, reading `breaker.state` after the reset window has elapsed reports `'half-open'` even though no probe has been admitted yet. The transition is materialised by the next call to `execute`. If you need to observe the transition itself, call `execute` — there is no event emitter and no background timer, which keeps the library free of scheduling surprises.

## Design notes

The window stores values eagerly rather than keeping running aggregates. Running
sums drift with floating point over long streams, and recomputing from a small
buffer is cheap enough that the drift is not worth the speed.

