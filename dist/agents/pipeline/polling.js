"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.pollPipelineStatus = exports.PipelinePoller = void 0;
const uuid_1 = require("uuid");
// ---------------------------------------------------------------------------
// Terminal state helper
// ---------------------------------------------------------------------------
const TERMINAL_STATES = new Set(["success", "failure", "aborted"]);
function isTerminal(state) {
    return TERMINAL_STATES.has(state);
}
// ---------------------------------------------------------------------------
// Sleep helper
// ---------------------------------------------------------------------------
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// ---------------------------------------------------------------------------
// PipelinePoller
// ---------------------------------------------------------------------------
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
class PipelinePoller {
    constructor(client, emit, logger) {
        /** Set to true by `stop()` to break the poll loop early. */
        this.stopped = false;
        this.client = client;
        this.emit = emit;
        this.logger = logger;
    }
    /**
     * Stop the poll loop after the current iteration completes.
     * Safe to call multiple times.
     */
    stop() {
        this.stopped = true;
    }
    /**
     * Start polling until a terminal state is detected, a timeout fires,
     * or `stop()` is called.
     *
     * This method resolves when the loop exits for any reason.
     */
    async start(config) {
        this.stopped = false;
        const { pipelineRunId, repositoryName, branchName, maxDurationSeconds, pollIntervalMs = 30000, retryDelayMs = 10000, } = config;
        // Derive a correlationId for all events emitted during this run.
        // In production the Orchestrator re-stamps; this acts as a local trace ID.
        const correlationId = (0, uuid_1.v4)();
        const startTime = config.startTimestamp
            ? new Date(config.startTimestamp).getTime()
            : Date.now();
        // Validate max_duration_seconds: must be a positive integer if provided.
        const maxDurationMs = this.resolveMaxDuration(maxDurationSeconds);
        this.logger.info({
            action: "pollPipelineStatus.start",
            outcome: "pending",
            correlationId,
            params: {
                pipelineRunId,
                repositoryName,
                branchName,
                maxDurationSeconds: maxDurationSeconds ?? null,
                pollIntervalMs,
                retryDelayMs,
            },
        });
        while (!this.stopped) {
            // ── Timeout check (before polling so we catch elapsed time accurately) ──
            if (maxDurationMs !== null) {
                const elapsed = Date.now() - startTime;
                if (elapsed >= maxDurationMs) {
                    this.emitTimeout(pipelineRunId, maxDurationSeconds, correlationId);
                    return;
                }
            }
            // ── Poll attempt ──────────────────────────────────────────────────────
            const result = await this.pollWithRetry(pipelineRunId, repositoryName, branchName, correlationId, retryDelayMs);
            if (!result.success) {
                // Retry also failed — emit PipelinePollFailureEvent and stop.
                this.emitPollFailure(pipelineRunId, repositoryName, branchName, result.error.message, correlationId);
                return;
            }
            const status = result.value;
            // ── Terminal state detection ──────────────────────────────────────────
            if (isTerminal(status.state)) {
                const durationSeconds = status.durationSeconds !== null && status.durationSeconds >= 0
                    ? status.durationSeconds
                    : Math.round((Date.now() - startTime) / 1000);
                this.emitCompleted(pipelineRunId, repositoryName, branchName, status.state, durationSeconds, correlationId);
                return;
            }
            // ── Still in_progress — wait before next poll ─────────────────────────
            if (!this.stopped) {
                await sleep(pollIntervalMs);
            }
        }
    }
    // ---------------------------------------------------------------------------
    // Private helpers
    // ---------------------------------------------------------------------------
    /**
     * Attempt a single poll; on failure wait `retryDelayMs` and retry once.
     * Returns Ok(PipelineStatus) or Err(PollError) if both attempts fail.
     */
    async pollWithRetry(pipelineRunId, repositoryName, branchName, correlationId, retryDelayMs) {
        // First attempt
        const first = await this.client.getPipelineStatus(pipelineRunId);
        if (first.success) {
            this.logger.info({
                action: "pollPipelineStatus.poll",
                outcome: "success",
                correlationId,
                params: { pipelineRunId, state: first.value.state },
            });
            return first;
        }
        // First attempt failed — log and wait before retry
        this.logger.warn({
            action: "pollPipelineStatus.poll",
            outcome: "failure",
            correlationId,
            params: { pipelineRunId, repositoryName, branchName },
            errorMessage: first.error.message,
        });
        await sleep(retryDelayMs);
        if (this.stopped) {
            // Loop was stopped while waiting for retry — propagate the original error.
            return first;
        }
        // Single retry
        const retry = await this.client.getPipelineStatus(pipelineRunId);
        if (retry.success) {
            this.logger.info({
                action: "pollPipelineStatus.poll.retry",
                outcome: "success",
                correlationId,
                params: { pipelineRunId, state: retry.value.state },
            });
            return retry;
        }
        this.logger.error({
            action: "pollPipelineStatus.poll.retry",
            outcome: "failure",
            correlationId,
            params: { pipelineRunId, repositoryName, branchName },
            errorMessage: retry.error.message,
        });
        return retry;
    }
    /**
     * Emit `PipelinePollFailureEvent` to the Orchestrator.
     * Requirements: 2.1
     */
    emitPollFailure(pipelineRunId, repositoryName, branchName, failureReason, correlationId) {
        const event = {
            eventId: (0, uuid_1.v4)(),
            correlationId,
            eventType: "PipelinePollFailureEvent",
            source: "Pipeline_Agent",
            timestamp: new Date().toISOString(),
            pipelineRunId,
            repositoryName,
            branchName,
            failureReason,
        };
        this.logger.error({
            action: "pollPipelineStatus.emitPollFailure",
            outcome: "failure",
            correlationId,
            params: { pipelineRunId, repositoryName, branchName },
            errorMessage: failureReason,
        });
        this.emit(event);
    }
    /**
     * Emit `PipelineTimeoutEvent` to the Orchestrator.
     * Requirements: 2.3
     */
    emitTimeout(pipelineRunId, configuredMaxDurationSeconds, correlationId) {
        const event = {
            eventId: (0, uuid_1.v4)(),
            correlationId,
            eventType: "PipelineTimeoutEvent",
            source: "Pipeline_Agent",
            timestamp: new Date().toISOString(),
            pipelineRunId,
            configuredMaxDurationSeconds,
        };
        this.logger.warn({
            action: "pollPipelineStatus.emitTimeout",
            outcome: "failure",
            correlationId,
            params: { pipelineRunId, configuredMaxDurationSeconds },
        });
        this.emit(event);
    }
    /**
     * Emit `PipelineCompletedEvent` to the Orchestrator.
     * Must be called within 10 s of detecting a terminal state (Requirements: 2.2).
     * The event is emitted synchronously — the caller is responsible for ensuring
     * no blocking work is done before calling this method.
     */
    emitCompleted(pipelineRunId, repositoryName, branchName, terminalState, durationSeconds, correlationId) {
        const event = {
            eventId: (0, uuid_1.v4)(),
            correlationId,
            eventType: "PipelineCompletedEvent",
            source: "Pipeline_Agent",
            timestamp: new Date().toISOString(),
            pipelineRunId,
            repositoryName,
            branchName,
            terminalState,
            durationSeconds,
        };
        this.logger.info({
            action: "pollPipelineStatus.emitCompleted",
            outcome: "success",
            correlationId,
            params: {
                pipelineRunId,
                repositoryName,
                branchName,
                terminalState,
                durationSeconds,
            },
        });
        this.emit(event);
    }
    /**
     * Validate and convert `max_duration_seconds` to milliseconds.
     *
     * - null / undefined → returns null (skip timeout monitoring).
     * - Positive integer → returns value * 1000.
     * - Non-positive, non-integer, or NaN → throws RangeError (config error).
     */
    resolveMaxDuration(maxDurationSeconds) {
        if (maxDurationSeconds === null || maxDurationSeconds === undefined) {
            return null;
        }
        if (!Number.isInteger(maxDurationSeconds) ||
            maxDurationSeconds <= 0) {
            throw new RangeError(`max_duration_seconds must be a positive integer, got: ${maxDurationSeconds}`);
        }
        return maxDurationSeconds * 1000;
    }
}
exports.PipelinePoller = PipelinePoller;
// ---------------------------------------------------------------------------
// Standalone pollPipelineStatus helper (matches Pipeline_Agent interface)
// ---------------------------------------------------------------------------
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
async function pollPipelineStatus(runId, client, retryDelayMs = 10000) {
    const first = await client.getPipelineStatus(runId);
    if (first.success)
        return first;
    await sleep(retryDelayMs);
    return client.getPipelineStatus(runId);
}
exports.pollPipelineStatus = pollPipelineStatus;
//# sourceMappingURL=polling.js.map