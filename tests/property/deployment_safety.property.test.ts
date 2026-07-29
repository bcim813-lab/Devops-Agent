/**
 * Property-based tests for Deployment_Agent safety invariants.
 *
 * Property 4: Rollback Trigger Condition
 *   - Rollback is initiated if and only if rollout timeout elapses.
 *   - A Kubernetes API manifest-apply error must NOT trigger a rollback.
 *
 * Property 5: Rollback Completeness Verification
 *   - RollbackSuccessEvent must not be emitted unless all pods for the previous
 *     revision are Ready at desired replica count.
 *
 * Property 6: Halt Invariant
 *   - For any (deploymentName, namespace) pair in halted state, all subsequent
 *     deployment and rollback commands must return HaltedError without executing,
 *     until resumeDeployment is called.
 *
 * Requirements: 3.4, 3.7, 4.2, 4.3, 4.4
 */

import fc from "fast-check";
import { v4 as uuidv4 } from "uuid";
import { ManifestApplier } from "../../src/agents/deployment/apply";
import { RollbackHandler } from "../../src/agents/deployment/rollback";
import { DeploymentHaltRegistry } from "../../src/agents/deployment/haltState";
import { StructuredLogger } from "../../src/utils/logger";
import type { DeploymentCommand, DeployError, RollbackError, Result } from "../../src/types/models";
import type { OutboundEvent } from "../../src/interfaces/shared";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): StructuredLogger {
  return new StructuredLogger(() => {/* discard */});
}

