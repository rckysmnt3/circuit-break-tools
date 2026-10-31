// Public surface for circuit-break-tools. Keep this file thin: it exists so that
// consumers have a single stable import path, while the implementation stays in
// core.js where it can be tested without pulling in re-exports.
export { CircuitBreaker, ProbeOutcome } from './core.js';
