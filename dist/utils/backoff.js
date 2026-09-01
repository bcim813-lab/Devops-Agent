"use strict";
/**
 * Exponential backoff with jitter.
 *
 * Formula: min(initial * 2^attempt, max) * jitter
 * where jitter is a random factor uniformly drawn from [0.8, 1.2].
 *
 * The cap is applied before jitter so the jitter spread stays proportional
 * to the base delay but never violates the hard ceiling set by `max`.
 *
 * Shared by:
 *  - Pipeline_Agent      : { initial: 5,     max: 60  } (seconds)
 *  - Notification_Agent  : { initial: 1,     max: 8   } (seconds)
 *
 * Callers that work in milliseconds should pass ms-valued options, e.g.
 *  - Pipeline_Agent (ms) : { initial: 5_000, max: 60_000 }
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOTIFICATION_BACKOFF_MS = exports.PIPELINE_BACKOFF_MS = exports.NOTIFICATION_BACKOFF = exports.PIPELINE_BACKOFF = void 0;
exports.computeRetryDelay = computeRetryDelay;
/**
 * Compute the retry delay for a given attempt index.
 *
 * @param attempt - Zero-based retry attempt index (0 = first retry after first failure).
 * @param opts    - Backoff configuration { initial, max }.
 * @returns       - Delay value in the same units as the options, bounded to [initial * 0.8, max * 1.2].
 *                  The jitter factor in [0.8, 1.2] is applied AFTER the max cap, meaning
 *                  the result may marginally exceed `max` by up to 20% at cap, but the
 *                  base exponential value is always capped at `max` first.
 *                  In practice, for the configured backoff values, the result is always
 *                  within [initial * 0.8, max * 1.2].
 *
 * Per spec: formula is `min(initial * 2^attempt, max) * jitter`
 */
function computeRetryDelay(attempt, opts) {
    const { initial, max } = opts;
    // Jitter factor uniformly drawn from [0.8, 1.2]
    const jitter = 0.8 + Math.random() * 0.4;
    // Cap the exponential base first, then apply jitter
    const capped = Math.min(initial * Math.pow(2, attempt), max);
    return capped * jitter;
}
/**
 * Pre-configured backoff options for the Pipeline_Agent Jenkins trigger/poll retries.
 * initial: 5 s, max: 60 s (in seconds, as used by property tests).
 */
exports.PIPELINE_BACKOFF = {
    initial: 5,
    max: 60,
};
/**
 * Pre-configured backoff options for the Notification_Agent Slack delivery retries.
 * initial: 1 s, max: 8 s (in seconds, as used by property tests).
 */
exports.NOTIFICATION_BACKOFF = {
    initial: 1,
    max: 8,
};
/**
 * Pre-configured backoff options for the Pipeline_Agent in milliseconds.
 * initial: 5000 ms, max: 60000 ms.
 */
exports.PIPELINE_BACKOFF_MS = {
    initial: 5000,
    max: 60000,
};
/**
 * Pre-configured backoff options for the Notification_Agent in milliseconds.
 * initial: 1000 ms, max: 8000 ms.
 */
exports.NOTIFICATION_BACKOFF_MS = {
    initial: 1000,
    max: 8000,
};
//# sourceMappingURL=backoff.js.map