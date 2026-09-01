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

import { v4 as uuidv4 } from "uuid";
import type {
  PipelineCompletedEvent,
  PipelineTimeoutEvent,
  PipelinePollFailureEvent,
  PipelineStatus,
  PollError,
  Result,
} from "../../types/models";
import type { OutboundEvent } from "../../interfaces/shared";
import { StructuredLogger } from "../../utils/logger";

// ---------------------------------------------------------------------------
// External client interface (injected via constructor)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Poller configuration
// ---------------------------------------------------------------------------

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

  // Timing overrides — intended for testing only; production code leaves these unset.
  /** How long to wait between normal poll cycles (ms). Default: 30_000. */
  pollIntervalMs?: number;
  /** How long to wait before the single poll retry (ms). Default: 10_000. */
  retryDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Callback type for emitting events back to the Orchestrator
// ---------------------------------------------------------------------------

/** Callback invoked by the poller to emit outbound events to the Orchestrator. */
export type OrchestratorEmit = (event: OutboundEvent) => void;

// ---------------------------------------------------------------------------
// Terminal state helper
// ---------------------------------------------------------------------------

const TERMINAL_STATES = new Set<string>(["success", "failure", "aborted"]);

function isTerminal(state: string): state is "success" | "failure" | "aborted" {
  return TERMINAL_STATES.has(state);
}

// ---------------------------------------------------------------------------
// Sleep helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
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
export class PipelinePoller {
  private readonly client: JenkinsClient;
  private readonly emit: OrchestratorEmit;
  private readonly logger: StructuredLogger;

  /** Set to true by `stop()` to break the poll loop early. */
  private stopped = false;

  constructor(
    client: JenkinsClient,
    emit: OrchestratorEmit,
    logger: StructuredLogger
  ) {
    this.client = client;
    this.emit = emit;
    this.logger = logger;
  }

  /**
   * Stop the poll loop after the current iteration completes.
   * Safe to call multiple times.
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Start polling until a terminal state is detected, a timeout fires,
   * or `stop()` is called.
   *
   * This method resolves when the loop exits for any reason.
   */
  async start(config: PollConfig): Promise<void> {
    this.stopped = false;

    const {
      pipelineRunId,
      repositoryName,
      branchName,
      maxDurationSeconds,
      pollIntervalMs = 30_000,
      retryDelayMs = 10_000,
    } = config;

    // Derive a correlationId for all events emitted during this run.
    // In production the Orchestrator re-stamps; this acts as a local trace ID.
    const correlationId = uuidv4();

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
          this.emitTimeout(pipelineRunId, maxDurationSeconds as number, correlationId);
          return;
        }
      }

      // ── Poll attempt ──────────────────────────────────────────────────────
      const result = await this.pollWithRetry(
        pipelineRunId,
        repositoryName,
        branchName,
        correlationId,
        retryDelayMs
      );

      if (!result.success) {
        // Retry also failed — emit PipelinePollFailureEvent and stop.
        this.emitPollFailure(
          pipelineRunId,
          repositoryName,
          branchName,
          result.error.message,
          correlationId
        );
        return;
      }

      const status = result.value;

      // ── Terminal state detection ──────────────────────────────────────────
      if (isTerminal(status.state)) {
        const durationSeconds =
          status.durationSeconds !== null && status.durationSeconds >= 0
            ? status.durationSeconds
            : Math.round((Date.now() - startTime) / 1000);

        this.emitCompleted(
          pipelineRunId,
          repositoryName,
          branchName,
          status.state,
          durationSeconds,
          correlationId
        );
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
  private async pollWithRetry(
    pipelineRunId: string,
    repositoryName: string,
    branchName: string,
    correlationId: string,
    retryDelayMs: number
  ): Promise<Result<PipelineStatus, PollError>> {
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
  private emitPollFailure(
    pipelineRunId: string,
    repositoryName: string,
    branchName: string,
    failureReason: string,
    correlationId: string
  ): void {
    const event: PipelinePollFailureEvent = {
      eventId: uuidv4(),
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

    this.emit(event as unknown as OutboundEvent);
  }

  /**
   * Emit `PipelineTimeoutEvent` to the Orchestrator.
   * Requirements: 2.3
   */
  private emitTimeout(
    pipelineRunId: string,
    configuredMaxDurationSeconds: number,
    correlationId: string
  ): void {
    const event: PipelineTimeoutEvent = {
      eventId: uuidv4(),
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

    this.emit(event as unknown as OutboundEvent);
  }

  /**
   * Emit `PipelineCompletedEvent` to the Orchestrator.
   * Must be called within 10 s of detecting a terminal state (Requirements: 2.2).
   * The event is emitted synchronously — the caller is responsible for ensuring
   * no blocking work is done before calling this method.
   */
  private emitCompleted(
    pipelineRunId: string,
    repositoryName: string,
    branchName: string,
    terminalState: "success" | "failure" | "aborted",
    durationSeconds: number,
    correlationId: string
  ): void {
    const event: PipelineCompletedEvent = {
      eventId: uuidv4(),
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

    this.emit(event as unknown as OutboundEvent);
  }

  /**
   * Validate and convert `max_duration_seconds` to milliseconds.
   *
   * - null / undefined → returns null (skip timeout monitoring).
   * - Positive integer → returns value * 1000.
   * - Non-positive, non-integer, or NaN → throws RangeError (config error).
   */
  private resolveMaxDuration(
    maxDurationSeconds: number | null | undefined
  ): number | null {
    if (maxDurationSeconds === null || maxDurationSeconds === undefined) {
      return null;
    }

    if (
      !Number.isInteger(maxDurationSeconds) ||
      maxDurationSeconds <= 0
    ) {
      throw new RangeError(
        `max_duration_seconds must be a positive integer, got: ${maxDurationSeconds}`
      );
    }

    return maxDurationSeconds * 1000;
  }
}

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
export async function pollPipelineStatus(
  runId: string,
  client: JenkinsClient,
  retryDelayMs = 10_000
): Promise<Result<PipelineStatus, PollError>> {
  const first = await client.getPipelineStatus(runId);
  if (first.success) return first;

  await sleep(retryDelayMs);

  return client.getPipelineStatus(runId);
}
