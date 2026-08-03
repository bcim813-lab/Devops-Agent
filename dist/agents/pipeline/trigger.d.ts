/**
 * Pipeline_Agent — trigger logic.
 *
 * Implements `triggerPipeline()`, which calls the Jenkins API to queue a build
 * and handles up to 3 retries with exponential backoff (initial 5 s, cap 60 s,
 * jitter [0.8, 1.2]) before emitting a terminal failure event.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4
 */
import { StructuredLogger } from "../../utils/logger";
import type { PipelineTriggerCommand, TriggerError, Result, PipelineRunId } from "../../types/models";
import type { OutboundEvent } from "../../interfaces/shared";
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
    triggerJob(jobName: string, params?: Record<string, string>): Promise<string>;
}
/**
 * Callback type used by the trigger to emit events back to the Orchestrator.
 * Matches `Orchestrator.emit(event: OutboundEvent)`.
 */
export type EmitFn = (event: OutboundEvent) => void;
export declare class PipelineTrigger {
    private readonly jenkins;
    private readonly emit;
    private readonly logger;
    /**
     * Maps repository name to Jenkins job name (from config).
     * e.g. `{ "crm-api": "crm-api-build", "crm-web": "crm-web-build" }`
     */
    private readonly jobMap;
    constructor(jenkins: JenkinsClient, emit: EmitFn, jobMap: Record<string, string>, logger?: StructuredLogger);
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
    triggerPipeline(command: PipelineTriggerCommand): Promise<Result<PipelineRunId, TriggerError>>;
    private buildFailedEvent;
}
/** Pause execution for `ms` milliseconds. Exposed for testing via injection. */
export declare function sleep(ms: number): Promise<void>;
//# sourceMappingURL=trigger.d.ts.map