/**
 * Deployment_Agent — rollout monitoring and timeout detection logic.
 *
 * Polls Kubernetes rollout status every 15 seconds and detects when the rollout
 * succeeds or times out. On timeout, initiates automatic rollback.
 *
 * Requirements: 3.2, 3.3, 3.4, 3.5
 */

import { v4 as uuidv4 } from "uuid";
import { StructuredLogger } from "../../utils/logger";
import type {
  DeploymentSuccessEvent,
  RollbackEvent,
  RolloutHandle,
  Result,
  DeployError,
} from "../../types/models";
import type { OutboundEvent } from "../../interfaces/shared";

/**
 * Kubernetes rollout status snapshot.
 */
export interface RolloutStatus {
  deploymentName: string;
  namespace: string;
  ready: number;
  desired: number;
  isReady: boolean;
}

/**
 * Minimal interface for polling Kubernetes rollout status.
 */
export interface KubernetesClient {
  /**
   * Get the current rollout status of a deployment.
   * @returns Ok(RolloutStatus) on success, Err on failure.
   */
  getRolloutStatus(
    deploymentName: string,
    namespace: string
  ): Promise<Result<RolloutStatus, DeployError>>;
}

/**
 * Callback type used by the monitor to emit events back to the Orchestrator.
 */
export type EmitFn = (event: OutboundEvent) => void;

/**
 * Configuration for the rollout monitor.
 */
export interface MonitorConfig {
  /** How long to wait before checking for timeout (ms). Default: 15_000 (15 s). */
  pollIntervalMs?: number;
  /** Maximum time to wait for rollout to reach ready state (ms). Default: 600_000 (600 s). */
  rolloutTimeoutMs?: number;
  /** ISO 8601 timestamp when monitoring started. Defaults to now. */
  startTimestamp?: string;
}

/**
 * Helper function to sleep.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Monitors a Kubernetes rollout until it reaches a terminal state (success or timeout).
 *
 * Polls every 15 s by default. When rollout succeeds, emits DeploymentSuccessEvent.
 * When rollout timeout elapses without reaching ready state, initiates automatic rollback
 * and emits a RollbackEvent.
 *
 * Requirements: 3.2, 3.3, 3.4, 3.5
 */
export class RolloutMonitor {
  private readonly kubernetes: KubernetesClient;
  private readonly emit: EmitFn;
  private readonly logger: StructuredLogger;
  private stopped = false;

  constructor(
    kubernetes: KubernetesClient,
    emit: EmitFn,
    logger?: StructuredLogger
  ) {
    this.kubernetes = kubernetes;
    this.emit = emit;
    this.logger = logger ?? new StructuredLogger();
  }

  /**
   * Stop the monitor (used to halt polling).
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Start monitoring a rollout until completion, timeout, or stop() is called.
   *
   * Requirements: 3.2, 3.3, 3.4, 3.5
   */
  async start(
    handle: RolloutHandle,
    config: MonitorConfig = {}
  ): Promise<void> {
    this.stopped = false;

    const { deploymentName, namespace, pipelineRunId } = handle;
    const {
      pollIntervalMs = 15_000,
      rolloutTimeoutMs = 600_000,
      startTimestamp,
    } = config;

    const correlationId = uuidv4();
    const startTime = startTimestamp
      ? new Date(startTimestamp).getTime()
      : Date.now();

    this.logger.info({
      action: "rolloutMonitor.start",
      outcome: "pending",
      params: { deploymentName, namespace, rolloutTimeoutMs },
      correlationId,
    });

    // ── Polling loop ──────────────────────────────────────────────────────
    while (!this.stopped) {
      const elapsedMs = Date.now() - startTime;

      // Check for timeout
      if (elapsedMs > rolloutTimeoutMs) {
        this.logger.warn({
          action: "rolloutMonitor.timeout",
          outcome: "timeout",
          params: { deploymentName, namespace, elapsedMs, rolloutTimeoutMs },
          correlationId,
        });

        // Requirement 3.5: Initiate rollback on timeout
        const rollbackEvent: RollbackEvent = {
          eventId: uuidv4(),
          correlationId,
          eventType: "RollbackEvent",
          source: "Deployment_Agent",
          timestamp: new Date().toISOString(),
          deploymentName,
          namespace,
          reason: "rollout timeout",
        };

        this.emit(rollbackEvent as unknown as OutboundEvent);
        return;
      }

      // Poll status
      const statusResult = await this.kubernetes.getRolloutStatus(
        deploymentName,
        namespace
      );

      if (!statusResult.success) {
        this.logger.warn({
          action: "rolloutMonitor.poll",
          outcome: "failure",
          params: { deploymentName, namespace },
          correlationId,
          errorMessage: statusResult.error.message,
        });

        // Wait and retry
        await sleep(pollIntervalMs);
        continue;
      }

      const status = statusResult.value;

      // Check if rollout has succeeded
      if (status.isReady) {
        this.logger.info({
          action: "rolloutMonitor.completed",
          outcome: "success",
          params: { deploymentName, namespace, ready: status.ready, desired: status.desired },
          correlationId,
        });

        // Requirement 3.3: Emit DeploymentSuccessEvent
        const successEvent: DeploymentSuccessEvent = {
          eventId: uuidv4(),
          correlationId,
          eventType: "DeploymentSuccessEvent",
          source: "Deployment_Agent",
          timestamp: new Date().toISOString(),
          deploymentName,
          namespace,
        };

        this.emit(successEvent as unknown as OutboundEvent);
        return;
      }

      // Still in progress — wait before next poll
      if (!this.stopped) {
        await sleep(pollIntervalMs);
      }
    }

    this.logger.debug({
      action: "rolloutMonitor.stopped",
      outcome: "pending",
      params: { deploymentName, namespace },
      correlationId,
    });
  }
}
