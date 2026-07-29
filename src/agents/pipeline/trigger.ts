/**
 * Pipeline_Agent — trigger logic.
 *
 * Implements `triggerPipeline()`, which calls the Jenkins API to queue a build
 * and handles up to 3 retries with exponential backoff (initial 5 s, cap 60 s,
 * jitter [0.8, 1.2]) before emitting a terminal failure event.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4
 */

import { v4 as uuidv4 } from "uuid";
import { computeRetryDelay, PIPELINE_BACKOFF_MS } from "../../utils/backoff";
import { StructuredLogger } from "../../utils/logger";
import type {
  PipelineTriggerCommand,
  PipelineTriggeredEvent,
  PipelineTriggerFailedEvent,
  TriggerError,
  Result,
  PipelineRunId,
} from "../../types/models";
import type { OutboundEvent } from "../../interfaces/shared";

// ---------------------------------------------------------------------------
// JenkinsClient interface
// ---------------------------------------------------------------------------

/**
 * Minimal interface for interacting with the Jenkins API.
 * Concrete implementations are injected via constructor injection.
 */
export interface JenkinsClient {
  /**
   * Queue a build for the named job.
   *
   * @param jobName  - The Jenkins job name to trigger.
   * @param params   - Optional parameters forwarded to the job.
   * @returns        - The Jenkins queue/run ID for the queued build.
   * @throws         - Any network or HTTP error from Jenkins.
   */
  triggerJob(
    jobName: string,
    params?: Record<string, string>
  ): Promise<string>;
}

// ---------------------------------------------------------------------------
// Orchestrator emit callback
// ---------------------------------------------------------------------------

/**
 * Callback type used by the trigger to emit events back to the Orchestrator.
 * Matches `Orchestrator.emit(event: OutboundEvent)`.
 */
export type EmitFn = (event: OutboundEvent) => void;

// ---------------------------------------------------------------------------
// PipelineTrigger
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3; // initial attempt + 2 retries = 3 total attempts

export class PipelineTrigger {
  private readonly jenkins: JenkinsClient;
  private readonly emit: EmitFn;
  private readonly logger: StructuredLogger;
  /**
   * Maps repository name to Jenkins job name (from config).
   * e.g. `{ "crm-api": "crm-api-build", "crm-web": "crm-web-build" }`
   */
  private readonly jobMap: Record<string, string>;

  constructor(
    jenkins: JenkinsClient,
    emit: EmitFn,
    jobMap: Record<string, string>,
    logger?: StructuredLogger
  ) {
    this.jenkins = jenkins;
    this.emit = emit;
    this.jobMap = jobMap;
    this.logger = logger ?? new StructuredLogger();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Trigger a Jenkins pipeline for the given repository and branch.
   *
   * Attempts the Jenkins call up to `MAX_ATTEMPTS` (3) times.  Between each
   * failure the method waits for the exponential-backoff delay before retrying.
   *
   * On success:
   *   - Emits a `PipelineTriggeredEvent` via the Orchestrator callback.
   *   - Returns `Ok(pipelineRunId)`.
   *
   * On exhausted retries:
   *   - Emits a `PipelineTriggerFailedEvent` via the Orchestrator callback.
   *   - Returns `Err(TriggerError)`.
   *
   * Requirements: 1.1, 1.2, 1.3, 1.4
   */
  async triggerPipeline(
    command: PipelineTriggerCommand
  ): Promise<Result<PipelineRunId, TriggerError>> {
    const { repositoryName, branchName, triggerTimestamp, correlationId } = command;
    const jobName = this.jobMap[repositoryName];

    if (!jobName) {
      const reason = `No Jenkins job configured for repository '${repositoryName}'`;
      this.logger.error({
        action: "triggerPipeline",
        params: { repositoryName, branchName },
        outcome: "failure",
        correlationId,
        errorMessage: reason,
      });

      const failedEvent = this.buildFailedEvent(command, reason);
      this.emit(failedEvent);

      return {
        success: false,
        error: {
          code: "JENKINS_ERROR",
          message: reason,
          attempt: 0,
        },
      };
    }

    let lastError: unknown = null;
    let lastAttempt = 0;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      lastAttempt = attempt;

      // Wait before retrying (no wait before the very first attempt)
      if (attempt > 0) {
        // attempt-1 because the backoff is computed for retry index starting at 0
        const delayMs = computeRetryDelay(attempt - 1, PIPELINE_BACKOFF_MS);
        this.logger.info({
          action: "triggerPipeline:backoff",
          params: { repositoryName, branchName, attempt, delayMs },
          outcome: "pending",
          correlationId,
        });
        await sleep(delayMs);
      }

      try {
        this.logger.info({
          action: "triggerPipeline:attempt",
          params: { repositoryName, branchName, jobName, attempt },
          outcome: "pending",
          correlationId,
        });

        const runId = await this.jenkins.triggerJob(jobName, {
          branch: branchName,
        });

        // --- SUCCESS ---
        this.logger.info({
          action: "triggerPipeline",
          params: { repositoryName, branchName, jobName, attempt },
          outcome: "success",
          correlationId,
          pipelineRunId: runId,
        });

        const triggeredEvent: PipelineTriggeredEvent = {
          eventId: uuidv4(),
          correlationId,
          eventType: "PipelineTriggeredEvent",
          source: "Pipeline_Agent",
          timestamp: new Date().toISOString(),
          pipelineRunId: runId,
          repositoryName,
          branchName,
          triggerTimestamp,
        };
        this.emit(triggeredEvent);

        return { success: true, value: runId };
      } catch (err: unknown) {
        lastError = err;
        const errorMessage = err instanceof Error ? err.message : String(err);
        const stackTrace = err instanceof Error ? err.stack : undefined;

        this.logger.warn({
          action: "triggerPipeline:attempt",
          params: { repositoryName, branchName, jobName, attempt },
          outcome: "failure",
          correlationId,
          errorMessage,
          ...(stackTrace !== undefined && { stackTrace }),
          attemptsRemaining: MAX_ATTEMPTS - attempt - 1,
        });
      }
    }

    // --- ALL RETRIES EXHAUSTED ---
    const failureReason =
      lastError instanceof Error
        ? lastError.message
        : String(lastError ?? "Unknown Jenkins error");

    this.logger.error({
      action: "triggerPipeline",
      params: { repositoryName, branchName, jobName },
      outcome: "failure",
      correlationId,
      errorMessage: `All ${MAX_ATTEMPTS} attempts failed. Last error: ${failureReason}`,
    });

    const failedEvent = this.buildFailedEvent(command, failureReason);
    this.emit(failedEvent);

    return {
      success: false,
      error: {
        code: "RETRIES_EXHAUSTED",
        message: failureReason,
        attempt: lastAttempt,
      },
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildFailedEvent(
    command: PipelineTriggerCommand,
    failureReason: string
  ): PipelineTriggerFailedEvent {
    return {
      eventId: uuidv4(),
      correlationId: command.correlationId,
      eventType: "PipelineTriggerFailedEvent",
      source: "Pipeline_Agent",
      timestamp: new Date().toISOString(),
      repositoryName: command.repositoryName,
      branchName: command.branchName,
      triggerTimestamp: command.triggerTimestamp,
      failureReason,
    };
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/** Pause execution for `ms` milliseconds. Exposed for testing via injection. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
