/**
 * Orchestrator — command dispatch logic.
 *
 * Routes agent commands based on inbound events and maintains event-to-command correlation.
 *
 * Requirements: 1.4, 2.5, 3.1, 6.1, 6.2, 6.3, 6.4, 8.4
 */
import { StructuredLogger } from "../utils/logger";
import type { BaseEvent, EventType } from "../types/models";
/**
 * Agent dispatcher interface (called with commands).
 */
export interface Agent {
    dispatch(command: unknown): Promise<void>;
}
/**
 * Configuration for the dispatcher.
 */
export interface DispatcherConfig {
    /** Maximum time to wait before routing a NotifyCommand (ms). Default: 15_000. */
    notifyTimeoutMs?: number;
}
/**
 * Routes events to agents by dispatching appropriate commands.
 *
 * Requirements: 1.4, 2.5, 3.1, 6.1, 6.2, 6.3, 6.4, 8.4
 */
export declare class CommandDispatcher {
    private readonly notificationAgent;
    private readonly deploymentAgent;
    private readonly pipelineAgent;
    private readonly incidentAgent;
    private readonly logger;
    private readonly notifyTimeoutMs;
    constructor(pipelineAgent: Agent, deploymentAgent: Agent, incidentAgent: Agent, notificationAgent: Agent, logger?: StructuredLogger, config?: DispatcherConfig);
    /**
     * Dispatch an event to the appropriate agent(s).
     *
     * Routing rules:
     * - PipelineTriggerFailedEvent → NotifyCommand to Notification_Agent
     * - PipelinePollFailureEvent → NotifyCommand to Notification_Agent (within 15 s)
     * - PipelineCompletedEvent (success + manifest present) → DeploymentCommand to Deployment_Agent
     * - DeploymentSuccessEvent, RollbackEvent, IncidentEscalationEvent, CriticalFailureEvent → NotifyCommand
     *
     * Requirements: 1.4, 2.5, 3.1, 6.1, 6.2, 6.3, 6.4, 8.4
     */
    dispatch(eventType: EventType, correlationId: string, event: BaseEvent): Promise<void>;
}
//# sourceMappingURL=dispatch.d.ts.map