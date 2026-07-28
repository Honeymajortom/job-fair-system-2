// Minimal circuit breaker — no new dependency, matches this project's
// hand-rolled-utility convention (lib/bufferController.js, lib/travelBuffer.js
// etc. are the same style: a small self-contained module over a well-known
// formula/pattern instead of pulling in a library for it).
//
// Three states: closed (normal — every call actually reaches the dependency),
// open (fast-fail — no call ever reaches the dependency until the cooldown
// elapses), half_open (one/few trial calls allowed through to test recovery;
// a single success closes the breaker again, a single failure reopens it and
// restarts the cooldown).
class CircuitBreaker {
  constructor({ failureThreshold = 5, resetTimeoutMs = 15000, halfOpenMaxConcurrent = 1 } = {}) {
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.halfOpenMaxConcurrent = halfOpenMaxConcurrent;
    this.state = 'closed';
    this.failureCount = 0;
    this.openedAt = 0;
    this.halfOpenInFlight = 0;
  }

  // Runs fn() if the breaker allows it; otherwise throws synchronously
  // (well, rejects) without ever invoking fn — that's the whole point: a
  // caller that already treats a thrown/rejected dependency call as "fall
  // back" (every Redis call site in this app does) gets that fallback
  // instantly instead of re-paying a connect/command timeout on every single
  // request while the dependency is degraded.
  async exec(fn) {
    if (this.state === 'open') {
      if (Date.now() - this.openedAt < this.resetTimeoutMs) {
        throw new Error('circuit_open');
      }
      // Cooldown elapsed — allow a bounded number of trial calls through
      // ("limited concurrency to that dependency" while it's still unproven)
      // rather than snapping straight back to unlimited traffic.
      this.state = 'half_open';
      this.halfOpenInFlight = 0;
    }
    if (this.state === 'half_open') {
      if (this.halfOpenInFlight >= this.halfOpenMaxConcurrent) {
        throw new Error('circuit_open');
      }
      this.halfOpenInFlight++;
    }
    try {
      const result = await fn();
      this.failureCount = 0;
      this.state = 'closed';
      return result;
    } catch (err) {
      this.failureCount++;
      if (this.state === 'half_open' || this.failureCount >= this.failureThreshold) {
        this.state = 'open';
        this.openedAt = Date.now();
        this.failureCount = 0;
      }
      throw err;
    } finally {
      if (this.state === 'half_open') this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
    }
  }
}

module.exports = { CircuitBreaker };
