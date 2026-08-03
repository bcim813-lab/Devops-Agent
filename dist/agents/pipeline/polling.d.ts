/**
 * Pipeline polling logic for the Pipeline_Agent.
 *
 * Responsibilities:
 *  - Poll Jenkins every 30 s while a run is in_progress.
 *  - On a poll failure, retry once after 10 s; if the retry also fails,
 *    emit `PipelinePollFailureEvent` to the Orchestrator.
 *  - When elapsed time exceeds `max_duration_seconds` (positive integer),
 *    emit `PipelineTimeoutEvent`. If `max_duration_seconds` is null/undefined,
 *    skip timeout monitoring entirely.
 *  - Emit `PipelineCompletedEvent` within 10 s of detecting a terminal state.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5
 */
import type { PipelineStatus, PollError, Result } from "../../types/models";
import type { OutboundEvent } from "../../interfaces/shared";
import { StructuredLogger } from "../../utils/logger";
/**
 * Minimal contract for the Jenkins client required by the poller.
 * The concrete implementation is injected at construction time.
 */
export interface JenkinsClient {
    /**
     * Fetch the current status of the given pipeline run from Jenkins.
     * Returns Ok(PipelineStatus) on success or Err(PollError) on failure.
     */
    getPipelineStatus(runId: string): Promise<Result<PipelineStatus, PollError>>;
}
export interface PollConfig {
    /** The Jenkins run ID to monitor. */
    pipelineRunId: string;
    /** The repository name associated with this run. */
    repositoryName: string;
    /** The branch name associated with this run. */
    branchName: string;
    /**
     * Maximum allowed run duration in seconds.
     * Must be a positive integer. null / undefined = skip timeout monitoring.
     */
    maxDurationSeconds?: number | null;
    /** ISO 8601 timestamp when polling started (defaults to now if omitted). */
    startTimestamp?: string;
    /** How long to wait between normal poll cycles (ms). Default: 30_000. */
    pollIntervalMs?: number;
    /** How long to wait before the single poll retry (ms). Default: 10_000. */
    retryDelayMs?: number;
}
/** Callback invoked by the poller to emit outbound events to the Orchestrator. */
export type OrchestratorEmit = (event: OutboundEvent) => void;
/**
 * Manages the poll-loop for a single Jenkins pipeline run.
 *
 * Usage:
 * ```ts
 * const poller = new PipelinePoller(jenkinsClient, orchestratorEmit, logger);
 * await poller.start(config);
 * ```
 *
 * The `start()` method drives the entire lifecycle until the run reaches a
 * terminal state, times out (if configured), or is stopped via `stop()`.
 */
export declare class PipelinePoller {
    private readonly client;
    private readonly emit;
    private readonly logger;
    /** Set to true by `stop()` to break the poll loop early. */
    private stopped;
    constructor(client: JenkinsClient, emit: OrchestratorEmit, logger: StructuredLogger);
    /**
     * Stop the poll loop after the current iteration completes.
     * Safe to call multiple times.
     */
    stop(): void;
    /**
     * Start polling until a terminal state is detected, a timeout fires,
     * or `stop()` is called.
     *
     * This method resolves when the loop exits for any reason.
     */
    start(config: PollConfig): Promise<void>;
    /**
     * Attempt a single poll; on failure wait `retryDelayMs` and retry once.
     * Returns Ok(PipelineStatus) or Err(PollError) if both attempts fail.
     */
    private pollWithRetry;
    /**
     * Emit `PipelinePollFailureEvent` to the Orchestrator.
     * Requirements: 2.1
     */
    private emitPollFailure;
    /**
     * Emit `PipelineTimeoutEvent` to the Orchestrator.
     * Requirements: 2.3
     */
    private emitTimeout;
    /**
     * Emit `PipelineCompletedEvent` to the Orchestrator.
     * Must be called within 10 s of detecting a terminal state (Requirements: 2.2).
     * The event is emitted synchronously — the caller is responsible for ensuring
     * no blocking work is done before calling this method.
     */
    private emitCompleted;
    /**
     * Validate and convert `max_duration_seconds` to milliseconds.
     *
     * - null / undefined → returns null (skip timeout monitoring).
     * - Positive integer → returns value * 1000.
     * - Non-positive, non-integer, or NaN → throws RangeError (config error).
     */
    private resolveMaxDuration;
}
/**
 * Standalone wrapper that performs a single Jenkins poll with a one-time retry,
 * matching the `Pipeline_Agent.pollPipelineStatus()` interface method signature.
 *
 * The orchestration loop (interval timing, timeout detection, event emission)
 * is handled by `PipelinePoller.start()`. This function is suitable for
 * use-cases where only a single status fetch (with retry) is needed.
 *
 * On first attempt success  → Ok(PipelineStatus)
 * On first failure          → waits `retryDelayMs`, retries once
 * On retry success          → Ok(PipelineStatus)
 * On retry failure          → Err(PollError)
 */
export declare function pollPipelineStatus(runId: string, client: JenkinsClient, retryDelayMs?: number): Promise<Result<PipelineStatus, PollError>>;
//# sourceMappingURL=polling.d.ts.map