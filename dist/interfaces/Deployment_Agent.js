"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
/** Snapshot of a Kubernetes rollout's current progress */
//# sourceMappingURL=Deployment_Agent.js.map