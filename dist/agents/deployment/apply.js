"use strict";
/**
 * Deployment_Agent — manifest application logic.
 *
 * Applies Kubernetes manifests to a cluster when a PipelineCompletedEvent
 * indicates a successful build and a manifest path is configured.
 *
 * Requirements: 3.1, 3.7
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ManifestApplier = void 0;
const logger_1 = require("../../utils/logger");
const uuid_1 = require("uuid");
class ManifestApplier {
    constructor(kubernetes, emit, logger) {
        this.kubernetes = kubernetes;
        this.emit = emit;
        this.logger = logger ?? new logger_1.StructuredLogger();
    }
    async applyManifest(command) {
        const { manifestFilePath, namespace, deploymentName, pipelineRunId, correlationId, } = command;
        // Requirement 3.1: Only proceed when manifestFilePath is explicitly set
        if (!manifestFilePath) {
            this.logger.debug({
                action: "applyManifest",
                outcome: "skipped",
                reason: "manifestFilePath not configured",
                params: { deploymentName, namespace, pipelineRunId },
                correlationId,
            });
            return { success: true, value: undefined };
        }
        this.logger.info({
            action: "applyManifest",
            outcome: "pending",
            params: { deploymentName, namespace, manifestFilePath },
            correlationId,
        });
        const result = await this.kubernetes.applyManifest(manifestFilePath, namespace);
        if (!result.success) {
            const failureEvent = {
                eventId: (0, uuid_1.v4)(),
                correlationId,
                eventType: "DeploymentFailureEvent",
                source: "Deployment_Agent",
                timestamp: new Date().toISOString(),
                deploymentName,
                namespace,
                manifestFilePath,
                kubernetesErrorMessage: result.error.message,
            };
            this.emit(failureEvent);
            this.logger.error({
                action: "applyManifest",
                outcome: "failure",
                params: { deploymentName, namespace, manifestFilePath },
                correlationId,
                errorMessage: result.error.message,
            });
            return result;
        }
        this.logger.info({
            action: "applyManifest",
            outcome: "success",
            params: { deploymentName, namespace, manifestFilePath },
            correlationId,
        });
        return { success: true, value: undefined };
    }
}
exports.ManifestApplier = ManifestApplier;
//# sourceMappingURL=apply.js.map