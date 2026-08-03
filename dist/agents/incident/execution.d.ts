/**
 * Incident_Agent — runbook execution and escalation logic.
 *
 * Handles PagerDuty alerts by looking up and executing runbooks.
 * On P1/P2: attempt execution; on failure escalate.
 * P3/P4: ignored.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.6
 */
import { StructuredLogger } from "../../utils/logger";
import { RunbookLibrary } from "./runbookLibrary";
import type { PagerDutyAlert } from "../../types/models";
import type { OutboundEvent } from "../../interfaces/shared";
/**
 * Minimal PagerDuty API client interface.
 */
export interface PagerDutyClient {
    /**
     * Acknowledge an incident in PagerDuty.
     * Returns Ok on success, Err on failure.
     */
    acknowledgeIncident(incidentId: string): Promise<{
        success: boolean;
        error?: Error;
    }>;
}
/**
 * Minimal Slack API client interface for escalations.
 */
export interface SlackClient {
    /**
     * Resolve a user handle to a Slack user ID for @mention.
     * Returns the user ID on success, null if not found.
     */
    resolveHandle(handle: string): Promise<string | null>;
    /**
     * Post a message to a Slack channel.
     */
    postMessage(channel: string, text: string): Promise<{
        success: boolean;
        error?: Error;
    }>;
}
/**
 * Callback type for emitting events to the Orchestrator.
 */
export type EmitFn = (event: OutboundEvent) => void;
/**
 * Callback type for resolving on-call handles from config.
 */
export type ResolveOnCallHandleFn = (serviceName: string) => Promise<string | null>;
/**
 * Configuration for runbook execution.
 */
export interface ExecutionConfig {
    /** Timeout for runbook execution in seconds. Default: 300. */
    timeoutSeconds?: number;
}
/**
 * Abstract executor for runbook steps. Concrete implementations decide how to execute.
 */
export interface RunbookExecutor {
    executeStep(step: Record<string, unknown>): Promise<{
        success: boolean;
        error?: Error;
    }>;
}
/**
 * Handles incident response by executing runbooks or escalating to on-call.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.6
 */
export declare class IncidentHandler {
    private readonly library;
    private readonly pagerduty;
    private readonly slack;
    private readonly executor;
    private readonly emit;
    private readonly resolveOnCallHandle;
    private readonly logger;
    constructor(library: RunbookLibrary, pagerduty: PagerDutyClient, slack: SlackClient, executor: RunbookExecutor, emit: EmitFn, resolveOnCallHandle: ResolveOnCallHandleFn, logger?: StructuredLogger);
    /**
     * Handle an inbound PagerDuty alert.
     *
     * P1/P2: Look up latest runbook and execute.
     * - Success: ack PD, emit IncidentResolvedEvent.
     * - Failure or timeout: escalate and emit IncidentExecutionFailureEvent.
     * - No runbook found: escalate immediately and emit IncidentExecutionFailureEvent.
     *
     * P3/P4: Ignored (no action).
     *
     * Requirements: 5.1, 5.2, 5.3, 5.4, 5.6
     */
    handleAlert(alert: PagerDutyAlert, config?: ExecutionConfig): Promise<void>;
    /**
     * Private helper: escalate incident to on-call via Slack within 30 s.
     */
    private _escalate;
}
//# sourceMappingURL=execution.d.ts.map