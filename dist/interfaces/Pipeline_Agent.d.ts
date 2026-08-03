/**
 * Pipeline_Agent interface — manages Jenkins/GitHub Actions pipeline lifecycle.
 *
 * Key behaviors:
 * - Triggers pipeline within 60 s of a PR merge event.
 * - Retries trigger up to 3× with exponential backoff (initial 5 s, cap 60 s, jitter [0.8, 1.2]).
 * - Polls Jenkins every 30 s; retries poll once after 10 s on failure.
 * - Emits PipelineTimeoutEvent when max_duration_seconds is exceeded (if configured).
 * - Emits PipelineCompletedEvent within 10 s of detecting a terminal state.
 * - Retains pipeline run records for ≥ 30 days.
 */
import type { PipelineTriggerCommand, PipelineCompletedEvent, PipelineRunId, PipelineStatus, TriggerError, PollError, Result } from "../types/models";
export interface Pipeline_Agent {
    /**
     * Trigger a Jenkins pipeline run for the given repository and branch.
     *
     * Retries up to 3× with exponential backoff on Jenkins API errors.
     * On success: emits PipelineTriggeredEvent to Orchestrator.
     * On all retries exhausted: emits PipelineTriggerFailedEvent to Orchestrator.
     *
     * @returns Ok(PipelineRunId) on success, Err(TriggerError) on final failure.
     */
    triggerPipeline(command: PipelineTriggerCommand): Promise<Result<PipelineRunId, TriggerError>>;
    /**
     * Poll the current status of a running Jenkins pipeline.
     *
     * Called every 30 s. Retries once after 10 s on poll failure.
     * On retry failure: emits PipelinePollFailureEvent to Orchestrator.
     *
     * @returns Ok(PipelineStatus) with the latest status, Err(PollError) on failure.
     */
    pollPipelineStatus(runId: PipelineRunId): Promise<Result<PipelineStatus, PollError>>;
    /**
     * Handle the completion of a pipeline run (terminal state detected).
     *
     * Persists the run record, updates the retainUntil TTL, and triggers
     * any downstream actions (e.g., initiating a deployment if manifest_path is set).
     */
    handleCompletion(event: PipelineCompletedEvent): void;
}
//# sourceMappingURL=Pipeline_Agent.d.ts.map