/**
 * Core event type definitions for the CRM DevOps Agents system.
 * All events flow through the central Orchestrator as BaseEvent envelopes.
 */
/** ISO 8601 date-time string, e.g. "2024-01-15T10:30:00.000Z" */
export type ISO8601String = string;
/** UUID v4 string */
export type UUID = string;
/**
 * All agent types in the system. Used in event routing and health tracking.
 */
export type AgentType = "Orchestrator" | "Pipeline_Agent" | "Deployment_Agent" | "Incident_Agent" | "Notification_Agent";
/**
 * All event/command types in the system.
 * Commands are directives sent to agents; Events are emitted by agents.
 */
export type EventType = "PipelineTriggerCommand" | "PipelineTriggeredEvent" | "PipelineTriggerFailedEvent" | "PipelineCompletedEvent" | "PipelineTimeoutEvent" | "PipelinePollFailureEvent" | "DeploymentCommand" | "DeploymentSuccessEvent" | "DeploymentFailureEvent" | "RollbackEvent" | "RollbackSuccessEvent" | "CriticalFailureEvent" | "AlertReceivedEvent" | "IncidentResolvedEvent" | "IncidentEscalationEvent" | "IncidentExecutionFailureEvent" | "NotifyCommand" | "NotificationDeliveryFailureEvent" | "AgentHealthDegradedEvent";
/**
 * Base envelope wrapping every event in the system.
 * The Orchestrator assigns correlationId on ingestion.
 */
export interface BaseEvent {
    /** UUID v4 — uniquely identifies this individual event */
    eventId: UUID;
    /** UUID v4 — assigned by Orchestrator; propagated to all downstream log entries */
    correlationId: UUID;
    /** Discriminator for routing and logging */
    eventType: EventType;
    /** Which agent or external system emitted this event */
    source: AgentType | "external";
    /** ISO 8601 UTC timestamp of when this event was created */
    timestamp: ISO8601String;
}
//# sourceMappingURL=events.d.ts.map