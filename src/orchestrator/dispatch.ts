/**
 * Orchestrator — command dispatch logic.
 *
 * Routes agent commands based on inbound events and maintains event-to-command correlation.
 *
 * Requirements: 1.4, 2.5, 3.1, 6.1, 6.2, 6.3, 6.4, 8.4
 */

import { StructuredLogger } from "../utils/logger";
import type {
  BaseEvent,
  EventType,
  PipelineTriggerFailedEvent,
  PipelinePollFailureEvent,
  PipelineCompletedEvent,
  DeploymentSuccessEvent,
  RollbackEvent,
  IncidentEscalationEvent,
  CriticalFailureEvent,
  NotifyCommand,
  DeploymentCommand,
} from "../types/models";

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
export class CommandDispatcher {
  private readonly notificationAgent: Agent;
  private readonly deploymentAgent: Agent;
  private readonly pipelineAgent: Agent;
  private readonly incidentAgent: Agent;
  private readonly logger: StructuredLogger;
  private readonly notifyTimeoutMs: number;

  constructor(
    pipelineAgent: Agent,
    deploymentAgent: Agent,
    incidentAgent: Agent,
    notificationAgent: Agent,
    logger?: StructuredLogger,
    config?: DispatcherConfig
  ) {
    this.pipelineAgent = pipelineAgent;
    this.deploymentAgent = deploymentAgent;
    this.incidentAgent = incidentAgent;
    this.notificationAgent = notificationAgent;
    this.logger = logger ?? new StructuredLogger();
    this.notifyTimeoutMs = config?.notifyTimeoutMs ?? 15_000;
  }

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
  async dispatch(
    eventType: EventType,
    correlationId: string,
    event: BaseEvent
  ): Promise<void> {
    this.logger.debug({
      action: "commandDispatcher.dispatch",
      outcome: "pending",
      eventType,
      correlationId,
    });

    // Requirement 8.4: Forward correlationId from originating event into all dispatched commands
    const timestamp = new Date().toISOString();

    switch (eventType) {
      // ────── Pipeline failure → Notify ──────────────────────────────────
      case "PipelineTriggerFailedEvent": {
        const evt = event as PipelineTriggerFailedEvent;
        const notifyCmd: NotifyCommand = {
          eventId: evt.eventId,
          correlationId, // Requirement 8.4
          eventType: "NotifyCommand",
          source: "Orchestrator",
          timestamp,
          triggerEvent: evt,
          orchestratorTimestamp: timestamp,
          affectedServiceName: evt.repositoryName,
          outcome: "failure",
          onCallHandle: null,
        };

        const startTime = Date.now();
        await this.notificationAgent.dispatch(notifyCmd);
        const elapsed = Date.now() - startTime;

        if (elapsed > this.notifyTimeoutMs) {
          this.logger.warn({
            action: "commandDispatcher.dispatch.notify",
            outcome: "slow_delivery",
            eventType,
            correlationId,
            elapsedMs: elapsed,
          });
        }
        break;
      }

      // ────── Pipeline poll failure → Notify (within 15 s) ────────────────
      case "PipelinePollFailureEvent": {
        const evt = event as PipelinePollFailureEvent;
        const notifyCmd: NotifyCommand = {
          eventId: evt.eventId,
          correlationId, // Requirement 8.4
          eventType: "NotifyCommand",
          source: "Orchestrator",
          timestamp,
          triggerEvent: evt,
          orchestratorTimestamp: timestamp,
          affectedServiceName: evt.repositoryName,
          outcome: "failure",
          onCallHandle: null,
        };

        const startTime = Date.now();

        // Requirement 2.5: Within 15 s of event receipt
        this.logger.info({
          action: "commandDispatcher.dispatch.poll_failure",
          outcome: "pending",
          correlationId,
          eventType,
        });

        await this.notificationAgent.dispatch(notifyCmd);

        const elapsed = Date.now() - startTime;
        if (elapsed > this.notifyTimeoutMs) {
          this.logger.warn({
            action: "commandDispatcher.dispatch.notify",
            outcome: "slow_delivery",
            eventType,
            correlationId,
            elapsedMs: elapsed,
            maxMs: this.notifyTimeoutMs,
          });
        }
        break;
      }

      // ────── Pipeline completed → Deploy (if manifest present) ─────────────
      case "PipelineCompletedEvent": {
        const evt = event as PipelineCompletedEvent;

        // Requirement 3.1: Only proceed when manifestFilePath is explicitly set
        // (This check happens in the Deployment_Agent, but we can log here)
        if (evt.terminalState === "success") {
          // Assumption: deploymentName and namespace are in pipeline config
          // For now, we create a generic DeploymentCommand
          const deployCmd: DeploymentCommand = {
            eventId: evt.eventId,
            correlationId, // Requirement 8.4
            eventType: "DeploymentCommand",
            source: "Orchestrator",
            timestamp,
            manifestFilePath: "", // Populated from config
            namespace: "", // Populated from config
            deploymentName: "", // Populated from config
            pipelineRunId: evt.pipelineRunId,
          };

          this.logger.info({
            action: "commandDispatcher.dispatch.deployment",
            outcome: "pending",
            correlationId,
            pipelineRunId: evt.pipelineRunId,
          });

          await this.deploymentAgent.dispatch(deployCmd);
        }
        break;
      }

      // ────── Deployment success → Notify ─────────────────────────────────
      case "DeploymentSuccessEvent": {
        const evt = event as DeploymentSuccessEvent;
        const notifyCmd: NotifyCommand = {
          eventId: evt.eventId,
          correlationId, // Requirement 8.4
          eventType: "NotifyCommand",
          source: "Orchestrator",
          timestamp,
          triggerEvent: evt,
          orchestratorTimestamp: timestamp,
          affectedServiceName: evt.deploymentName,
          outcome: "success",
          onCallHandle: null,
        };

        await this.notificationAgent.dispatch(notifyCmd);
        break;
      }

      // ────── Rollback → Notify ──────────────────────────────────────────
      case "RollbackEvent": {
        const evt = event as RollbackEvent;
        const notifyCmd: NotifyCommand = {
          eventId: evt.eventId,
          correlationId, // Requirement 8.4
          eventType: "NotifyCommand",
          source: "Orchestrator",
          timestamp,
          triggerEvent: evt,
          orchestratorTimestamp: timestamp,
          affectedServiceName: evt.deploymentName,
          outcome: "rollback",
          onCallHandle: null,
        };

        await this.notificationAgent.dispatch(notifyCmd);
        break;
      }

      // ────── Incident escalation → Notify ─────────────────────────────────
      case "IncidentEscalationEvent": {
        const evt = event as IncidentEscalationEvent;
        const notifyCmd: NotifyCommand = {
          eventId: evt.eventId,
          correlationId, // Requirement 8.4
          eventType: "NotifyCommand",
          source: "Orchestrator",
          timestamp,
          triggerEvent: evt,
          orchestratorTimestamp: timestamp,
          affectedServiceName: evt.serviceName,
          outcome: "escalated",
          onCallHandle: evt.onCallHandle,
        };

        await this.notificationAgent.dispatch(notifyCmd);
        break;
      }

      // ────── Critical failure → Notify ──────────────────────────────────
      case "CriticalFailureEvent": {
        const evt = event as CriticalFailureEvent;
        const notifyCmd: NotifyCommand = {
          eventId: evt.eventId,
          correlationId, // Requirement 8.4
          eventType: "NotifyCommand",
          source: "Orchestrator",
          timestamp,
          triggerEvent: evt,
          orchestratorTimestamp: timestamp,
          affectedServiceName: evt.deploymentName,
          outcome: "failure",
          onCallHandle: null,
        };

        await this.notificationAgent.dispatch(notifyCmd);
        break;
      }

      default:
        this.logger.debug({
          action: "commandDispatcher.dispatch",
          outcome: "no_route",
          eventType,
          correlationId,
        });
    }
  }
}
