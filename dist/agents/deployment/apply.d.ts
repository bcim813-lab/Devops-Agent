/**
 * Deployment_Agent — manifest application logic.
 *
 * Applies Kubernetes manifests to a cluster when a PipelineCompletedEvent
 * indicates a successful build and a manifest path is configured.
 *
 * Requirements: 3.1, 3.7
 */
import { StructuredLogger } from "../../utils/logger";
import type { DeploymentCommand, DeployError, Result } from "../../types/models";
import type { OutboundEvent } from "../../interfaces/shared";
export interface KubernetesClient {
    applyManifest(manifestPath: string, namespace: string): Promise<Result<void, DeployError>>;
}
export type EmitFn = (event: OutboundEvent) => void;
export declare class ManifestApplier {
    private readonly kubernetes;
    private readonly emit;
    private readonly logger;
    constructor(kubernetes: KubernetesClient, emit: EmitFn, logger?: StructuredLogger);
    applyManifest(command: DeploymentCommand): Promise<Result<void, DeployError>>;
}
//# sourceMappingURL=apply.d.ts.map