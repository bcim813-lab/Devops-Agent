/**
 * Unit tests for DeploymentHaltRegistry (src/agents/deployment/haltState.ts)
 *
 * Covers:
 *  - halt() records the deployment pair in the registry
 *  - checkAndThrowIfHalted() throws HaltedError for halted pairs
 *  - checkAndThrowIfHalted() does not throw for non-halted pairs
 *  - resume() clears the halt and allows commands through
 *  - Halted state persists across multiple check attempts (idempotent)
 *  - isHalted() returns correct boolean
 *  - getHaltState() returns the stored halt state
 *  - listHalted() returns all halted deployments
 *  - Multiple pairs tracked independently
 *  - Rejected command is logged with halt reason and timestamp (Req 4.4)
 *  - HaltedError carries deploymentName, namespace, haltedAt, reason
 *
 * Requirements: 4.3, 4.4
 */

import * as os from "os";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import { DeploymentHaltRegistry } from "../../../src/agents/deployment/haltState";
import { HaltedError } from "../../../src/types/models";
import { StructuredLogger } from "../../../src/utils/logger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): StructuredLogger {
  return new StructuredLogger(() => {/* discard */});
}

function tempPath(): string {
  return path.join(os.tmpdir(), `halt-test-${uuidv4()}.json`);
}

