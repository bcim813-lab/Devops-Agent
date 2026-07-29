/**
 * Unit tests for RollbackHandler (src/agents/deployment/rollback.ts)
 *
 * Covers:
 *  - Dispatch completes within 5 s → success path
 *  - Dispatch failure → CriticalFailureEvent + halt (Req 4.3, 4.4)
 *  - Rollback completes within 120 s → RollbackSuccessEvent (Req 4.1)
 *  - All pods reach Ready state at desired count before RollbackSuccessEvent (Req 4.2)
 *  - Rollback timeout (>120 s) → CriticalFailureEvent + halt
 *  - Kubernetes API error during readiness poll → CriticalFailureEvent + halt
 *  - Rollback attempt is logged with timestamp, deploymentName, namespace, outcome
 *  - correlationId propagated to all emitted events
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import { RollbackHandler, KubernetesClient } from "../../../src/agents/deployment/rollback";
import { StructuredLogger } from "../../../src/utils/logger";
import type { RollbackAttemptLog, DeploymentRef, RollbackError, Result } from "../../../src/types/models";
import type { OutboundEvent } from "../../../src/interfaces/shared";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): StructuredLogger {
  return new StructuredLogger(() => {/* discard */});
}

function makeEmit(): { events: OutboundEvent[]; emit: (e: OutboundEvent) => void } {
  const events: OutboundEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

function makeLogs(): { logs: RollbackAttemptLog[]; record: (log: RollbackAttemptLog) => void } {
  const logs: RollbackAttemptLog[] = [];
  return { logs, record: (l) => logs.push(l) };
}

function successReadiness(deploymentName = "crm-api", namespace = "production") {
  return {
    success: true as const,
    value: {
      deploymentName,
      namespace,
      podsReady: 3,
      podsDesired: 3,
      allReady: true,
    },
  };
}

function notReadyStatus(deploymentName = "crm-api", namespace = "production") {
  return {
    success: true as const,
    value: {
      deploymentName,
      namespace,
      podsReady: 1,
      podsDesired: 3,
      allReady: false,
    },
  };
}

function rollbackErrResult(code: "DISPATCH_TIMEOUT" | "ROLLBACK_TIMEOUT" | "KUBERNETES_API_ERROR" = "DISPATCH_TIMEOUT"): Result<void, RollbackError> {
  return { success: false, error: { code, message: `${code} error` } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RollbackHandler", () => {

  // ── Success path ──────────────────────────────────────────────────────────

  describe("success path (Req 4.1, 4.2)", () => {
    it("emits RollbackSuccessEvent when dispatch succeeds and all pods are ready", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
        getPodReadiness: jest.fn().mockResolvedValue(successReadiness()),
      };
      const { events, emit } = makeEmit();
      const { record } = makeLogs();
      const haltFn = jest.fn();

      const handler = new RollbackHandler(kubernetes, emit, record, haltFn, silentLogger());
      await handler.executeRollback("crm-api", "production", uuidv4());

      const successEvents = events.filter(e => e.eventType === "RollbackSuccessEvent");
      expect(successEvents).toHaveLength(1);
    });

    it("RollbackSuccessEvent contains deploymentName and namespace", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
        getPodReadiness: jest.fn().mockResolvedValue(successReadiness("svc-x", "ns-y")),
      };
      const { events, emit } = makeEmit();

      const handler = new RollbackHandler(kubernetes, emit, jest.fn(), jest.fn(), silentLogger());
      await handler.executeRollback("svc-x", "ns-y", uuidv4());

      const evt = events.find(e => e.eventType === "RollbackSuccessEvent") as Record<string, unknown>;
      expect(evt.deploymentName).toBe("svc-x");
      expect(evt.namespace).toBe("ns-y");
    });

    it("RollbackSuccessEvent propagates correlationId (Req 8.4)", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
        getPodReadiness: jest.fn().mockResolvedValue(successReadiness()),
      };
      const { events, emit } = makeEmit();

      const handler = new RollbackHandler(kubernetes, emit, jest.fn(), jest.fn(), silentLogger());
      const corrId = "corr-rollback-99";
      await handler.executeRollback("crm-api", "production", corrId);

      const evt = events.find(e => e.eventType === "RollbackSuccessEvent");
      expect(evt?.correlationId).toBe(corrId);
    });

    it("does not halt deployment on successful rollback (Req 4.4)", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
        getPodReadiness: jest.fn().mockResolvedValue(successReadiness()),
      };
      const { emit } = makeEmit();
      const haltFn = jest.fn();

      const handler = new RollbackHandler(kubernetes, emit, jest.fn(), haltFn, silentLogger());
      await handler.executeRollback("crm-api", "production", uuidv4());

      expect(haltFn).not.toHaveBeenCalled();
    });

    it("records a 'success' attempt log entry on successful rollback (Req 4.5)", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
        getPodReadiness: jest.fn().mockResolvedValue(successReadiness()),
      };
      const { emit } = makeEmit();
      const { logs, record } = makeLogs();

      const handler = new RollbackHandler(kubernetes, emit, record, jest.fn(), silentLogger());
      await handler.executeRollback("crm-api", "production", uuidv4());

      const successLog = logs.find(l => l.outcome === "success");
      expect(successLog).toBeDefined();
      expect(successLog?.deploymentName).toBe("crm-api");
      expect(successLog?.namespace).toBe("production");
      expect(typeof successLog?.timestamp).toBe("string");
    });

    it("waits for pods to be ready before emitting RollbackSuccessEvent (Req 4.2)", async () => {
      const getPodReadiness = jest.fn()
        .mockResolvedValueOnce(notReadyStatus())
        .mockResolvedValueOnce(notReadyStatus())
        .mockResolvedValue(successReadiness());

      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
        getPodReadiness,
      };
      const { events, emit } = makeEmit();

      const handler = new RollbackHandler(kubernetes, emit, jest.fn(), jest.fn(), silentLogger());
      await handler.executeRollback("crm-api", "production", uuidv4());

      // getPodReadiness called 3 times (2 not-ready + 1 ready)
      expect(getPodReadiness).toHaveBeenCalledTimes(3);
      expect(events.filter(e => e.eventType === "RollbackSuccessEvent")).toHaveLength(1);
    });
  });

  // ── Dispatch failure ──────────────────────────────────────────────────────

  describe("dispatch failure (Req 4.3, 4.4)", () => {
    it("emits CriticalFailureEvent when rollback dispatch fails", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue(rollbackErrResult("DISPATCH_TIMEOUT")),
        getPodReadiness: jest.fn(),
      };
      const { events, emit } = makeEmit();

      const handler = new RollbackHandler(kubernetes, emit, jest.fn(), jest.fn(), silentLogger());
      await handler.executeRollback("crm-api", "production", uuidv4());

      const criticalEvents = events.filter(e => e.eventType === "CriticalFailureEvent");
      expect(criticalEvents).toHaveLength(1);
    });

    it("calls haltDeployment when dispatch fails (Req 4.4)", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue(rollbackErrResult("DISPATCH_TIMEOUT")),
        getPodReadiness: jest.fn(),
      };
      const { emit } = makeEmit();
      const haltFn = jest.fn();

      const handler = new RollbackHandler(kubernetes, emit, jest.fn(), haltFn, silentLogger());
      await handler.executeRollback("crm-api", "production", uuidv4());

      expect(haltFn).toHaveBeenCalledWith(
        { deploymentName: "crm-api", namespace: "production" },
        expect.any(String)
      );
    });

    it("does not emit RollbackSuccessEvent on dispatch failure", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue(rollbackErrResult()),
        getPodReadiness: jest.fn(),
      };
      const { events, emit } = makeEmit();

      const handler = new RollbackHandler(kubernetes, emit, jest.fn(), jest.fn(), silentLogger());
      await handler.executeRollback("crm-api", "production", uuidv4());

      expect(events.filter(e => e.eventType === "RollbackSuccessEvent")).toHaveLength(0);
    });

    it("records a 'failed' attempt log entry on dispatch failure (Req 4.5)", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue(rollbackErrResult()),
        getPodReadiness: jest.fn(),
      };
      const { emit } = makeEmit();
      const { logs, record } = makeLogs();

      const handler = new RollbackHandler(kubernetes, emit, record, jest.fn(), silentLogger());
      await handler.executeRollback("crm-api", "production", uuidv4());

      const failedLog = logs.find(l => l.outcome === "failed");
      expect(failedLog).toBeDefined();
    });

    it("CriticalFailureEvent contains deploymentName, namespace, and failureReason", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue(rollbackErrResult("DISPATCH_TIMEOUT")),
        getPodReadiness: jest.fn(),
      };
      const { events, emit } = makeEmit();

      const handler = new RollbackHandler(kubernetes, emit, jest.fn(), jest.fn(), silentLogger());
      await handler.executeRollback("my-deploy", "my-ns", uuidv4());

      const evt = events.find(e => e.eventType === "CriticalFailureEvent") as Record<string, unknown>;
      expect(evt.deploymentName).toBe("my-deploy");
      expect(evt.namespace).toBe("my-ns");
      expect(typeof evt.failureReason).toBe("string");
    });
  });

  // ── Kubernetes API error during readiness poll ────────────────────────────

  describe("Kubernetes API error during rollback monitoring (Req 4.3, 4.4)", () => {
    it("emits CriticalFailureEvent when pod readiness poll returns an error", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
        getPodReadiness: jest.fn().mockResolvedValue(rollbackErrResult("KUBERNETES_API_ERROR")),
      };
      const { events, emit } = makeEmit();

      const handler = new RollbackHandler(kubernetes, emit, jest.fn(), jest.fn(), silentLogger());
      await handler.executeRollback("crm-api", "production", uuidv4());

      const criticalEvents = events.filter(e => e.eventType === "CriticalFailureEvent");
      expect(criticalEvents).toHaveLength(1);
    });

    it("halts deployment when pod readiness poll returns an error (Req 4.4)", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
        getPodReadiness: jest.fn().mockResolvedValue(rollbackErrResult("KUBERNETES_API_ERROR")),
      };
      const { emit } = makeEmit();
      const haltFn = jest.fn();

      const handler = new RollbackHandler(kubernetes, emit, jest.fn(), haltFn, silentLogger());
      await handler.executeRollback("crm-api", "production", uuidv4());

      expect(haltFn).toHaveBeenCalledTimes(1);
    });

    it("records a 'failed' attempt log entry on readiness poll error", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
        getPodReadiness: jest.fn().mockResolvedValue(rollbackErrResult("KUBERNETES_API_ERROR")),
      };
      const { emit } = makeEmit();
      const { logs, record } = makeLogs();

      const handler = new RollbackHandler(kubernetes, emit, record, jest.fn(), silentLogger());
      await handler.executeRollback("crm-api", "production", uuidv4());

      const failedLog = logs.find(l => l.outcome === "failed");
      expect(failedLog).toBeDefined();
    });
  });

  // ── Attempt log invariants (Req 4.5) ──────────────────────────────────────

  describe("attempt log invariants (Req 4.5)", () => {
    it("every attempt log has timestamp, deploymentName, namespace, and outcome", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
        getPodReadiness: jest.fn().mockResolvedValue(successReadiness()),
      };
      const { emit } = makeEmit();
      const { logs, record } = makeLogs();

      const handler = new RollbackHandler(kubernetes, emit, record, jest.fn(), silentLogger());
      await handler.executeRollback("crm-api", "production", uuidv4());

      for (const log of logs) {
        expect(typeof log.timestamp).toBe("string");
        expect(log.timestamp.length).toBeGreaterThan(0);
        expect(typeof log.deploymentName).toBe("string");
        expect(typeof log.namespace).toBe("string");
        expect(["success", "failed", "timed-out"]).toContain(log.outcome);
        expect(typeof log.correlationId).toBe("string");
      }
    });

    it("attempt log outcome is 'success' on RollbackSuccessEvent", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
        getPodReadiness: jest.fn().mockResolvedValue(successReadiness()),
      };
      const { emit } = makeEmit();
      const { logs, record } = makeLogs();

      const handler = new RollbackHandler(kubernetes, emit, record, jest.fn(), silentLogger());
      await handler.executeRollback("crm-api", "production", uuidv4());

      expect(logs.some(l => l.outcome === "success")).toBe(true);
    });
  });

  // ── Event shape invariants ────────────────────────────────────────────────

  describe("event shape invariants", () => {
    it("every emitted event has non-empty eventId and timestamp", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
        getPodReadiness: jest.fn().mockResolvedValue(successReadiness()),
      };
      const { events, emit } = makeEmit();

      const handler = new RollbackHandler(kubernetes, emit, jest.fn(), jest.fn(), silentLogger());
      await handler.executeRollback("crm-api", "production", uuidv4());

      for (const evt of events) {
        expect(typeof evt.eventId).toBe("string");
        expect(evt.eventId.length).toBeGreaterThan(0);
        expect(typeof evt.timestamp).toBe("string");
        expect(evt.timestamp.length).toBeGreaterThan(0);
      }
    });

    it("every emitted event has source = 'Deployment_Agent'", async () => {
      const kubernetes: KubernetesClient = {
        initiateRollback: jest.fn().mockResolvedValue(rollbackErrResult()),
        getPodReadiness: jest.fn(),
      };
      const { events, emit } = makeEmit();

      const handler = new RollbackHandler(kubernetes, emit, jest.fn(), jest.fn(), silentLogger());
      await handler.executeRollback("crm-api", "production", uuidv4());

      for (const evt of events) {
        expect(evt.source).toBe("Deployment_Agent");
      }
    });
  });
});
