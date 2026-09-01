/**
 * Deployment_Agent — manifest application logic.
 *
 * Applies Kubernetes manifests to a cluster when a PipelineCompletedEvent
 * indicates a successful build and a manifest path is configured.
 *
 * Requirements: 3.1, 3.7
 */

import { StructuredLogger } from "../../utils/logger";
import type {
  DeploymentCommand,
  DeploymentFailureEvent,
  DeployError,
  Result,
} from "../../types/models";
import type { OutboundEvent } from "../../interfaces/shared";
import { v4 as uuidv4 } from "uuid";

export interface KubernetesClient {
  applyManifest(
    manifestPath: string,
    namespace: string
  ): Promise<Result<void, DeployError>>;
}

export type EmitFn = (event: OutboundEvent) => void;

export class ManifestApplier {
  private readonly kubernetes: KubernetesClient;
  private readonly emit: EmitFn;
  private readonly logger: StructuredLogger;

  constructor(
    kubernetes: KubernetesClient,
    emit: EmitFn,
    logger?: StructuredLogger
  ) {
    this.kubernetes = kubernetes;
    this.emit = emit;
    this.logger = logger ?? new StructuredLogger();
  }

  async applyManifest(
    command: DeploymentCommand
  ): Promise<Result<void, DeployError>> {
    const {
      manifestFilePath,
      namespace,
      deploymentName,
      pipelineRunId,
      correlationId,
    } = command;

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

    const result = await this.kubernetes.applyManifest(
      manifestFilePath,
      namespace
    );

    if (!result.success) {
      const failureEvent: DeploymentFailureEvent = {
        eventId: uuidv4(),
        correlationId,
        eventType: "DeploymentFailureEvent",
        source: "Deployment_Agent",
        timestamp: new Date().toISOString(),
        deploymentName,
        namespace,
        manifestFilePath,
        kubernetesErrorMessage: result.error.message,
      };

      this.emit(failureEvent as unknown as OutboundEvent);

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
