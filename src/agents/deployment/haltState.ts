/**
 * Deployment_Agent — halt state registry.
 *
 * Maintains an in-memory and persisted registry of (deploymentName, namespace)
 * pairs that are halted. All commands targeting a halted pair return HaltedError
 * without executing.
 *
 * Requirements: 4.3, 4.4
 */

import * as fs from "fs";
import * as path from "path";
import { StructuredLogger, logger as defaultLogger } from "../../utils/logger";
import type {
  DeploymentHaltState,
  DeploymentRef,
  ISO8601String,
} from "../../types/models";
import { HaltedError } from "../../types/models";

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
export class DeploymentHaltRegistry {
  private readonly halts: Map<string, DeploymentHaltState> = new Map();
  private readonly persistPath: string;
  private readonly logger: StructuredLogger;

  constructor(options: HaltRegistryOptions = {}) {
    this.persistPath =
      options.persistPath || path.resolve(".data", "deployment-halts.json");
    this.logger = options.logger ?? defaultLogger;

    this._load();
  }

  /**
   * Check if a deployment pair is halted. If so, throw HaltedError.
   * Otherwise, return normally.
   *
   * Requirement 4.4: All commands targeting a halted pair return HaltedError immediately.
   */
  checkAndThrowIfHalted(deployment: DeploymentRef): void {
    const key = this._makeKey(deployment);
    const haltState = this.halts.get(key);

    if (haltState) {
      this.logger.warn({
        action: "DeploymentHaltRegistry.checkAndThrowIfHalted",
        outcome: "blocked",
        params: {
          deploymentName: deployment.deploymentName,
          namespace: deployment.namespace,
        },
        haltReason: haltState.reason,
        haltedAt: haltState.haltedAt,
      });

      throw new HaltedError(
        deployment.deploymentName,
        deployment.namespace,
        haltState.haltedAt,
        haltState.reason
      );
    }
  }

  /**
   * Record a deployment as halted.
   * Requirement 4.4: Record the (deploymentName, namespace) pair in the halt registry.
   */
  halt(
    deployment: DeploymentRef,
    reason: string,
    haltedAt: ISO8601String = new Date().toISOString()
  ): void {
    const key = this._makeKey(deployment);
    const state: DeploymentHaltState = {
      deploymentName: deployment.deploymentName,
      namespace: deployment.namespace,
      haltedAt,
      reason,
      haltedUntilManualResume: true,
    };

    this.halts.set(key, state);
    this._persist();

    this.logger.info({
      action: "DeploymentHaltRegistry.halt",
      outcome: "recorded",
      params: {
        deploymentName: deployment.deploymentName,
        namespace: deployment.namespace,
      },
      reason,
      haltedAt,
    });
  }

  /**
   * Clear a halt (resume deployment). DevOps_Engineer-gated operation.
   * Requirement 4.4: Implement `resumeDeployment(deploymentRef)` to clear a halt.
   */
  resume(deployment: DeploymentRef): void {
    const key = this._makeKey(deployment);
    const wasHalted = this.halts.has(key);

    if (wasHalted) {
      this.halts.delete(key);
      this._persist();

      this.logger.info({
        action: "DeploymentHaltRegistry.resume",
        outcome: "cleared",
        params: {
          deploymentName: deployment.deploymentName,
          namespace: deployment.namespace,
        },
      });
    }
  }

  /**
   * List all currently halted deployments.
   */
  listHalted(): DeploymentHaltState[] {
    return Array.from(this.halts.values());
  }

  /**
   * Check if a deployment is currently halted (without throwing).
   */
  isHalted(deployment: DeploymentRef): boolean {
    const key = this._makeKey(deployment);
    return this.halts.has(key);
  }

  /**
   * Get the halt state for a deployment (if any).
   */
  getHaltState(deployment: DeploymentRef): DeploymentHaltState | undefined {
    const key = this._makeKey(deployment);
    return this.halts.get(key);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private _makeKey(deployment: DeploymentRef): string {
    return `${deployment.deploymentName}:${deployment.namespace}`;
  }

  private _load(): void {
    if (!fs.existsSync(this.persistPath)) {
      return;
    }

    try {
      const data = fs.readFileSync(this.persistPath, "utf8");
      const states: DeploymentHaltState[] = JSON.parse(data);

      for (const state of states) {
        const key = `${state.deploymentName}:${state.namespace}`;
        this.halts.set(key, state);
      }

      this.logger.debug({
        action: "DeploymentHaltRegistry._load",
        outcome: "success",
        loadedCount: states.length,
      });
    } catch (err) {
      this.logger.warn({
        action: "DeploymentHaltRegistry._load",
        outcome: "failure",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private _persist(): void {
    try {
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const states = Array.from(this.halts.values());
      fs.writeFileSync(this.persistPath, JSON.stringify(states, null, 2));
    } catch (err) {
      this.logger.error({
        action: "DeploymentHaltRegistry._persist",
        outcome: "failure",
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
