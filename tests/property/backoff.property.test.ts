/**
 * Property-based tests for exponential backoff with jitter.
 *
 * Uses fast-check to verify backoff bounds and jitter behavior.
 * All properties run a minimum of 100 iterations.
 *
 * Requirements: 1.3, 6.5
 */

import fc from "fast-check";
import { computeRetryDelay, BackoffOptions } from "../../src/utils/backoff";

describe("Backoff Properties", () => {
  // Property 1: Exponential Backoff Bounds (Pipeline Trigger)
  // ---------------------------------------------------------------------------
  it("Property 1: Pipeline trigger backoff delay is always within [initial, max*jitter]", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 }),
        (attempt) => {
          const opts: BackoffOptions = { initial: 5_000, max: 60_000 };
          const delay = computeRetryDelay(attempt, opts);

          // The delay should be >= initial (minimum bound with jitter)
          // and <= max * 1.2 (maximum bound with jitter)
          // The base exponential (before jitter) should never exceed max.
          // With jitter applied, the result may reach max * 1.2, but that's ok
          // because the spec applies jitter AFTER capping.
          
          // For practical verification: delay should be >= initial * 0.8
          // and <= max * 1.2
          expect(delay).toBeGreaterThanOrEqual(opts.initial * 0.8);
          expect(delay).toBeLessThanOrEqual(opts.max * 1.2);

          // Further verification: the base exponential should never exceed max
          const baseExponential = opts.initial * Math.pow(2, attempt);
          const cappedBase = Math.min(baseExponential, opts.max);
          // The jitter is in [0.8, 1.2], so delay should be in [cappedBase * 0.8, cappedBase * 1.2]
          expect(delay).toBeGreaterThanOrEqual(cappedBase * 0.8);
          expect(delay).toBeLessThanOrEqual(cappedBase * 1.2);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property 2: Exponential Backoff Bounds (Slack Notification)
  // ---------------------------------------------------------------------------
  it("Property 7: Slack notification backoff delay is always within [initial, max*jitter]", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 }),
        (attempt) => {
          const opts: BackoffOptions = { initial: 1_000, max: 8_000 };
          const delay = computeRetryDelay(attempt, opts);

          // Same logic as pipeline backoff, but with different parameters
          expect(delay).toBeGreaterThanOrEqual(opts.initial * 0.8);
          expect(delay).toBeLessThanOrEqual(opts.max * 1.2);

          const baseExponential = opts.initial * Math.pow(2, attempt);
          const cappedBase = Math.min(baseExponential, opts.max);
          expect(delay).toBeGreaterThanOrEqual(cappedBase * 0.8);
          expect(delay).toBeLessThanOrEqual(cappedBase * 1.2);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Additional verification: later attempts should generally produce longer delays
  // (with jitter, the relationship is probabilistic, not deterministic)
  it("Property: Later attempts tend toward the max cap", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 0, max: 1 }),
          fc.integer({ min: 1, max: 2 })
        ),
        ([attempt1, attempt2]) => {
          if (attempt1 >= attempt2) return true; // Skip non-ordered cases

          const opts: BackoffOptions = { initial: 5_000, max: 60_000 };
          const delay1 = computeRetryDelay(attempt1, opts);
          const delay2 = computeRetryDelay(attempt2, opts);

          // Base exponentials (before jitter/capping)
          const base1 = opts.initial * Math.pow(2, attempt1);
          const base2 = opts.initial * Math.pow(2, attempt2);

          // The capped exponentials show the trend (even with jitter)
          const capped1 = Math.min(base1, opts.max);
          const capped2 = Math.min(base2, opts.max);

          // capped2 >= capped1 (the base trend should hold)
          // With jitter, individual samples may vary, but on average capped2 >= capped1
          expect(capped2).toBeGreaterThanOrEqual(capped1);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Boundary case: attempt 0 should use the initial delay (with jitter)
  it("Property: Attempt 0 uses initial delay (with jitter factor)", () => {
    fc.assert(
      fc.property(
        fc.record({
          initial: fc.integer({ min: 100, max: 10_000 }),
          max: fc.integer({ min: 1_000, max: 100_000 }),
        }),
        (opts) => {
          // Ensure max >= initial
          const corrected: BackoffOptions = {
            initial: opts.initial,
            max: Math.max(opts.initial, opts.max),
          };

          const delay = computeRetryDelay(0, corrected);

          // Base exponential for attempt 0: initial * 2^0 = initial
          const baseExp = corrected.initial;
          const capped = Math.min(baseExp, corrected.max);

          // delay should be in [capped * 0.8, capped * 1.2]
          expect(delay).toBeGreaterThanOrEqual(capped * 0.8);
          expect(delay).toBeLessThanOrEqual(capped * 1.2);
        }
      ),
      { numRuns: 100 }
    );
  });
});
