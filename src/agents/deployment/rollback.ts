/**
 * Deployment_Agent — automatic rollback logic.
 *
 * Handles rollback dispatch, completion monitoring, and pod readiness verification.
 * On critical failures, records the deployment in a halt registry.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import { v4 as uuidv4 } from "uuid";
import { StructuredLogger } from "../../utils/logger";
import type {
  RollbackSuccessEvent,
  CriticalFailureEvent,
  RollbackAttemptLog,
  DeploymentRef,
  DeployError,
  RollbackError,
  Result,
} from "../../types/models";
import type { OutboundEvent } from "../../interfaces/shared";

/**
 * Pod readiness status for a deployment.
 */
export interface PodReadinessStatus {
  deploymentName: string;
  namespace: string;
  podsReady: number;
  podsDesired: number;
  allReady: boolean;
}

/**
 * Minimal interface for Kubernetes rollback operations.
 */
export interface KubernetesClient {
  /**
   * Dispatch a rollback command to Kubernetes.
   * Must complete within 5 seconds.
   * @returns Ok(void) on success, Err on failure.
   */
  initiateRollback(
    deploymentName: string,
    namespace: string
  ): Promise<Result<void, RollbackError>>;

  /**
   * Get pod readiness status for a deployment.
   * Used to verify rollback completion.
   */
  getPodReadiness(
    deploymentName: string,
    namespace: string
  ): Promise<Result<PodReadinessStatus, RollbackError>>;
}

/**
 * Callback type used by the rollback handler to emit events back to the Orchestrator.
 */
export type EmitFn = (event: OutboundEvent) => void;

/**
 * Callback to record a rollback attempt in the audit log.
 */
export type RecordAttemptFn = (log: RollbackAttemptLog) => void;

/**
 * Callback to record a deployment in the halt registry.
 */
export type HaltDeploymentFn = (
  deployment: DeploymentRef,
  reason: string
) => void;

/**
 * Handles automatic rollbacks with strict timing and readiness verification.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */
export class RollbackHandler {
  private readonly kubernetes: KubernetesClient;
  private readonly emit: EmitFn;
  private readonly recordAttempt: RecordAttemptFn;
  private readonly haltDeployment: HaltDeploymentFn;
  private readonly logger: StructuredLogger;

  constructor(
    kubernetes: KubernetesClient,
    emit: EmitFn,
    recordAttempt: RecordAttemptFn,
    haltDeployment: HaltDeploymentFn,
    logger?: StructuredLogger
  ) {
    this.kubernetes = kubernetes;
    this.emit = emit;
    this.recordAttempt = recordAttempt;
    this.haltDeployment = haltDeployment;
    this.logger = logger ?? new StructuredLogger();
  }

