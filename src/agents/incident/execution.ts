/**
 * Incident_Agent — runbook execution and escalation logic.
 *
 * Handles PagerDuty alerts by looking up and executing runbooks.
 * On P1/P2: attempt execution; on failure escalate.
 * P3/P4: ignored.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.6
 */

import { v4 as uuidv4 } from "uuid";
import { StructuredLogger } from "../../utils/logger";
import { RunbookLibrary } from "./runbookLibrary";
import type {
  PagerDutyAlert,
  Runbook,
  IncidentResolvedEvent,
  IncidentEscalationEvent,
  IncidentExecutionFailureEvent,
  RunbookError,
  HandleError,
} from "../../types/models";
import type { OutboundEvent } from "../../interfaces/shared";

/**
 * Minimal PagerDuty API client interface.
 */
export interface PagerDutyClient {
  /**
   * Acknowledge an incident in PagerDuty.
   * Returns Ok on success, Err on failure.
   */
  acknowledgeIncident(incidentId: string): Promise<{ success: boolean; error?: Error }>;
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
  postMessage(
    channel: string,
    text: string
  ): Promise<{ success: boolean; error?: Error }>;
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
  executeStep(step: Record<string, unknown>): Promise<{ success: boolean; error?: Error }>;
}

/**
 * Handles incident response by executing runbooks or escalating to on-call.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.6
 */
export class IncidentHandler {
  private readonly library: RunbookLibrary;
  private readonly pagerduty: PagerDutyClient;
  private readonly slack: SlackClient;
  private readonly executor: RunbookExecutor;
  private readonly emit: EmitFn;
  private readonly resolveOnCallHandle: ResolveOnCallHandleFn;
  private readonly logger: StructuredLogger;

