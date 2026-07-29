/**
 * Unit tests for IncidentHandler — escalation paths
 * (src/agents/incident/execution.ts)
 *
 * Covers:
 *  - Escalation includes on-call @mention when handle is resolvable (Req 6.7)
 *  - Escalation posts without mention and uses null handle when unresolvable
 *  - IncidentEscalationEvent contains correct fields
 *  - RunbookLibrary register/getLatest/listVersions (Req 5.5)
 *  - getLatest() returns the highest semver for a service
 *  - list() returns all registered service names
 *
 * Requirements: 5.4, 5.5, 5.6, 6.7
 */

import { IncidentHandler } from "../../../src/agents/incident/execution";
import { RunbookLibrary } from "../../../src/agents/incident/runbookLibrary";
import { StructuredLogger } from "../../../src/utils/logger";
import type { PagerDutyAlert, Runbook } from "../../../src/types/models";
import type { OutboundEvent } from "../../../src/interfaces/shared";

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

function makeAlert(overrides: Partial<PagerDutyAlert> = {}): PagerDutyAlert {
  return {
    incidentId: "inc-esc-001",
    serviceName: "crm-api",
    severity: "P1",
    receivedAt: new Date().toISOString(),
    details: {},
    ...overrides,
  };
}

function makeRunbook(serviceName = "crm-api", version = "1.0.0"): Runbook {
  return {
    serviceName,
    version,
    timeoutSeconds: 300,
    steps: [
      { stepId: "s1", description: "step 1", action: { cmd: "echo ok" } },
    ],
  };
}

function makeFailingExecutor() {
  return {
    executeStep: jest.fn().mockResolvedValue({ success: false, error: new Error("step failed") }),
  };
}

// ---------------------------------------------------------------------------
// IncidentHandler escalation tests
// ---------------------------------------------------------------------------

describe("IncidentHandler — escalation", () => {

  // ── Handle resolvable ─────────────────────────────────────────────────

  describe("escalation with resolvable on-call handle (Req 5.6, 6.7)", () => {
    it("includes on-call handle in IncidentEscalationEvent when resolvable", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      // No runbook → immediate escalation

      const { events, emit } = makeEmit();
      const pd = { acknowledgeIncident: jest.fn() };
      const slack = { resolveHandle: jest.fn(), postMessage: jest.fn().mockResolvedValue({ success: true }) };
      const resolveHandle = jest.fn().mockResolvedValue("@alice");

      const handler = new IncidentHandler(
        library, pd as any, slack as any,
        { executeStep: jest.fn() } as any,
        emit, resolveHandle, silentLogger()
      );

      await handler.handleAlert(makeAlert());

      const escalation = events.find(e => e.eventType === "IncidentEscalationEvent") as Record<string, unknown>;
      expect(escalation.onCallHandle).toBe("@alice");
    });

    it("IncidentEscalationEvent carries incidentId, serviceName, reason", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });

      const { events, emit } = makeEmit();
      const handler = new IncidentHandler(
        library,
        { acknowledgeIncident: jest.fn() } as any,
        { resolveHandle: jest.fn(), postMessage: jest.fn().mockResolvedValue({ success: true }) } as any,
        { executeStep: jest.fn() } as any,
        emit,
        jest.fn().mockResolvedValue("@bob"),
        silentLogger()
      );

      await handler.handleAlert(makeAlert({ incidentId: "inc-x", serviceName: "crm-api" }));

      const escalation = events.find(e => e.eventType === "IncidentEscalationEvent") as Record<string, unknown>;
      expect(escalation.incidentId).toBe("inc-x");
      expect(escalation.serviceName).toBe("crm-api");
      expect(typeof escalation.reason).toBe("string");
    });
  });

  // ── Handle unresolvable ───────────────────────────────────────────────

  describe("escalation with unresolvable on-call handle (Req 6.7)", () => {
    it("sets onCallHandle to null in IncidentEscalationEvent when unresolvable", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });

      const { events, emit } = makeEmit();
      const handler = new IncidentHandler(
        library,
        { acknowledgeIncident: jest.fn() } as any,
        { resolveHandle: jest.fn(), postMessage: jest.fn().mockResolvedValue({ success: true }) } as any,
        { executeStep: jest.fn() } as any,
        emit,
        jest.fn().mockResolvedValue(null), // handle unresolvable
        silentLogger()
      );

      await handler.handleAlert(makeAlert());

      const escalation = events.find(e => e.eventType === "IncidentEscalationEvent") as Record<string, unknown>;
      expect(escalation.onCallHandle).toBeNull();
    });

    it("still escalates (posts to Slack) even when handle is unresolvable", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook());

      const { events, emit } = makeEmit();
      const slack = { resolveHandle: jest.fn(), postMessage: jest.fn().mockResolvedValue({ success: true }) };

      const handler = new IncidentHandler(
        library,
        { acknowledgeIncident: jest.fn() } as any,
        slack as any,
        makeFailingExecutor() as any,
        emit,
        jest.fn().mockResolvedValue(null), // unresolvable
        silentLogger()
      );

      await handler.handleAlert(makeAlert());

      // IncidentEscalationEvent should still be emitted
      const escalation = events.filter(e => e.eventType === "IncidentEscalationEvent");
      expect(escalation).toHaveLength(1);
    });
  });

  // ── Source and shape ──────────────────────────────────────────────────

  describe("IncidentEscalationEvent shape", () => {
    it("has source = 'Incident_Agent'", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });

      const { events, emit } = makeEmit();
      const handler = new IncidentHandler(
        library,
        { acknowledgeIncident: jest.fn() } as any,
        { resolveHandle: jest.fn(), postMessage: jest.fn().mockResolvedValue({ success: true }) } as any,
        { executeStep: jest.fn() } as any,
        emit,
        jest.fn().mockResolvedValue("@oncall"),
        silentLogger()
      );

      await handler.handleAlert(makeAlert());

      const escalation = events.find(e => e.eventType === "IncidentEscalationEvent");
      expect(escalation?.source).toBe("Incident_Agent");
    });
  });
});

