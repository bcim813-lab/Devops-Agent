/**
 * Deployment_Agent — rollout monitoring and timeout detection logic.
 *
 * Polls Kubernetes rollout status every 15 seconds and detects when the rollout
 * succeeds or times out. On timeout, initiates automatic rollback.
 *
 * Requirements: 3.2, 3.3, 3.4, 3.5
 */
import { StructuredLogger } from "../../utils/logger";
import type { RolloutHandle, Result, DeployError } from "../../types/models";
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
    getRolloutStatus(deploymentName: string, namespace: string): Promise<Result<RolloutStatus, DeployError>>;
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
 * Monitors a Kubernetes rollout until it reaches a terminal state (success or timeout).
 *
 * Polls every 15 s by default. When rollout succeeds, emits DeploymentSuccessEvent.
 * When rollout timeout elapses without reaching ready state, initiates automatic rollback
 * and emits a RollbackEvent.
 *
 * Requirements: 3.2, 3.3, 3.4, 3.5
 */
export declare class RolloutMonitor {
    private readonly kubernetes;
    private readonly emit;
    private readonly logger;
    private stopped;
    constructor(kubernetes: KubernetesClient, emit: EmitFn, logger?: StructuredLogger);
    /**
     * Stop the monitor (used to halt polling).
     */
    stop(): void;
    /**
     * Start monitoring a rollout until completion, timeout, or stop() is called.
     *
     * Requirements: 3.2, 3.3, 3.4, 3.5
     */
    start(handle: RolloutHandle, config?: MonitorConfig): Promise<void>;
}
//# sourceMappingURL=monitor.d.ts.map