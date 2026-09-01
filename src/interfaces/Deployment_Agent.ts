/**
 * Deployment_Agent interface — manages Kubernetes deployments, rollouts, and rollbacks.
 *
 * Key behaviors:
 * - Only applies manifests when pipeline config contains an explicit manifest_path.
 * - Polls rollout status every 15 s.
 * - Initiates automatic rollback after rollout_timeout (default 600 s) without ready state.
 * - Dispatches rollback within 5 s; rollback must complete within 120 s.
 * - Halts automation for (deploymentName, namespace) pair on critical failure.
 * - Logs every rollback attempt with timestamp, name, namespace, outcome.
 */

import type {
  DeploymentCommand,
  RolloutHandle,
  RolloutStatus,
  DeploymentRef,
  DeployError,
  RollbackError,
  Result,
} from "../types/models";

export type { RolloutStatus };

export interface Deployment_Agent {
  /**
   * Apply a Kubernetes manifest to the target cluster and namespace.
   *
   * Only proceeds when manifestFilePath is explicitly set in the command.
   * On Kubernetes API error: emits DeploymentFailureEvent (does NOT rollback).
   * On success: begins rollout monitoring and emits a RolloutHandle for tracking.
   *
   * @returns Ok(RolloutHandle) if manifest applied, Err(DeployError) otherwise.
   */
  applyManifest(
    command: DeploymentCommand
  ): Promise<Result<RolloutHandle, DeployError>>;

  /**
   * Monitor the rollout status of an active Kubernetes deployment.
   *
   * Polls every 15 s. On successful rollout: emits DeploymentSuccessEvent.
   * On timeout without ready state: initiates automatic rollback.
   *
   * @returns Current RolloutStatus snapshot.
   */
  monitorRollout(handle: RolloutHandle): Promise<RolloutStatus>;

  /**
   * Initiate a rollback to the last successfully deployed revision.
   *
   * Must dispatch the rollback command to Kubernetes within 5 s.
   * Rollback must complete within 120 s of dispatch.
   * After completion: verifies all pods are Ready at desired replica count.
   * On failure/timeout: emits CriticalFailureEvent and halts the pair.
   *
   * @returns Ok(void) on successful rollback, Err(RollbackError) on failure.
   */
  initiateRollback(
    deployment: DeploymentRef
  ): Promise<Result<void, RollbackError>>;

  /**
   * Resume automated actions for a halted (deploymentName, namespace) pair.
   * This operation is gated to DevOps_Engineer-level access.
   * Clears the halt state from both the in-memory registry and the persisted store.
   */
  resumeDeployment(deployment: DeploymentRef): void;
}

/** Snapshot of a Kubernetes rollout's current progress */

