/**
 * Deployment_Agent — automatic rollback logic.
 *
 * Handles rollback dispatch, completion monitoring, and pod readiness verification.
 * On critical failures, records the deployment in a halt registry.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */
import { StructuredLogger } from "../../utils/logger";
import type { RollbackAttemptLog, DeploymentRef, RollbackError, Result } from "../../types/models";
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
    initiateRollback(deploymentName: string, namespace: string): Promise<Result<void, RollbackError>>;
    /**
     * Get pod readiness status for a deployment.
     * Used to verify rollback completion.
     */
    getPodReadiness(deploymentName: string, namespace: string): Promise<Result<PodReadinessStatus, RollbackError>>;
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
export type HaltDeploymentFn = (deployment: DeploymentRef, reason: string) => void;
/**
 * Handles automatic rollbacks with strict timing and readiness verification.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */
export declare class RollbackHandler {
    private readonly kubernetes;
    private readonly emit;
    private readonly recordAttempt;
    private readonly haltDeployment;
    private readonly logger;
    constructor(kubernetes: KubernetesClient, emit: EmitFn, recordAttempt: RecordAttemptFn, haltDeployment: HaltDeploymentFn, logger?: StructuredLogger);
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
    executeRollback(deploymentName: string, namespace: string, correlationId: string): Promise<void>;
}
//# sourceMappingURL=rollback.d.ts.map