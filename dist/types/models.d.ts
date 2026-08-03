/**
 * Data models for all domain objects in the CRM DevOps Agents system.
 * Organized by domain: Pipeline, Deployment, Incident, Notification, Health, Config.
 */
import type { BaseEvent, EventType, AgentType, ISO8601String, UUID } from "./events";
export type { BaseEvent, EventType, AgentType, ISO8601String, UUID };
/** Command sent by Orchestrator to Pipeline_Agent to trigger a build */
export interface PipelineTriggerCommand extends BaseEvent {
    eventType: "PipelineTriggerCommand";
    repositoryName: string;
    branchName: string;
    triggerTimestamp: ISO8601String;
}
/** Emitted by Pipeline_Agent when a Jenkins run has been successfully queued */
export interface PipelineTriggeredEvent extends BaseEvent {
    eventType: "PipelineTriggeredEvent";
    pipelineRunId: string;
    repositoryName: string;
    branchName: string;
    triggerTimestamp: ISO8601String;
}
/** Emitted by Pipeline_Agent after all retries are exhausted without a successful trigger */
export interface PipelineTriggerFailedEvent extends BaseEvent {
    eventType: "PipelineTriggerFailedEvent";
    repositoryName: string;
    branchName: string;
    triggerTimestamp: ISO8601String;
    failureReason: string;
}
/** Emitted by Pipeline_Agent when a Jenkins run reaches a terminal state */
export interface PipelineCompletedEvent extends BaseEvent {
    eventType: "PipelineCompletedEvent";
    pipelineRunId: string;
    repositoryName: string;
    branchName: string;
    terminalState: "success" | "failure" | "aborted";
    durationSeconds: number;
}
/**
 * Emitted by Pipeline_Agent when a run exceeds the configured max duration.
 * Only emitted when `max_duration_seconds` is explicitly set (positive integer).
 */
export interface PipelineTimeoutEvent extends BaseEvent {
    eventType: "PipelineTimeoutEvent";
    pipelineRunId: string;
    configuredMaxDurationSeconds: number;
}
/** Emitted by Pipeline_Agent when a poll attempt and its single retry both fail */
export interface PipelinePollFailureEvent extends BaseEvent {
    eventType: "PipelinePollFailureEvent";
    pipelineRunId: string;
    repositoryName: string;
    branchName: string;
    failureReason: string;
}
/**
 * Persisted record of a pipeline run, retained for ≥ 30 days.
 * retainUntil = triggerTimestamp + 30 days.
 */
export interface PipelineRunRecord {
    pipelineRunId: string;
    repositoryName: string;
    branchName: string;
    triggerTimestamp: ISO8601String;
    terminalState: "success" | "failure" | "aborted" | "in_progress";
    /** null while run is still in_progress */
    durationSeconds: number | null;
    /** ISO 8601 date after which this record may be purged */
    retainUntil: ISO8601String;
}
/** Command sent by Orchestrator to Deployment_Agent to apply a Kubernetes manifest */
export interface DeploymentCommand extends BaseEvent {
    eventType: "DeploymentCommand";
    manifestFilePath: string;
    namespace: string;
    deploymentName: string;
    /** Back-reference to the pipeline run that triggered this deployment */
    pipelineRunId: string;
}
/** Emitted by Deployment_Agent after a successful Kubernetes rollout */
export interface DeploymentSuccessEvent extends BaseEvent {
    eventType: "DeploymentSuccessEvent";
    deploymentName: string;
    namespace: string;
}
/**
 * Emitted by Deployment_Agent when the Kubernetes API rejects a manifest apply.
 * NOTE: This event does NOT trigger a rollback.
 */
export interface DeploymentFailureEvent extends BaseEvent {
    eventType: "DeploymentFailureEvent";
    deploymentName: string;
    namespace: string;
    manifestFilePath: string;
    kubernetesErrorMessage: string;
}
/** Emitted by Deployment_Agent when an automatic rollback is initiated */
export interface RollbackEvent extends BaseEvent {
    eventType: "RollbackEvent";
    deploymentName: string;
    namespace: string;
    /** Human-readable reason rollback was triggered (e.g. "rollout timeout") */
    reason: string;
}
/** Emitted by Deployment_Agent when a rollback completes and all pods are Ready */
export interface RollbackSuccessEvent extends BaseEvent {
    eventType: "RollbackSuccessEvent";
    deploymentName: string;
    namespace: string;
}
/** Emitted by Deployment_Agent on unrecoverable failure; halts automation for the pair */
export interface CriticalFailureEvent extends BaseEvent {
    eventType: "CriticalFailureEvent";
    deploymentName: string;
    namespace: string;
    failureReason: string;
}
/** Immutable audit record of a single rollback attempt */
export interface RollbackAttemptLog {
    timestamp: ISO8601String;
    deploymentName: string;
    namespace: string;
    outcome: "success" | "failed" | "timed-out";
    correlationId: string;
}
/**
 * Persisted record indicating that a (deploymentName, namespace) pair is halted.
 * All commands targeting this pair return HaltedError until resumeDeployment() is called.
 */
