"use strict";
/**
 * Deployment_Agent — rollout monitoring and timeout detection logic.
 *
 * Polls Kubernetes rollout status every 15 seconds and detects when the rollout
 * succeeds or times out. On timeout, initiates automatic rollback.
 *
 * Requirements: 3.2, 3.3, 3.4, 3.5
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RolloutMonitor = void 0;
const uuid_1 = require("uuid");
const logger_1 = require("../../utils/logger");
/**
 * Helper function to sleep.
 */
function sleep(ms) {
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
class RolloutMonitor {
    constructor(kubernetes, emit, logger) {
        this.stopped = false;
        this.kubernetes = kubernetes;
        this.emit = emit;
        this.logger = logger ?? new logger_1.StructuredLogger();
    }
    /**
     * Stop the monitor (used to halt polling).
     */
    stop() {
        this.stopped = true;
    }
    /**
     * Start monitoring a rollout until completion, timeout, or stop() is called.
     *
     * Requirements: 3.2, 3.3, 3.4, 3.5
     */
    async start(handle, config = {}) {
        this.stopped = false;
        const { deploymentName, namespace, pipelineRunId } = handle;
        const { pollIntervalMs = 15000, rolloutTimeoutMs = 600000, startTimestamp, } = config;
        const correlationId = (0, uuid_1.v4)();
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
                const rollbackEvent = {
                    eventId: (0, uuid_1.v4)(),
                    correlationId,
                    eventType: "RollbackEvent",
                    source: "Deployment_Agent",
                    timestamp: new Date().toISOString(),
                    deploymentName,
                    namespace,
                    reason: "rollout timeout",
                };
                this.emit(rollbackEvent);
                return;
            }
            // Poll status
            const statusResult = await this.kubernetes.getRolloutStatus(deploymentName, namespace);
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
                const successEvent = {
                    eventId: (0, uuid_1.v4)(),
                    correlationId,
                    eventType: "DeploymentSuccessEvent",
                    source: "Deployment_Agent",
                    timestamp: new Date().toISOString(),
                    deploymentName,
                    namespace,
                };
                this.emit(successEvent);
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
exports.RolloutMonitor = RolloutMonitor;
//# sourceMappingURL=monitor.js.map