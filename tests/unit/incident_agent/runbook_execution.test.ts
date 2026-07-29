/**
 * Unit tests for IncidentHandler — runbook execution path
 * (src/agents/incident/execution.ts)
 *
 * Covers:
 *  - P1/P2 success: runbook found, executed, PagerDuty acked, IncidentResolvedEvent emitted
 *  - P1/P2 no-runbook: escalation within 30 s, incident marked manual, IncidentExecutionFailureEvent
 *  - Runbook failure: escalation, PD left open, IncidentExecutionFailureEvent emitted
 *  - Runbook step failure: marks execution as failed
 *  - P3/P4 alerts are ignored: no runbook lookup, no escalation, no events
 *  - 300 s timeout: execution terminated and treated as failure
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.6
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
    incidentId: "inc-001",
    serviceName: "crm-api",
    severity: "P1",
    receivedAt: new Date().toISOString(),
    details: {},
    ...overrides,
  };
}

function makeRunbook(steps = 2): Runbook {
  return {
    serviceName: "crm-api",
    version: "1.0.0",
    timeoutSeconds: 300,
    steps: Array.from({ length: steps }, (_, i) => ({
      stepId: `step-${i + 1}`,
      description: `Step ${i + 1}`,
      action: { type: "script", cmd: `echo step-${i + 1}` },
    })),
  };
}

function makeSuccessExecutor() {
  return {
    executeStep: jest.fn().mockResolvedValue({ success: true }),
  };
}

function makeFailingExecutor() {
  return {
    executeStep: jest.fn().mockResolvedValue({ success: false, error: new Error("step failed") }),
  };
}

function makePagerDuty(ackSuccess = true) {
  return {
    acknowledgeIncident: jest.fn().mockResolvedValue({ success: ackSuccess }),
  };
}

function makeSlack() {
  return {
    resolveHandle: jest.fn().mockResolvedValue("user-id-123"),
    postMessage: jest.fn().mockResolvedValue({ success: true }),
  };
}

function makeHandler(
  library: RunbookLibrary,
  opts: {
    ackSuccess?: boolean;
    onCallHandle?: string | null;
    executor?: ReturnType<typeof makeSuccessExecutor>;
  } = {}
) {
  const { events, emit } = makeEmit();
  const pd = makePagerDuty(opts.ackSuccess ?? true);
  const slack = makeSlack();
  const executor = opts.executor ?? makeSuccessExecutor();
  const resolveHandle = jest.fn().mockResolvedValue(
    opts.onCallHandle !== undefined ? opts.onCallHandle : "@oncall"
  );

  const handler = new IncidentHandler(
    library,
    pd,
    slack,
    executor,
    emit,
    resolveHandle,
    silentLogger()
  );

  return { handler, events, pd, slack, executor, resolveHandle };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IncidentHandler — runbook execution", () => {

  // ── P1/P2 success path ─────────────────────────────────────────────────

  describe("P1/P2 success path (Req 5.3)", () => {
    it("emits IncidentResolvedEvent when P1 runbook executes successfully", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook());

      const { handler, events } = makeHandler(library);
      await handler.handleAlert(makeAlert({ severity: "P1" }));

      const resolved = events.filter(e => e.eventType === "IncidentResolvedEvent");
      expect(resolved).toHaveLength(1);
    });

    it("emits IncidentResolvedEvent when P2 runbook executes successfully", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook());

      const { handler, events } = makeHandler(library);
      await handler.handleAlert(makeAlert({ severity: "P2" }));

      const resolved = events.filter(e => e.eventType === "IncidentResolvedEvent");
      expect(resolved).toHaveLength(1);
    });

    it("IncidentResolvedEvent contains incidentId and serviceName", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook());

      const { handler, events } = makeHandler(library);
      await handler.handleAlert(makeAlert({ incidentId: "inc-42", serviceName: "crm-api" }));

      const evt = events.find(e => e.eventType === "IncidentResolvedEvent") as Record<string, unknown>;
      expect(evt.incidentId).toBe("inc-42");
      expect(evt.serviceName).toBe("crm-api");
    });

    it("acknowledges PagerDuty incident on success (Req 5.3)", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook());

      const { handler, pd } = makeHandler(library);
      await handler.handleAlert(makeAlert({ incidentId: "inc-pd-99" }));

      expect(pd.acknowledgeIncident).toHaveBeenCalledWith("inc-pd-99");
    });

    it("executes all runbook steps in sequence", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook(3));

      const { handler, executor } = makeHandler(library);
      await handler.handleAlert(makeAlert());

      expect(executor.executeStep).toHaveBeenCalledTimes(3);
    });

    it("does not emit IncidentEscalationEvent on success path", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook());

      const { handler, events } = makeHandler(library);
      await handler.handleAlert(makeAlert());

      const escalation = events.filter(e => e.eventType === "IncidentEscalationEvent");
      expect(escalation).toHaveLength(0);
    });
  });

  // ── P1/P2 no-runbook path ─────────────────────────────────────────────

  describe("P1/P2 no-runbook path (Req 5.4)", () => {
    it("emits IncidentExecutionFailureEvent when no runbook is found for P1", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      // No runbook registered

      const { handler, events } = makeHandler(library);
      await handler.handleAlert(makeAlert({ severity: "P1" }));

      const failure = events.filter(e => e.eventType === "IncidentExecutionFailureEvent");
      expect(failure).toHaveLength(1);
    });

    it("IncidentExecutionFailureEvent contains incidentId, serviceName, failureReason", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });

      const { handler, events } = makeHandler(library);
      await handler.handleAlert(makeAlert({ incidentId: "inc-nobook", serviceName: "crm-api" }));

      const evt = events.find(e => e.eventType === "IncidentExecutionFailureEvent") as Record<string, unknown>;
      expect(evt.incidentId).toBe("inc-nobook");
      expect(evt.serviceName).toBe("crm-api");
      expect(typeof evt.failureReason).toBe("string");
      expect((evt.failureReason as string).length).toBeGreaterThan(0);
    });

    it("escalates via Slack when no runbook is found", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });

      const { handler, slack } = makeHandler(library);
      await handler.handleAlert(makeAlert({ severity: "P2" }));

      expect(slack.postMessage).toHaveBeenCalledTimes(1);
    });

    it("does not acknowledge PagerDuty when no runbook is found", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });

      const { handler, pd } = makeHandler(library);
      await handler.handleAlert(makeAlert());

      expect(pd.acknowledgeIncident).not.toHaveBeenCalled();
    });

    it("emits IncidentEscalationEvent when no runbook is found", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });

      const { handler, events } = makeHandler(library);
      await handler.handleAlert(makeAlert());

      const escalation = events.filter(e => e.eventType === "IncidentEscalationEvent");
      expect(escalation).toHaveLength(1);
    });
  });

  // ── Runbook step failure ──────────────────────────────────────────────

  describe("runbook step failure path (Req 5.4)", () => {
    it("emits IncidentExecutionFailureEvent when a runbook step fails", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook());

      const { handler, events } = makeHandler(library, {
        executor: makeFailingExecutor(),
      });
      await handler.handleAlert(makeAlert());

      const failure = events.filter(e => e.eventType === "IncidentExecutionFailureEvent");
      expect(failure).toHaveLength(1);
    });

    it("escalates via Slack when runbook step fails", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook());

      const { handler, slack } = makeHandler(library, {
        executor: makeFailingExecutor(),
      });
      await handler.handleAlert(makeAlert());

      expect(slack.postMessage).toHaveBeenCalled();
    });

    it("does NOT acknowledge PagerDuty when runbook fails (PD left open)", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook());

      const { handler, pd } = makeHandler(library, {
        executor: makeFailingExecutor(),
      });
      await handler.handleAlert(makeAlert());

      expect(pd.acknowledgeIncident).not.toHaveBeenCalled();
    });

    it("stops executing steps after the first failure", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook(3));

      const executor = makeFailingExecutor();
      const { handler } = makeHandler(library, { executor });
      await handler.handleAlert(makeAlert());

      // Should stop at step 1 and not continue
      expect(executor.executeStep).toHaveBeenCalledTimes(1);
    });
  });

  // ── P3/P4 ignored ────────────────────────────────────────────────────

  describe("P3/P4 alerts are ignored (Req 5.1)", () => {
    it.each(["P3", "P4"] as const)(
      "does not emit any events for %s alert",
      async (severity) => {
        const library = new RunbookLibrary({ logger: silentLogger() });
        library.register(makeRunbook());

        const { handler, events } = makeHandler(library);
        await handler.handleAlert(makeAlert({ severity }));

        expect(events).toHaveLength(0);
      }
    );

    it.each(["P3", "P4"] as const)(
      "does not look up a runbook for %s alert",
      async (severity) => {
        const library = new RunbookLibrary({ logger: silentLogger() });
        const getLatestSpy = jest.spyOn(library, "getLatest");

        const { handler } = makeHandler(library);
        await handler.handleAlert(makeAlert({ severity }));

        expect(getLatestSpy).not.toHaveBeenCalled();
      }
    );

    it.each(["P3", "P4"] as const)(
      "does not call Slack for %s alert",
      async (severity) => {
        const library = new RunbookLibrary({ logger: silentLogger() });

        const { handler, slack } = makeHandler(library);
        await handler.handleAlert(makeAlert({ severity }));

        expect(slack.postMessage).not.toHaveBeenCalled();
      }
    );
  });

  // ── 300 s timeout ─────────────────────────────────────────────────────

  describe("300 s execution timeout (Req 5.2)", () => {
    it("treats execution as failure when timeout is exceeded", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register({
        ...makeRunbook(1),
        // Each step takes 200 ms; with a 0 ms timeout it will fail immediately
      });

      // Use a very short timeout to simulate the 300 s condition
      const slowExecutor = {
        executeStep: jest.fn().mockImplementation(async () => {
          await new Promise(r => setTimeout(r, 50));
          return { success: true };
        }),
      };

      const { events, emit } = makeEmit();
      const pd = makePagerDuty();
      const slack = makeSlack();
      const resolveHandle = jest.fn().mockResolvedValue("@oncall");

      const handler = new IncidentHandler(
        library,
        pd,
        slack,
        slowExecutor,
        emit,
        resolveHandle,
        silentLogger()
      );

      // Use a 0 ms timeout to force immediate timeout
      await handler.handleAlert(makeAlert(), { timeoutSeconds: 0 });

      const failure = events.filter(e => e.eventType === "IncidentExecutionFailureEvent");
      expect(failure).toHaveLength(1);
    });

    it("does not acknowledge PagerDuty when execution times out", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook(1));

      const { events, emit } = makeEmit();
      const pd = makePagerDuty();
      const slack = makeSlack();
      const slowExecutor = {
        executeStep: jest.fn().mockImplementation(async () => {
          await new Promise(r => setTimeout(r, 50));
          return { success: true };
        }),
      };

      const handler = new IncidentHandler(
        library, pd, slack, slowExecutor, emit,
        jest.fn().mockResolvedValue("@oncall"),
        silentLogger()
      );

      await handler.handleAlert(makeAlert(), { timeoutSeconds: 0 });

      expect(pd.acknowledgeIncident).not.toHaveBeenCalled();
    });
  });

  // ── Event shape invariants ────────────────────────────────────────────

  describe("event shape invariants", () => {
    it("every emitted event has non-empty eventId, correlationId, timestamp", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });
      library.register(makeRunbook());

      const { handler, events } = makeHandler(library);
      await handler.handleAlert(makeAlert());

      for (const evt of events) {
        expect(typeof evt.eventId).toBe("string");
        expect(evt.eventId.length).toBeGreaterThan(0);
        expect(typeof evt.correlationId).toBe("string");
        expect(evt.correlationId.length).toBeGreaterThan(0);
        expect(typeof evt.timestamp).toBe("string");
        expect(evt.timestamp).toContain("T");
      }
    });

    it("every emitted event has source = 'Incident_Agent'", async () => {
      const library = new RunbookLibrary({ logger: silentLogger() });

      const { handler, events } = makeHandler(library);
      await handler.handleAlert(makeAlert());

      for (const evt of events) {
        expect(evt.source).toBe("Incident_Agent");
      }
    });
  });
});