export interface DeploymentHaltState {
    deploymentName: string;
    namespace: string;
    haltedAt: ISO8601String;
    reason: string;
    haltedUntilManualResume: true;
}
/** Inbound alert received from PagerDuty */
export interface PagerDutyAlert {
    incidentId: string;
    serviceName: string;
    severity: "P1" | "P2" | "P3" | "P4";
    receivedAt: ISO8601String;
    details: Record<string, unknown>;
}
/**
 * A versioned runbook registered in the RunbookLibrary.
 * timeoutSeconds must be ≤ 300.
 */
export interface Runbook {
    serviceName: string;
    /** Semantic version string, e.g. "1.2.0" */
    version: string;
    steps: RunbookStep[];
    /** Execution will be terminated if exceeded; max 300 */
    timeoutSeconds: number;
}
/** A single step within a Runbook */
export interface RunbookStep {
    stepId: string;
    description: string;
    action: RunbookAction;
}
/** Opaque action descriptor; concrete implementations decide how to execute it */
export type RunbookAction = Record<string, unknown>;
/** Emitted by Incident_Agent when a runbook resolves the incident */
export interface IncidentResolvedEvent extends BaseEvent {
    eventType: "IncidentResolvedEvent";
    incidentId: string;
    serviceName: string;
}
/** Emitted by Incident_Agent when the incident is escalated to on-call */
export interface IncidentEscalationEvent extends BaseEvent {
    eventType: "IncidentEscalationEvent";
    incidentId: string;
    serviceName: string;
    reason: string;
    /** null if the handle could not be resolved at escalation time */
    onCallHandle: string | null;
}
/** Emitted by Incident_Agent when runbook execution fails or times out */
export interface IncidentExecutionFailureEvent extends BaseEvent {
    eventType: "IncidentExecutionFailureEvent";
    incidentId: string;
    serviceName: string;
    failureReason: string;
}
/** Command sent by Orchestrator to Notification_Agent to post a Slack message */
export interface NotifyCommand extends BaseEvent {
    eventType: "NotifyCommand";
    /** The originating event that caused this notification */
    triggerEvent: BaseEvent;
    orchestratorTimestamp: ISO8601String;
    affectedServiceName: string;
    outcome: "success" | "failure" | "rollback" | "escalated";
    /** Non-null for escalation events where on-call mention is required */
    onCallHandle: string | null;
}
/** A Slack message payload using Block Kit layout */
export interface SlackMessage {
    channel: string;
    text: string;
    /** Optional structured Slack Block Kit blocks */
    blocks?: SlackBlock[];
}
/** Opaque Slack Block Kit block descriptor */
export type SlackBlock = Record<string, unknown>;
/** Emitted by Notification_Agent after all retries are exhausted or handle is unresolvable */
export interface NotificationDeliveryFailureEvent extends BaseEvent {
    eventType: "NotificationDeliveryFailureEvent";
    targetChannel: string;
    originalEventType: EventType;
    /**
     * Reason for failure.
     * "handle_unresolvable" — the on-call Slack handle could not be resolved.
     * Other values describe API/network failures.
     */
    failureReason: string;
}
/** Returned by GET /health — overall system health snapshot */
export interface HealthStatus {
    agents: AgentHealthEntry[];
    timestamp: ISO8601String;
}
/** Per-agent entry in the health snapshot */
export interface AgentHealthEntry {
    agentType: AgentType;
    status: "healthy" | "unhealthy" | "unknown";
    /** null if no heartbeat has ever been received */
    lastHeartbeatAt: ISO8601String | null;
}
/** Emitted by Orchestrator when an agent transitions from healthy → unhealthy */
export interface AgentHealthDegradedEvent extends BaseEvent {
    eventType: "AgentHealthDegradedEvent";
    agentType: AgentType;
    lastSeenAt: ISO8601String | null;
}
/** Returned by GET /metrics — per-agent metrics snapshot */
export interface MetricSnapshot {
    agents: AgentMetrics[];
}
/** Per-agent metrics for Prometheus export */
export interface AgentMetrics {
    agentType: AgentType;
    totalEventsProcessed: number;
    eventsByType: Partial<Record<EventType, number>>;
    /** Ratio 0.0 – 1.0 */
    actionSuccessRate: number;
    actionLatencyP50Ms: number;
    actionLatencyP99Ms: number;
}
/** Full system configuration loaded from the versioned config store */
export interface SystemConfig {
    github: GitHubConfig;
    jenkins: JenkinsConfig;
    kubernetes: KubernetesConfig;
    pagerduty: PagerDutyConfig;
    slack: SlackConfig;
    pipeline: PipelineConfig;
}
export interface GitHubConfig {
    /** List of repository names to watch for PR merge events */
    repositories: string[];
    /** MASKED in all log output */
    webhookSecret: string;
}
export interface JenkinsConfig {
    baseUrl: string;
    /** MASKED in all log output */
    apiToken: string;
    /** Maps repository name → Jenkins job name */
    jobs: Record<string, string>;
}
export interface KubernetesConfig {
    clusters: KubernetesClusterConfig[];
}
export interface KubernetesClusterConfig {
    name: string;
    /** MASKED in all log output */
    kubeconfig: string;
    namespaces: string[];
}
export interface PagerDutyConfig {
    /** MASKED in all log output */
    apiToken: string;
    /** Maps PagerDuty service name → RunbookLibrary service name */
    serviceRunbookMap: Record<string, string>;
}
export interface SlackConfig {
    /** MASKED in all log output */
    botToken: string;
    /** Maps EventType → Slack channel name */
    channels: Partial<Record<EventType, string>>;
    /** Maps service name → Slack user handle (e.g. "@alice") */
    onCallHandles: Record<string, string>;
}
export interface PipelineConfig {
    /**
     * Maximum allowed run duration in seconds (positive integer).
     * null = timeout monitoring disabled for this pipeline.
     */
    maxDurationSeconds: number | null;
    /** Default 600 seconds */
    rolloutTimeoutSeconds: number;
}
/** A discriminated union representing either a success value or an error */
export type Result<T, E> = {
    success: true;
    value: T;
} | {
    success: false;
    error: E;
};
/** An optional value — either present or absent */
export type Option<T> = {
    present: true;
    value: T;
} | {
    present: false;
};
/** Convenience helpers */
export declare function ok<T>(value: T): Result<T, never>;
export declare function err<E>(error: E): Result<never, E>;
export declare function some<T>(value: T): Option<T>;
export declare const none: Option<never>;
/** Error thrown when a command targets a halted (deploymentName, namespace) pair */
export declare class HaltedError extends Error {
    readonly deploymentName: string;
    readonly namespace: string;
    readonly haltedAt: ISO8601String;
    readonly reason: string;
    constructor(deploymentName: string, namespace: string, haltedAt: ISO8601String, reason: string);
}
/** Unique identifier for an active pipeline run */
export type PipelineRunId = string;
/** Reference to an active Kubernetes rollout */
export interface RolloutHandle {
    deploymentName: string;
    namespace: string;
    pipelineRunId: string;
}
/** Reference to a deployment for rollback or halt operations */
export interface DeploymentRef {
    deploymentName: string;
    namespace: string;
}
/** Result of triggering a pipeline */
export type TriggerError = {
    code: "JENKINS_UNREACHABLE" | "JENKINS_ERROR" | "RETRIES_EXHAUSTED";
    message: string;
    attempt: number;
};
/** Result of polling a pipeline */
export type PollError = {
    code: "JENKINS_POLL_FAILED" | "RUN_NOT_FOUND";
    message: string;
};
/** Status of a running pipeline */
export type PipelineStatus = {
    runId: string;
    state: "in_progress" | "success" | "failure" | "aborted";
    durationSeconds: number | null;
};
/** Error from Deployment_Agent operations */
export type DeployError = {
    code: "MANIFEST_PATH_MISSING" | "KUBERNETES_API_ERROR" | "NAMESPACE_NOT_CONFIGURED";
    message: string;
};
/** Error from rollback operations */
export type RollbackError = {
    code: "DISPATCH_TIMEOUT" | "ROLLBACK_TIMEOUT" | "KUBERNETES_API_ERROR" | "DEPLOYMENT_HALTED";
    message: string;
};
/** Error from notification delivery */
export type NotifyError = {
    code: "SLACK_API_ERROR" | "RETRIES_EXHAUSTED" | "HANDLE_UNRESOLVABLE";
    message: string;
};
/** Error from on-call handle resolution */
export type HandleError = {
    code: "HANDLE_NOT_CONFIGURED" | "CONFIG_RELOAD_PENDING";
    service: string;
};
/** Error from runbook execution */
export type RunbookError = {
    code: "RUNBOOK_NOT_FOUND" | "EXECUTION_FAILED" | "EXECUTION_TIMEOUT" | "STEP_ERROR";
    message: string;
    stepId?: string;
};
/** Configuration loading/reload error */
export type ConfigError = {
    key: string;
    invalidValue: unknown;
    expectedType: string;
    reason: string;
};
/** Reference to an active PagerDuty incident */
export interface IncidentRef {
    incidentId: string;
    serviceName: string;
    severity: "P1" | "P2" | "P3" | "P4";
}
/** A Slack user handle string, e.g. "@alice" */
export type SlackHandle = string;
/** Snapshot of a Kubernetes rollout's current progress */
export interface RolloutStatus {
    deploymentName: string;
    namespace: string;
    readyReplicas: number;
    desiredReplicas: number;
    isComplete: boolean;
    isTimedOut: boolean;
}
//# sourceMappingURL=models.d.ts.map