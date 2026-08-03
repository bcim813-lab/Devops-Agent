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
export interface BackoffOptions {
    /** Base delay for attempt 0. Units (ms or s) are determined by the caller. */
    initial: number;
    /** Hard ceiling on the computed delay. Must use the same units as `initial`. */
    max: number;
}
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
export declare function computeRetryDelay(attempt: number, opts: BackoffOptions): number;
/**
 * Pre-configured backoff options for the Pipeline_Agent Jenkins trigger/poll retries.
 * initial: 5 s, max: 60 s (in seconds, as used by property tests).
 */
export declare const PIPELINE_BACKOFF: BackoffOptions;
/**
 * Pre-configured backoff options for the Notification_Agent Slack delivery retries.
 * initial: 1 s, max: 8 s (in seconds, as used by property tests).
 */
export declare const NOTIFICATION_BACKOFF: BackoffOptions;
/**
 * Pre-configured backoff options for the Pipeline_Agent in milliseconds.
 * initial: 5000 ms, max: 60000 ms.
 */
export declare const PIPELINE_BACKOFF_MS: BackoffOptions;
/**
 * Pre-configured backoff options for the Notification_Agent in milliseconds.
 * initial: 1000 ms, max: 8000 ms.
 */
export declare const NOTIFICATION_BACKOFF_MS: BackoffOptions;
//# sourceMappingURL=backoff.d.ts.map