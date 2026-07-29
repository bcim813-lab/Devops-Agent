/**
 * Unit tests for ManifestApplier (src/agents/deployment/apply.ts)
 *
 * Covers:
 *  - Success path: applies manifest, returns Ok(void), no events emitted
 *  - Missing manifest path: skips entirely, no Kubernetes call, no events
 *  - Kubernetes API error: emits DeploymentFailureEvent, does NOT trigger rollback
 *  - DeploymentFailureEvent fields: deploymentName, namespace, manifestFilePath, errorMessage
 *  - correlationId propagated to emitted events
 *
 * Requirements: 3.1, 3.7
 */

import { ManifestApplier, KubernetesClient } from "../../../src/agents/deployment/apply";
import { StructuredLogger } from "../../../src/utils/logger";
import type { DeploymentCommand, DeployError, Result } from "../../../src/types/models";
import type { OutboundEvent } from "../../../src/interfaces/shared";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): StructuredLogger {
  return new StructuredLogger(() => {/* discard */});
}

function makeCmd(overrides: Partial<DeploymentCommand> = {}): DeploymentCommand {
  return {
    eventId: uuidv4(),
    correlationId: "corr-deploy-001",
    eventType: "DeploymentCommand",
    source: "Orchestrator",
    timestamp: new Date().toISOString(),
    manifestFilePath: "/manifests/crm-api.yaml",
    namespace: "production",
    deploymentName: "crm-api",
    pipelineRunId: "run-001",
    ...overrides,
  };
}