  constructor(
    library: RunbookLibrary,
    pagerduty: PagerDutyClient,
    slack: SlackClient,
    executor: RunbookExecutor,
    emit: EmitFn,
    resolveOnCallHandle: ResolveOnCallHandleFn,
    logger?: StructuredLogger
  ) {
    this.library = library;
    this.pagerduty = pagerduty;
    this.slack = slack;
    this.executor = executor;
    this.emit = emit;
    this.resolveOnCallHandle = resolveOnCallHandle;
    this.logger = logger ?? new StructuredLogger();
  }

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
  async handleAlert(
    alert: PagerDutyAlert,
    config: ExecutionConfig = {}
  ): Promise<void> {
    const { incidentId, serviceName, severity } = alert;
    const correlationId = uuidv4();

    this.logger.info({
      action: "incident.handleAlert",
      outcome: "pending",
      params: { incidentId, serviceName, severity },
      correlationId,
    });

    // Requirement 5.1: Ignore P3/P4 alerts
    if (severity === "P3" || severity === "P4") {
      this.logger.debug({
        action: "incident.handleAlert",
        outcome: "ignored",
        reason: "P3/P4 severity",
        params: { incidentId, severity },
      });
      return;
    }

    // ── P1/P2 handling ────────────────────────────────────────────────────
    // Requirement 5.2 & 5.3: Look up latest runbook within 30 s
    const startTime = Date.now();

    let runbook: Runbook | undefined;
    try {
      runbook = this.library.getLatest(serviceName);
      const elapsedMs = Date.now() - startTime;

      if (elapsedMs > 30_000) {
        this.logger.warn({
          action: "incident.runbookLookup",
          outcome: "timeout",
          params: { serviceName, elapsedMs },
          correlationId,
        });
      }
    } catch (err) {
      this.logger.error({
        action: "incident.runbookLookup",
        outcome: "failure",
        params: { serviceName },
        correlationId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }

    // Requirement 5.4: If no runbook found, escalate within 30 s
    if (!runbook) {
      await this._escalate(incidentId, serviceName, "No runbook found", correlationId);

      const failureEvent: IncidentExecutionFailureEvent = {
        eventId: uuidv4(),
        correlationId,
        eventType: "IncidentExecutionFailureEvent",
        source: "Incident_Agent",
        timestamp: new Date().toISOString(),
        incidentId,
        serviceName,
        failureReason: "No runbook found",
      };

      this.emit(failureEvent as unknown as OutboundEvent);
      return;
    }

    // ── Execute runbook with 300 s timeout ─────────────────────────────────
    // Requirement 5.2 & 5.3: Enforce 300 s timeout
    const timeoutSeconds = config.timeoutSeconds ?? 300;
    const timeoutMs = timeoutSeconds * 1000;

    const executionStart = Date.now();
    let executionSuccess = true;
    let executionError: Error | null = null;

    try {
      // Execute all steps sequentially with timeout enforcement
      for (const step of runbook.steps) {
        if (Date.now() - executionStart > timeoutMs) {
          this.logger.warn({
            action: "incident.execution",
            outcome: "timeout",
            params: { incidentId, stepId: step.stepId, timeoutMs },
            correlationId,
          });

          executionSuccess = false;
          executionError = new Error(`Runbook execution timed out after ${timeoutSeconds}s`);
          break;
        }

        const stepResult = await this.executor.executeStep(step.action);
        if (!stepResult.success) {
          executionSuccess = false;
          executionError = stepResult.error ?? new Error("Step execution failed");

          this.logger.warn({
            action: "incident.stepExecution",
            outcome: "failure",
            params: { incidentId, stepId: step.stepId },
            correlationId,
            errorMessage: executionError.message,
          });

          break;
        }
      }
    } catch (err) {
      executionSuccess = false;
      executionError = err instanceof Error ? err : new Error(String(err));

      this.logger.error({
        action: "incident.execution",
        outcome: "failure",
        params: { incidentId },
        correlationId,
        errorMessage: executionError.message,
      });
    }

    // ── Handle execution outcome ──────────────────────────────────────────
    if (executionSuccess) {
      // Requirement 5.3: Acknowledge PagerDuty incident
      const ackResult = await this.pagerduty.acknowledgeIncident(incidentId);
      if (!ackResult.success) {
        this.logger.warn({
          action: "incident.pdAck",
          outcome: "failure",
          params: { incidentId },
          correlationId,
          errorMessage: ackResult.error?.message,
        });
      }

      this.logger.info({
        action: "incident.resolved",
        outcome: "success",
        params: { incidentId, serviceName },
        correlationId,
      });

      const resolvedEvent: IncidentResolvedEvent = {
        eventId: uuidv4(),
        correlationId,
        eventType: "IncidentResolvedEvent",
        source: "Incident_Agent",
        timestamp: new Date().toISOString(),
        incidentId,
        serviceName,
      };

      this.emit(resolvedEvent as unknown as OutboundEvent);
    } else {
      // Requirement 5.4: Escalate via Slack within 30 s
      const reason = executionError?.message ?? "Runbook execution failed";
      await this._escalate(incidentId, serviceName, reason, correlationId);

      const failureEvent: IncidentExecutionFailureEvent = {
        eventId: uuidv4(),
        correlationId,
        eventType: "IncidentExecutionFailureEvent",
        source: "Incident_Agent",
        timestamp: new Date().toISOString(),
        incidentId,
        serviceName,
        failureReason: reason,
      };

      this.emit(failureEvent as unknown as OutboundEvent);
    }
  }

  /**
   * Private helper: escalate incident to on-call via Slack within 30 s.
   */
  private async _escalate(
    incidentId: string,
    serviceName: string,
    reason: string,
    correlationId: string
  ): Promise<void> {
    const escalateStart = Date.now();

    try {
      // Resolve on-call handle from config
      const handle = await this.resolveOnCallHandle(serviceName);

      if (!handle) {
        this.logger.warn({
          action: "incident.escalation",
          outcome: "handle_unresolvable",
          params: { incidentId, serviceName },
          correlationId,
        });

        // Emit escalation event with null handle
        const escalationEvent: IncidentEscalationEvent = {
          eventId: uuidv4(),
          correlationId,
          eventType: "IncidentEscalationEvent",
          source: "Incident_Agent",
          timestamp: new Date().toISOString(),
          incidentId,
          serviceName,
          reason,
          onCallHandle: null,
        };

        this.emit(escalationEvent as unknown as OutboundEvent);
        return;
      }

      // Post to Slack
      const message = `🚨 Incident ${incidentId} for ${serviceName}: ${reason}. ${handle} on-call required.`;

      // Assume there's a #incidents channel or similar (implementation detail)
      const postResult = await this.slack.postMessage("#incidents", message);

      if (!postResult.success) {
        this.logger.warn({
          action: "incident.escalation",
          outcome: "postMessage_failed",
          params: { incidentId, handle },
          correlationId,
          errorMessage: postResult.error?.message,
        });
      } else {
        const elapsedMs = Date.now() - escalateStart;
        if (elapsedMs <= 30_000) {
          this.logger.info({
            action: "incident.escalation",
            outcome: "success",
            params: { incidentId, serviceName, handle, elapsedMs },
            correlationId,
          });
        }
      }

      // Emit escalation event
      const escalationEvent: IncidentEscalationEvent = {
        eventId: uuidv4(),
        correlationId,
        eventType: "IncidentEscalationEvent",
        source: "Incident_Agent",
        timestamp: new Date().toISOString(),
        incidentId,
        serviceName,
        reason,
        onCallHandle: handle,
      };

      this.emit(escalationEvent as unknown as OutboundEvent);
    } catch (err) {
      this.logger.error({
        action: "incident.escalation",
        outcome: "failure",
        params: { incidentId, serviceName },
        correlationId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