function makeRegistry(): DeploymentHaltRegistry {
  return new DeploymentHaltRegistry({
    persistPath: tempPath(),
    logger: silentLogger(),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DeploymentHaltRegistry", () => {

  // ── halt() ────────────────────────────────────────────────────────────────

  describe("halt()", () => {
    it("marks a deployment pair as halted", () => {
      const registry = makeRegistry();
      const ref = { deploymentName: "crm-api", namespace: "production" };

      registry.halt(ref, "rollback dispatch failed");

      expect(registry.isHalted(ref)).toBe(true);
    });

    it("stores the halt reason", () => {
      const registry = makeRegistry();
      const ref = { deploymentName: "crm-api", namespace: "production" };

      registry.halt(ref, "critical failure during rollback");

      const state = registry.getHaltState(ref);
      expect(state?.reason).toBe("critical failure during rollback");
    });

    it("stores the haltedAt timestamp", () => {
      const registry = makeRegistry();
      const ref = { deploymentName: "crm-api", namespace: "production" };
      const haltedAt = "2024-01-15T10:00:00.000Z";

      registry.halt(ref, "test reason", haltedAt);

      const state = registry.getHaltState(ref);
      expect(state?.haltedAt).toBe(haltedAt);
    });

    it("records haltedUntilManualResume: true", () => {
      const registry = makeRegistry();
      const ref = { deploymentName: "svc", namespace: "ns" };

      registry.halt(ref, "reason");

      const state = registry.getHaltState(ref);
      expect(state?.haltedUntilManualResume).toBe(true);
    });
  });

  // ── checkAndThrowIfHalted() ───────────────────────────────────────────────

  describe("checkAndThrowIfHalted() (Req 4.4)", () => {
    it("throws HaltedError for a halted deployment pair", () => {
      const registry = makeRegistry();
      const ref = { deploymentName: "crm-api", namespace: "production" };

      registry.halt(ref, "rollback timeout");

      expect(() => registry.checkAndThrowIfHalted(ref)).toThrow(HaltedError);
    });

    it("does not throw for a deployment pair that is NOT halted", () => {
      const registry = makeRegistry();
      const ref = { deploymentName: "crm-api", namespace: "production" };

      expect(() => registry.checkAndThrowIfHalted(ref)).not.toThrow();
    });

    it("HaltedError carries the correct deploymentName", () => {
      const registry = makeRegistry();
      const ref = { deploymentName: "my-service", namespace: "staging" };

      registry.halt(ref, "halt reason");

      try {
        registry.checkAndThrowIfHalted(ref);
      } catch (err) {
        expect((err as HaltedError).deploymentName).toBe("my-service");
      }
    });

    it("HaltedError carries the correct namespace", () => {
      const registry = makeRegistry();
      const ref = { deploymentName: "my-service", namespace: "staging" };

      registry.halt(ref, "halt reason");

      try {
        registry.checkAndThrowIfHalted(ref);
      } catch (err) {
        expect((err as HaltedError).namespace).toBe("staging");
      }
    });

    it("HaltedError carries the halt reason", () => {
      const registry = makeRegistry();
      const ref = { deploymentName: "crm-api", namespace: "production" };
      const reason = "rollback dispatch failed due to timeout";

      registry.halt(ref, reason);

      try {
        registry.checkAndThrowIfHalted(ref);
      } catch (err) {
        expect((err as HaltedError).reason).toBe(reason);
      }
    });

    it("HaltedError name is 'HaltedError'", () => {
      const registry = makeRegistry();
      const ref = { deploymentName: "crm-api", namespace: "production" };
      registry.halt(ref, "test");

      try {
        registry.checkAndThrowIfHalted(ref);
      } catch (err) {
        expect((err as Error).name).toBe("HaltedError");
      }
    });

    it("still throws after multiple consecutive checks (halt is persistent)", () => {
      const registry = makeRegistry();
      const ref = { deploymentName: "crm-api", namespace: "production" };
      registry.halt(ref, "persistent halt");

      for (let i = 0; i < 5; i++) {
        expect(() => registry.checkAndThrowIfHalted(ref)).toThrow(HaltedError);
      }
    });
  });

  // ── resume() ─────────────────────────────────────────────────────────────

  describe("resume() (Req 4.4)", () => {
    it("clears the halt for a deployment pair", () => {
      const registry = makeRegistry();
      const ref = { deploymentName: "crm-api", namespace: "production" };

      registry.halt(ref, "test");
      registry.resume(ref);

      expect(registry.isHalted(ref)).toBe(false);
    });

    it("allows commands through after resume() (no HaltedError)", () => {
      const registry = makeRegistry();
      const ref = { deploymentName: "crm-api", namespace: "production" };

      registry.halt(ref, "test");
      registry.resume(ref);

      expect(() => registry.checkAndThrowIfHalted(ref)).not.toThrow();
    });

    it("resume() on a non-halted pair is a no-op (does not throw)", () => {
      const registry = makeRegistry();
      const ref = { deploymentName: "crm-api", namespace: "production" };

      expect(() => registry.resume(ref)).not.toThrow();
    });

    it("resume() removes the pair from getHaltState()", () => {
      const registry = makeRegistry();
      const ref = { deploymentName: "crm-api", namespace: "production" };

      registry.halt(ref, "test");
      registry.resume(ref);

      expect(registry.getHaltState(ref)).toBeUndefined();
    });
  });

  // ── Multiple pairs ────────────────────────────────────────────────────────

  describe("multiple pairs tracked independently", () => {
    it("halting one pair does not affect another pair", () => {
      const registry = makeRegistry();
      const ref1 = { deploymentName: "svc-a", namespace: "ns-1" };
      const ref2 = { deploymentName: "svc-b", namespace: "ns-2" };

      registry.halt(ref1, "halt svc-a");

      expect(registry.isHalted(ref1)).toBe(true);
      expect(registry.isHalted(ref2)).toBe(false);
      expect(() => registry.checkAndThrowIfHalted(ref2)).not.toThrow();
    });

    it("same deploymentName in different namespaces are independent", () => {
      const registry = makeRegistry();
      const ref1 = { deploymentName: "crm-api", namespace: "production" };
      const ref2 = { deploymentName: "crm-api", namespace: "staging" };

      registry.halt(ref1, "production halt");

      expect(registry.isHalted(ref1)).toBe(true);
      expect(registry.isHalted(ref2)).toBe(false);
    });

    it("listHalted() returns all halted pairs", () => {
      const registry = makeRegistry();
      const ref1 = { deploymentName: "svc-a", namespace: "ns-1" };
      const ref2 = { deploymentName: "svc-b", namespace: "ns-2" };

      registry.halt(ref1, "halt a");
      registry.halt(ref2, "halt b");

      const halted = registry.listHalted();
      expect(halted).toHaveLength(2);
      expect(halted.map(h => h.deploymentName)).toContain("svc-a");
      expect(halted.map(h => h.deploymentName)).toContain("svc-b");
    });

    it("listHalted() excludes pairs that were resumed", () => {
      const registry = makeRegistry();
      const ref1 = { deploymentName: "svc-a", namespace: "ns-1" };
      const ref2 = { deploymentName: "svc-b", namespace: "ns-2" };

      registry.halt(ref1, "halt a");
      registry.halt(ref2, "halt b");
      registry.resume(ref1);

      const halted = registry.listHalted();
      expect(halted).toHaveLength(1);
      expect(halted[0].deploymentName).toBe("svc-b");
    });
  });

  // ── Audit logging ─────────────────────────────────────────────────────────

  describe("audit logging (Req 4.4)", () => {
    it("logs a warn entry when a halted command is rejected", () => {
      const logEntries: unknown[] = [];
      const testLogger = new StructuredLogger((line) => logEntries.push(JSON.parse(line)));

      const registry = new DeploymentHaltRegistry({
        persistPath: tempPath(),
        logger: testLogger,
      });

      const ref = { deploymentName: "crm-api", namespace: "production" };
      registry.halt(ref, "rollback failed");

      try {
        registry.checkAndThrowIfHalted(ref);
      } catch {
        // expected
      }

      const warnEntries = logEntries.filter((e: any) => e.level === "warn");
      expect(warnEntries.length).toBeGreaterThan(0);
    });

    it("rejected command log includes halt reason", () => {
      const logEntries: unknown[] = [];
      const testLogger = new StructuredLogger((line) => logEntries.push(JSON.parse(line)));

      const registry = new DeploymentHaltRegistry({
        persistPath: tempPath(),
        logger: testLogger,
      });

      const ref = { deploymentName: "crm-api", namespace: "production" };
      registry.halt(ref, "specific failure reason");

      try {
        registry.checkAndThrowIfHalted(ref);
      } catch {
        // expected
      }

      const reasonLog = logEntries.find((e: any) => e.haltReason === "specific failure reason");
      expect(reasonLog).toBeDefined();
    });
  });
});