function makeEmit(): { events: OutboundEvent[]; emit: (e: OutboundEvent) => void } {
  const events: OutboundEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

function okResult(): Result<void, DeployError> {
  return { success: true, value: undefined };
}

function errResult(message = "Kubernetes API error"): Result<void, DeployError> {
  return { success: false, error: { code: "KUBERNETES_API_ERROR", message } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ManifestApplier", () => {

  // ── Success path ──────────────────────────────────────────────────────────

  describe("success path", () => {
    it("returns Ok(void) when Kubernetes accepts the manifest", async () => {
      const kubernetes: KubernetesClient = {
        applyManifest: jest.fn().mockResolvedValue(okResult()),
      };
      const { emit } = makeEmit();
      const applier = new ManifestApplier(kubernetes, emit, silentLogger());

      const result = await applier.applyManifest(makeCmd());

      expect(result.success).toBe(true);
    });

    it("calls Kubernetes with the correct manifest path and namespace", async () => {
      const applyManifest = jest.fn().mockResolvedValue(okResult());
      const kubernetes: KubernetesClient = { applyManifest };
      const { emit } = makeEmit();
      const applier = new ManifestApplier(kubernetes, emit, silentLogger());

      await applier.applyManifest(makeCmd({
        manifestFilePath: "/manifests/app.yaml",
        namespace: "staging",
      }));

      expect(applyManifest).toHaveBeenCalledWith("/manifests/app.yaml", "staging");
    });

    it("emits no events on success (Req 3.7: no rollback on success)", async () => {
      const kubernetes: KubernetesClient = {
        applyManifest: jest.fn().mockResolvedValue(okResult()),
      };
      const { events, emit } = makeEmit();
      const applier = new ManifestApplier(kubernetes, emit, silentLogger());

      await applier.applyManifest(makeCmd());

      expect(events).toHaveLength(0);
    });
  });

  // ── Missing manifest path ─────────────────────────────────────────────────

  describe("missing manifestFilePath (Req 3.1)", () => {
    it("returns Ok(void) without calling Kubernetes when manifestFilePath is empty", async () => {
      const applyManifest = jest.fn();
      const kubernetes: KubernetesClient = { applyManifest };
      const { emit } = makeEmit();
      const applier = new ManifestApplier(kubernetes, emit, silentLogger());

      const result = await applier.applyManifest(makeCmd({ manifestFilePath: "" }));

      expect(result.success).toBe(true);
      expect(applyManifest).not.toHaveBeenCalled();
    });

    it("emits no events when manifestFilePath is empty", async () => {
      const kubernetes: KubernetesClient = {
        applyManifest: jest.fn(),
      };
      const { events, emit } = makeEmit();
      const applier = new ManifestApplier(kubernetes, emit, silentLogger());

      await applier.applyManifest(makeCmd({ manifestFilePath: "" }));

      expect(events).toHaveLength(0);
    });

    it("does not call Kubernetes when manifestFilePath is undefined-like (null cast to empty)", async () => {
      const applyManifest = jest.fn();
      const kubernetes: KubernetesClient = { applyManifest };
      const { emit } = makeEmit();
      const applier = new ManifestApplier(kubernetes, emit, silentLogger());

      // Cast null to string to simulate misconfigured command
      await applier.applyManifest(makeCmd({ manifestFilePath: null as unknown as string }));

      expect(applyManifest).not.toHaveBeenCalled();
    });
  });

  // ── Kubernetes API error (Req 3.7) ────────────────────────────────────────

  describe("Kubernetes API error — no rollback (Req 3.7)", () => {
    it("returns Err when Kubernetes rejects the manifest", async () => {
      const kubernetes: KubernetesClient = {
        applyManifest: jest.fn().mockResolvedValue(errResult("Manifest validation failed")),
      };
      const { emit } = makeEmit();
      const applier = new ManifestApplier(kubernetes, emit, silentLogger());

      const result = await applier.applyManifest(makeCmd());

      expect(result.success).toBe(false);
    });

    it("emits exactly one DeploymentFailureEvent on Kubernetes error", async () => {
      const kubernetes: KubernetesClient = {
        applyManifest: jest.fn().mockResolvedValue(errResult("CrashLoopBackOff")),
      };
      const { events, emit } = makeEmit();
      const applier = new ManifestApplier(kubernetes, emit, silentLogger());

      await applier.applyManifest(makeCmd());

      expect(events).toHaveLength(1);
      expect(events[0].eventType).toBe("DeploymentFailureEvent");
    });

    it("DeploymentFailureEvent contains deploymentName, namespace, manifestFilePath, errorMessage", async () => {
      const kubernetes: KubernetesClient = {
        applyManifest: jest.fn().mockResolvedValue(errResult("ImagePullBackOff")),
      };
      const { events, emit } = makeEmit();
      const applier = new ManifestApplier(kubernetes, emit, silentLogger());

      await applier.applyManifest(makeCmd({
        deploymentName: "crm-web",
        namespace: "staging",
        manifestFilePath: "/k8s/crm-web.yaml",
      }));

      const evt = events[0] as Record<string, unknown>;
      expect(evt.deploymentName).toBe("crm-web");
      expect(evt.namespace).toBe("staging");
      expect(evt.manifestFilePath).toBe("/k8s/crm-web.yaml");
      expect(typeof evt.kubernetesErrorMessage).toBe("string");
      expect((evt.kubernetesErrorMessage as string).length).toBeGreaterThan(0);
    });

    it("DeploymentFailureEvent carries the kubernetesErrorMessage from the API response", async () => {
      const errorMsg = "quota exceeded for namespace staging";
      const kubernetes: KubernetesClient = {
        applyManifest: jest.fn().mockResolvedValue(errResult(errorMsg)),
      };
      const { events, emit } = makeEmit();
      const applier = new ManifestApplier(kubernetes, emit, silentLogger());

      await applier.applyManifest(makeCmd());

      const evt = events[0] as Record<string, unknown>;
      expect(evt.kubernetesErrorMessage).toBe(errorMsg);
    });

    it("DeploymentFailureEvent propagates correlationId (Req 8.4)", async () => {
      const kubernetes: KubernetesClient = {
        applyManifest: jest.fn().mockResolvedValue(errResult()),
      };
      const { events, emit } = makeEmit();
      const applier = new ManifestApplier(kubernetes, emit, silentLogger());

      await applier.applyManifest(makeCmd({ correlationId: "my-corr-42" }));

      expect(events[0].correlationId).toBe("my-corr-42");
    });

    it("does NOT emit RollbackEvent on Kubernetes API error (Req 3.7)", async () => {
      const kubernetes: KubernetesClient = {
        applyManifest: jest.fn().mockResolvedValue(errResult("API unreachable")),
      };
      const { events, emit } = makeEmit();
      const applier = new ManifestApplier(kubernetes, emit, silentLogger());

      await applier.applyManifest(makeCmd());

      const rollbackEvents = events.filter(e => e.eventType === "RollbackEvent");
      expect(rollbackEvents).toHaveLength(0);
    });

    it("does NOT emit RollbackSuccessEvent on Kubernetes API error", async () => {
      const kubernetes: KubernetesClient = {
        applyManifest: jest.fn().mockResolvedValue(errResult("503 Service Unavailable")),
      };
      const { events, emit } = makeEmit();
      const applier = new ManifestApplier(kubernetes, emit, silentLogger());

      await applier.applyManifest(makeCmd());

      const rollbackSuccessEvents = events.filter(e => e.eventType === "RollbackSuccessEvent");
      expect(rollbackSuccessEvents).toHaveLength(0);
    });

    it("DeploymentFailureEvent has source = 'Deployment_Agent'", async () => {
      const kubernetes: KubernetesClient = {
        applyManifest: jest.fn().mockResolvedValue(errResult()),
      };
      const { events, emit } = makeEmit();
      const applier = new ManifestApplier(kubernetes, emit, silentLogger());

      await applier.applyManifest(makeCmd());

      expect(events[0].source).toBe("Deployment_Agent");
    });
  });
});
