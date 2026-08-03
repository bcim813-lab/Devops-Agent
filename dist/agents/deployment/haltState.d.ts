/**
 * Deployment_Agent — halt state registry.
 *
 * Maintains an in-memory and persisted registry of (deploymentName, namespace)
 * pairs that are halted. All commands targeting a halted pair return HaltedError
 * without executing.
 *
 * Requirements: 4.3, 4.4
 */
import { StructuredLogger } from "../../utils/logger";
import type { DeploymentHaltState, DeploymentRef, ISO8601String } from "../../types/models";
/**
 * Configuration options for the halt registry.
 */
export interface HaltRegistryOptions {
    /** Path to persist halt state (JSON). Defaults to .data/deployment-halts.json */
    persistPath?: string;
    /** Logger instance. Defaults to the module logger. */
    logger?: StructuredLogger;
}
/**
 * In-memory and persisted registry of halted deployments.
 *
 * A deployment is identified by the pair (deploymentName, namespace).
 * Once halted, all commands targeting that pair throw HaltedError immediately.
 *
 * Requirements: 4.3, 4.4
 */
export declare class DeploymentHaltRegistry {
    private readonly halts;
    private readonly persistPath;
    private readonly logger;
    constructor(options?: HaltRegistryOptions);
    /**
     * Check if a deployment pair is halted. If so, throw HaltedError.
     * Otherwise, return normally.
     *
     * Requirement 4.4: All commands targeting a halted pair return HaltedError immediately.
     */
    checkAndThrowIfHalted(deployment: DeploymentRef): void;
    /**
     * Record a deployment as halted.
     * Requirement 4.4: Record the (deploymentName, namespace) pair in the halt registry.
     */
    halt(deployment: DeploymentRef, reason: string, haltedAt?: ISO8601String): void;
    /**
     * Clear a halt (resume deployment). DevOps_Engineer-gated operation.
     * Requirement 4.4: Implement `resumeDeployment(deploymentRef)` to clear a halt.
     */
    resume(deployment: DeploymentRef): void;
    /**
     * List all currently halted deployments.
     */
    listHalted(): DeploymentHaltState[];
    /**
     * Check if a deployment is currently halted (without throwing).
     */
    isHalted(deployment: DeploymentRef): boolean;
    /**
     * Get the halt state for a deployment (if any).
     */
    getHaltState(deployment: DeploymentRef): DeploymentHaltState | undefined;
    private _makeKey;
    private _load;
    private _persist;
}
//# sourceMappingURL=haltState.d.ts.map