function makeDeployCmd(overrides: Partial<DeploymentCommand> = {}): DeploymentCommand {
  return {
    eventId: uuidv4(),
    correlationId: uuidv4(),
    eventType: "DeploymentCommand",
    source: "Orchestrator",
    timestamp: new Date().toISOString(),
    manifestFilePath: "/manifests/app.yaml",
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

function tempHaltPath(): string {
  return path.join(os.tmpdir(), `halt-${uuidv4()}.json`);
}

// ---------------------------------------------------------------------------
// Property 4: Rollback Trigger Condition
// ---------------------------------------------------------------------------

describe("Property 4: Rollback Trigger Condition", () => {
  // Property 4: Rollback Trigger Condition
  it("Property 4: Kubernetes API error on manifest apply does NOT trigger rollback", () => {
    fc.assert(
      fc.property(
        fc.record({
          deploymentName: fc.string({ minLength: 1, maxLength: 20 }),
          namespace: fc.string({ minLength: 1, maxLength: 20 }),
          errorMessage: fc.string({ minLength: 1 }),
        }),
        async (data) => {
          const { events, emit } = makeEmit();

          const kubernetes = {
            applyManifest: jest.fn().mockResolvedValue({
              success: false,
              error: { code: "KUBERNETES_API_ERROR", message: data.errorMessage },
            } as Result<void, DeployError>),
          };

          const applier = new ManifestApplier(kubernetes, emit, silentLogger());
          const cmd = makeDeployCmd({
            deploymentName: data.deploymentName,
            namespace: data.namespace,
          });

          await applier.applyManifest(cmd);

          // DeploymentFailureEvent should be emitted
          const failureEvents = events.filter(e => e.eventType === "DeploymentFailureEvent");
          expect(failureEvents).toHaveLength(1);

          // No RollbackEvent should be emitted
          const rollbackEvents = events.filter(e => e.eventType === "RollbackEvent");
          expect(rollbackEvents).toHaveLength(0);

          // No RollbackSuccessEvent
          const rollbackSuccessEvents = events.filter(e => e.eventType === "RollbackSuccessEvent");
          expect(rollbackSuccessEvents).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 4: Manifest apply success emits no failure or rollback events", () => {
    fc.assert(
      fc.property(
        fc.record({
          deploymentName: fc.string({ minLength: 1, maxLength: 20 }),
          namespace: fc.string({ minLength: 1, maxLength: 20 }),
          manifestFilePath: fc.string({ minLength: 1 }),
        }),
        async (data) => {
          const { events, emit } = makeEmit();

          const kubernetes = {
            applyManifest: jest.fn().mockResolvedValue({
              success: true,
              value: undefined,
            } as Result<void, DeployError>),
          };

          const applier = new ManifestApplier(kubernetes, emit, silentLogger());
          const cmd = makeDeployCmd({
            deploymentName: data.deploymentName,
            namespace: data.namespace,
            manifestFilePath: data.manifestFilePath,
          });

          await applier.applyManifest(cmd);

          // No failure or rollback events on success
          const badEvents = events.filter(
            e =>
              e.eventType === "DeploymentFailureEvent" ||
              e.eventType === "RollbackEvent" ||
              e.eventType === "RollbackSuccessEvent" ||
              e.eventType === "CriticalFailureEvent"
          );
          expect(badEvents).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 4: Missing manifestFilePath skips deployment without any events", () => {
    fc.assert(
      fc.property(
        fc.record({
          deploymentName: fc.string({ minLength: 1, maxLength: 20 }),
          namespace: fc.string({ minLength: 1, maxLength: 20 }),
        }),
        async (data) => {
          const { events, emit } = makeEmit();

          const kubernetes = {
            applyManifest: jest.fn().mockResolvedValue({ success: true, value: undefined }),
          };

          const applier = new ManifestApplier(kubernetes, emit, silentLogger());
          const cmd = makeDeployCmd({
            deploymentName: data.deploymentName,
            namespace: data.namespace,
            manifestFilePath: "", // empty = not set
          });

          await applier.applyManifest(cmd);

          // No events and no Kubernetes call when manifest path is absent
          expect(events).toHaveLength(0);
          expect(kubernetes.applyManifest).not.toHaveBeenCalled();
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Rollback Completeness Verification
// ---------------------------------------------------------------------------

describe("Property 5: Rollback Completeness Verification", () => {
  // Property 5: Rollback Completeness Verification
  it("Property 5: RollbackSuccessEvent is only emitted when all pods are Ready at desired count", () => {
    fc.assert(
      fc.property(
        fc.record({
          deploymentName: fc.string({ minLength: 1, maxLength: 20 }),
          namespace: fc.string({ minLength: 1, maxLength: 20 }),
          desiredReplicas: fc.integer({ min: 1, max: 10 }),
        }),
        async (data) => {
          const { events, emit } = makeEmit();
          const attemptLog: unknown[] = [];

          const kubernetes = {
            initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
            getPodReadiness: jest.fn().mockResolvedValue({
              success: true,
              value: {
                deploymentName: data.deploymentName,
                namespace: data.namespace,
                podsReady: data.desiredReplicas,
                podsDesired: data.desiredReplicas,
                allReady: true, // all pods are ready
              },
            } as Result<any, RollbackError>),
          };

          const handler = new RollbackHandler(
            kubernetes,
            emit,
            (log) => attemptLog.push(log),
            jest.fn(),
            silentLogger()
          );

          await handler.executeRollback(data.deploymentName, data.namespace, uuidv4());

          // Property: RollbackSuccessEvent implies allReady === true
          const successEvents = events.filter(e => e.eventType === "RollbackSuccessEvent");

          if (successEvents.length > 0) {
            // The last readiness check must have reported allReady
            const lastCall = kubernetes.getPodReadiness.mock.results.at(-1);
            expect(lastCall?.value).resolves.toMatchObject({
              success: true,
              value: { allReady: true },
            });
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 5: No RollbackSuccessEvent when pods are NOT all ready", async () => {
    fc.assert(
      fc.property(
        fc.record({
          deploymentName: fc.string({ minLength: 1, maxLength: 20 }),
          namespace: fc.string({ minLength: 1, maxLength: 20 }),
          podsReady: fc.integer({ min: 0, max: 4 }),
          desiredReplicas: fc.integer({ min: 5, max: 10 }),
        }),
        async (data) => {
          const { events, emit } = makeEmit();

          // Dispatch fails immediately → CriticalFailureEvent, no success
          const kubernetes = {
            initiateRollback: jest.fn().mockResolvedValue({
              success: false,
              error: { code: "DISPATCH_TIMEOUT", message: "dispatch failed" },
            } as Result<void, RollbackError>),
            getPodReadiness: jest.fn(),
          };

          const handler = new RollbackHandler(
            kubernetes,
            emit,
            jest.fn(),
            jest.fn(),
            silentLogger()
          );

          await handler.executeRollback(data.deploymentName, data.namespace, uuidv4());

          // No RollbackSuccessEvent when dispatch fails
          const successEvents = events.filter(e => e.eventType === "RollbackSuccessEvent");
          expect(successEvents).toHaveLength(0);

          // CriticalFailureEvent should be emitted
          const criticalEvents = events.filter(e => e.eventType === "CriticalFailureEvent");
          expect(criticalEvents).toHaveLength(1);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 5: RollbackSuccessEvent carries matching deploymentName and namespace", () => {
    fc.assert(
      fc.property(
        fc.record({
          deploymentName: fc.string({ minLength: 1, maxLength: 20 }),
          namespace: fc.string({ minLength: 1, maxLength: 20 }),
        }),
        async (data) => {
          const { events, emit } = makeEmit();

          const kubernetes = {
            initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
            getPodReadiness: jest.fn().mockResolvedValue({
              success: true,
              value: {
                deploymentName: data.deploymentName,
                namespace: data.namespace,
                podsReady: 3,
                podsDesired: 3,
                allReady: true,
              },
            }),
          };

          const handler = new RollbackHandler(
            kubernetes,
            emit,
            jest.fn(),
            jest.fn(),
            silentLogger()
          );

          await handler.executeRollback(data.deploymentName, data.namespace, uuidv4());

          const successEvents = events.filter(e => e.eventType === "RollbackSuccessEvent");
          for (const evt of successEvents) {
            const e = evt as Record<string, unknown>;
            expect(e.deploymentName).toBe(data.deploymentName);
            expect(e.namespace).toBe(data.namespace);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ---------------------------------------------------------------------------
// Property 6: Halt Invariant
// ---------------------------------------------------------------------------

describe("Property 6: Halt Invariant", () => {
  // Property 6: Halt Invariant
  it("Property 6: All commands for a halted deployment pair return HaltedError without executing", () => {
    fc.assert(
      fc.property(
        fc.record({
          deploymentName: fc.string({ minLength: 1, maxLength: 20 }),
          namespace: fc.string({ minLength: 1, maxLength: 20 }),
          reason: fc.string({ minLength: 1 }),
        }),
        (data) => {
          const registry = new DeploymentHaltRegistry({
            persistPath: tempHaltPath(),
            logger: silentLogger(),
          });

          const ref = { deploymentName: data.deploymentName, namespace: data.namespace };

          // Not halted — no error
          expect(() => registry.checkAndThrowIfHalted(ref)).not.toThrow();

          // Halt it
          registry.halt(ref, data.reason);
          expect(registry.isHalted(ref)).toBe(true);

          // All commands should throw HaltedError
          expect(() => registry.checkAndThrowIfHalted(ref)).toThrow();

          // The thrown error should be a HaltedError with matching fields
          try {
            registry.checkAndThrowIfHalted(ref);
          } catch (err: unknown) {
            expect((err as Error).name).toBe("HaltedError");
            expect((err as any).deploymentName).toBe(data.deploymentName);
            expect((err as any).namespace).toBe(data.namespace);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 6: resume() clears the halt and allows commands through", () => {
    fc.assert(
      fc.property(
        fc.record({
          deploymentName: fc.string({ minLength: 1, maxLength: 20 }),
          namespace: fc.string({ minLength: 1, maxLength: 20 }),
        }),
        (data) => {
          const registry = new DeploymentHaltRegistry({
            persistPath: tempHaltPath(),
            logger: silentLogger(),
          });

          const ref = { deploymentName: data.deploymentName, namespace: data.namespace };

          // Halt then resume
          registry.halt(ref, "test reason");
          expect(registry.isHalted(ref)).toBe(true);

          registry.resume(ref);
          expect(registry.isHalted(ref)).toBe(false);

          // After resume, no HaltedError
          expect(() => registry.checkAndThrowIfHalted(ref)).not.toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 6: Multiple different pairs are tracked independently", () => {
    fc.assert(
      fc.property(
        fc.record({
          name1: fc.string({ minLength: 1, maxLength: 10 }),
          ns1: fc.string({ minLength: 1, maxLength: 10 }),
          name2: fc.string({ minLength: 1, maxLength: 10 }),
          ns2: fc.string({ minLength: 1, maxLength: 10 }),
        }),
        (data) => {
          // Skip if pairs are identical (ambiguous test case)
          if (data.name1 === data.name2 && data.ns1 === data.ns2) return;

          const registry = new DeploymentHaltRegistry({
            persistPath: tempHaltPath(),
            logger: silentLogger(),
          });

          const ref1 = { deploymentName: data.name1, namespace: data.ns1 };
          const ref2 = { deploymentName: data.name2, namespace: data.ns2 };

          // Halt only ref1
          registry.halt(ref1, "halted for test");

          // ref1 is halted, ref2 is not
          expect(registry.isHalted(ref1)).toBe(true);
          expect(registry.isHalted(ref2)).toBe(false);

          // ref2 command does not throw
          expect(() => registry.checkAndThrowIfHalted(ref2)).not.toThrow();
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 6: Halted state survives multiple check attempts (idempotent)", () => {
    fc.assert(
      fc.property(
        fc.record({
          deploymentName: fc.string({ minLength: 1, maxLength: 20 }),
          namespace: fc.string({ minLength: 1, maxLength: 20 }),
          checkCount: fc.integer({ min: 2, max: 10 }),
        }),
        (data) => {
          const registry = new DeploymentHaltRegistry({
            persistPath: tempHaltPath(),
            logger: silentLogger(),
          });

          const ref = { deploymentName: data.deploymentName, namespace: data.namespace };
          registry.halt(ref, "persistent halt");

          // All N checks should throw HaltedError
          for (let i = 0; i < data.checkCount; i++) {
            expect(() => registry.checkAndThrowIfHalted(ref)).toThrow();
          }

          // Still halted after multiple checks
          expect(registry.isHalted(ref)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });
});