  /**
   * Execute an automatic rollback for the given deployment.
   *
   * 1. Dispatch rollback command to Kubernetes within 5 seconds.
   * 2. Wait for rollback to complete (120 s timeout).
   * 3. Verify all pods reach Ready state at desired replica count.
   * 4. Emit RollbackSuccessEvent on success.
   * 5. On dispatch failure, timeout, or API error: emit CriticalFailureEvent and halt.
   *
   * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
   */
  async executeRollback(
    deploymentName: string,
    namespace: string,
    correlationId: string
  ): Promise<void> {
    const deployment: DeploymentRef = { deploymentName, namespace };
    const now = new Date().toISOString();

    this.logger.info({
      action: "rollback.start",
      outcome: "pending",
      params: { deploymentName, namespace },
      correlationId,
    });

    // ── Dispatch rollback within 5 seconds ─────────────────────────────────
    const dispatchStart = Date.now();
    const dispatchResult = await this.kubernetes.initiateRollback(
      deploymentName,
      namespace
    );

    if (!dispatchResult.success) {
      this.logger.error({
        action: "rollback.dispatch",
        outcome: "failure",
        params: { deploymentName, namespace },
        correlationId,
        errorMessage: dispatchResult.error.message,
      });

      // Requirement 4.3 & 4.4: Record and halt
      this.recordAttempt({
        timestamp: now,
        deploymentName,
        namespace,
        outcome: "failed",
        correlationId,
      });

      const criticalEvent: CriticalFailureEvent = {
        eventId: uuidv4(),
        correlationId,
        eventType: "CriticalFailureEvent",
        source: "Deployment_Agent",
        timestamp: now,
        deploymentName,
        namespace,
        failureReason: `Rollback dispatch failed: ${dispatchResult.error.message}`,
      };

      this.emit(criticalEvent as unknown as OutboundEvent);
      this.haltDeployment(deployment, "rollback dispatch failed");
      return;
    }

    const dispatchElapsed = Date.now() - dispatchStart;
    if (dispatchElapsed > 5_000) {
      this.logger.warn({
        action: "rollback.dispatch",
        outcome: "timeout",
        params: { deploymentName, namespace, dispatchElapsedMs: dispatchElapsed },
        correlationId,
      });
    } else {
      this.logger.info({
        action: "rollback.dispatch",
        outcome: "success",
        params: { deploymentName, namespace, dispatchElapsedMs: dispatchElapsed },
        correlationId,
      });
    }

    // ── Wait for rollback completion within 120 seconds ──────────────────────
    const rollbackStart = Date.now();
    const rollbackTimeoutMs = 120_000;

    let readinessResult: Result<PodReadinessStatus, RollbackError> | null = null;

    while (Date.now() - rollbackStart < rollbackTimeoutMs) {
      readinessResult = await this.kubernetes.getPodReadiness(
        deploymentName,
        namespace
      );

      if (!readinessResult.success) {
        this.logger.warn({
          action: "rollback.readiness.poll",
          outcome: "failure",
          params: { deploymentName, namespace },
          correlationId,
          errorMessage: readinessResult.error.message,
        });

        // Kubernetes API error during rollback → critical failure
        this.recordAttempt({
          timestamp: new Date().toISOString(),
          deploymentName,
          namespace,
          outcome: "failed",
          correlationId,
        });

        const criticalEvent: CriticalFailureEvent = {
          eventId: uuidv4(),
          correlationId,
          eventType: "CriticalFailureEvent",
          source: "Deployment_Agent",
          timestamp: new Date().toISOString(),
          deploymentName,
          namespace,
          failureReason: `Rollback monitoring failed: ${readinessResult.error.message}`,
        };

        this.emit(criticalEvent as unknown as OutboundEvent);
        this.haltDeployment(deployment, "rollback monitoring failed");
        return;
      }

      // Requirement 4.2: Verify all pods ready at desired count
      if (readinessResult.value.allReady) {
        const rollbackElapsed = Date.now() - rollbackStart;
        this.logger.info({
          action: "rollback.completed",
          outcome: "success",
          params: {
            deploymentName,
            namespace,
            podsReady: readinessResult.value.podsReady,
            podsDesired: readinessResult.value.podsDesired,
            elapsedMs: rollbackElapsed,
          },
          correlationId,
        });

        // Record successful attempt
        this.recordAttempt({
          timestamp: new Date().toISOString(),
          deploymentName,
          namespace,
          outcome: "success",
          correlationId,
        });

        // Requirement 4.1: Emit RollbackSuccessEvent
        const successEvent: RollbackSuccessEvent = {
          eventId: uuidv4(),
          correlationId,
          eventType: "RollbackSuccessEvent",
          source: "Deployment_Agent",
          timestamp: new Date().toISOString(),
          deploymentName,
          namespace,
        };

        this.emit(successEvent as unknown as OutboundEvent);
        return;
      }

      // Still rolling back — wait and poll again
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }

    // ── Rollback timeout exceeded ──────────────────────────────────────────
    this.logger.error({
      action: "rollback.timeout",
      outcome: "timeout",
      params: { deploymentName, namespace, rollbackTimeoutMs },
      correlationId,
    });

    this.recordAttempt({
      timestamp: new Date().toISOString(),
      deploymentName,
      namespace,
      outcome: "timed-out",
      correlationId,
    });

    const criticalEvent: CriticalFailureEvent = {
      eventId: uuidv4(),
      correlationId,
      eventType: "CriticalFailureEvent",
      source: "Deployment_Agent",
      timestamp: new Date().toISOString(),
      deploymentName,
      namespace,
      failureReason: `Rollback did not complete within ${rollbackTimeoutMs}ms`,
    };

    this.emit(criticalEvent as unknown as OutboundEvent);
    this.haltDeployment(deployment, "rollback timeout");
  }
}