// ---------------------------------------------------------------------------
// RunbookLibrary tests
// ---------------------------------------------------------------------------

describe("RunbookLibrary (Req 5.5)", () => {

  // ── register() and getLatest() ─────────────────────────────────────────

  describe("register() and getLatest()", () => {
    it("returns registered runbook via getLatest()", () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      const rb = makeRunbook("crm-api", "1.0.0");
      library.register(rb);

      expect(library.getLatest("crm-api")).toEqual(rb);
    });

    it("getLatest() returns the highest semver when multiple versions registered", () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook("svc", "1.0.0"));
      library.register(makeRunbook("svc", "2.1.0"));
      library.register(makeRunbook("svc", "1.9.0"));

      const latest = library.getLatest("svc");
      expect(latest?.version).toBe("2.1.0");
    });

    it("getLatest() returns the highest patch version", () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook("svc", "1.0.1"));
      library.register(makeRunbook("svc", "1.0.9"));
      library.register(makeRunbook("svc", "1.0.3"));

      expect(library.getLatest("svc")?.version).toBe("1.0.9");
    });

    it("getLatest() returns undefined when no runbook registered for service", () => {
      const library = new RunbookLibrary({ logger: silentLogger() });

      expect(library.getLatest("unknown-service")).toBeUndefined();
    });

    it("register() replaces existing runbook with same version (idempotent)", () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register({ ...makeRunbook("svc", "1.0.0"), timeoutSeconds: 100 });
      library.register({ ...makeRunbook("svc", "1.0.0"), timeoutSeconds: 200 });

      const versions = library.listVersions("svc");
      expect(versions).toHaveLength(1);
      expect(versions[0].timeoutSeconds).toBe(200);
    });

    it("does not register runbook with timeoutSeconds > 300", () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register({ ...makeRunbook("svc", "1.0.0"), timeoutSeconds: 301 });

      expect(library.getLatest("svc")).toBeUndefined();
    });

    it("registers runbook with timeoutSeconds exactly 300", () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register({ ...makeRunbook("svc", "1.0.0"), timeoutSeconds: 300 });

      expect(library.getLatest("svc")).toBeDefined();
    });
  });

  // ── listVersions() and listServices() ─────────────────────────────────

  describe("listVersions() and listServices()", () => {
    it("listVersions() returns all registered versions for a service", () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook("svc", "1.0.0"));
      library.register(makeRunbook("svc", "1.1.0"));
      library.register(makeRunbook("svc", "2.0.0"));

      const versions = library.listVersions("svc");
      expect(versions).toHaveLength(3);
      expect(versions.map(v => v.version).sort()).toEqual(["1.0.0", "1.1.0", "2.0.0"].sort());
    });

    it("listVersions() returns empty array for unknown service", () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      expect(library.listVersions("unknown")).toEqual([]);
    });

    it("listServices() returns all service names with registered runbooks", () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook("svc-a", "1.0.0"));
      library.register(makeRunbook("svc-b", "2.0.0"));
      library.register(makeRunbook("svc-c", "1.5.0"));

      const services = library.listServices();
      expect(services).toHaveLength(3);
      expect(services).toContain("svc-a");
      expect(services).toContain("svc-b");
      expect(services).toContain("svc-c");
    });

    it("listServices() returns empty array when no runbooks are registered", () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      expect(library.listServices()).toEqual([]);
    });
  });
});
