/**
 * Unit tests for PipelineTrigger (src/agents/pipeline/trigger.ts)
 *
 * Covers:
 *  - Trigger success (emits PipelineTriggeredEvent, returns Ok(runId))
 *  - All 3 attempts fail — retries exhausted (emits PipelineTriggerFailedEvent, returns Err)
 *  - Partial retry recovery (fails on attempt 0, succeeds on attempt 1)
 *  - No job configured for the repository (immediate failure, no retries)
 *  - Failure event carries repo, branch, triggerTimestamp, and failureReason (Req 1.4)
 *  - Success event carries pipelineRunId, repo, branch, triggerTimestamp (Req 1.2)
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4
 */

import { PipelineTrigger, JenkinsClient, sleep } from "../../../src/agents/pipeline/trigger";
import type { PipelineTriggerCommand } from "../../../src/types/models";
import type { OutboundEvent } from "../../../src/interfaces/shared";
import { StructuredLogger } from "../../../src/utils/logger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal PipelineTriggerCommand for test use. */
function makeCommand(overrides: Partial<PipelineTriggerCommand> = {}): PipelineTriggerCommand {
  return {
    eventId: "evt-001",
    correlationId: "corr-001",
    eventType: "PipelineTriggerCommand",
    source: "Orchestrator",
    timestamp: "2024-01-15T10:00:00.000Z",
    repositoryName: "crm-api",
    branchName: "main",
    triggerTimestamp: "2024-01-15T10:00:00.000Z",
    ...overrides,
  };
}

/** A no-op logger that discards all output (keeps test stdout clean). */
function silentLogger(): StructuredLogger {
  return new StructuredLogger(() => {/* discard */});
}

/** Replace the module-level sleep with an instant no-op to keep tests fast. */
jest.mock("../../../src/agents/pipeline/trigger", () => {
  const actual = jest.requireActual("../../../src/agents/pipeline/trigger");
  return {
    ...actual,
    sleep: jest.fn().mockResolvedValue(undefined),
  };
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("PipelineTrigger", () => {
  const JOB_MAP = { "crm-api": "crm-api-build" };

  let emittedEvents: OutboundEvent[];
  let emitFn: jest.Mock;

  beforeEach(() => {
    emittedEvents = [];
    emitFn = jest.fn((event: OutboundEvent) => { emittedEvents.push(event); });
  });

  // -------------------------------------------------------------------------
  // Success path
  // -------------------------------------------------------------------------

  describe("success path", () => {
    it("returns Ok(runId) when Jenkins responds on the first attempt", async () => {
      const jenkins: JenkinsClient = {
        triggerJob: jest.fn().mockResolvedValue("run-42"),
      };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      const result = await trigger.triggerPipeline(makeCommand());

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe("run-42");
      }
    });

    it("emits exactly one PipelineTriggeredEvent on success (Req 1.2)", async () => {
      const jenkins: JenkinsClient = {
        triggerJob: jest.fn().mockResolvedValue("run-99"),
      };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      const cmd = makeCommand();
      await trigger.triggerPipeline(cmd);

      expect(emittedEvents).toHaveLength(1);
      const evt = emittedEvents[0];
      expect(evt.eventType).toBe("PipelineTriggeredEvent");
    });

    it("PipelineTriggeredEvent contains pipelineRunId, repo, branch, and triggerTimestamp (Req 1.2)", async () => {
      const jenkins: JenkinsClient = {
        triggerJob: jest.fn().mockResolvedValue("run-77"),
      };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      const cmd = makeCommand({ repositoryName: "crm-api", branchName: "feature/x", triggerTimestamp: "2024-06-01T08:00:00.000Z" });
      await trigger.triggerPipeline(cmd);

      const evt = emittedEvents[0] as Record<string, unknown>;
      expect(evt.pipelineRunId).toBe("run-77");
      expect(evt.repositoryName).toBe("crm-api");
      expect(evt.branchName).toBe("feature/x");
      expect(evt.triggerTimestamp).toBe("2024-06-01T08:00:00.000Z");
    });

    it("PipelineTriggeredEvent propagates the correlationId (Req 8.4)", async () => {
      const jenkins: JenkinsClient = {
        triggerJob: jest.fn().mockResolvedValue("run-55"),
      };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      const cmd = makeCommand({ correlationId: "my-corr-id" });
      await trigger.triggerPipeline(cmd);

      expect(emittedEvents[0].correlationId).toBe("my-corr-id");
    });

    it("calls Jenkins with the correct job name and branch params", async () => {
      const triggerJobMock = jest.fn().mockResolvedValue("run-1");
      const jenkins: JenkinsClient = { triggerJob: triggerJobMock };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      await trigger.triggerPipeline(makeCommand({ branchName: "develop" }));

      expect(triggerJobMock).toHaveBeenCalledWith("crm-api-build", { branch: "develop" });
    });
  });

  // -------------------------------------------------------------------------
  // Retry and exhaustion paths
  // -------------------------------------------------------------------------

  describe("retry exhaustion path", () => {
    it("attempts exactly 3 times before giving up (Req 1.3)", async () => {
      const triggerJobMock = jest.fn().mockRejectedValue(new Error("Jenkins unreachable"));
      const jenkins: JenkinsClient = { triggerJob: triggerJobMock };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      await trigger.triggerPipeline(makeCommand());

      expect(triggerJobMock).toHaveBeenCalledTimes(3);
    });

    it("returns Err with RETRIES_EXHAUSTED after all attempts fail", async () => {
      const jenkins: JenkinsClient = {
        triggerJob: jest.fn().mockRejectedValue(new Error("503 Service Unavailable")),
      };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      const result = await trigger.triggerPipeline(makeCommand());

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("RETRIES_EXHAUSTED");
      }
    });

    it("emits exactly one PipelineTriggerFailedEvent after all retries exhausted (Req 1.4)", async () => {
      const jenkins: JenkinsClient = {
        triggerJob: jest.fn().mockRejectedValue(new Error("timeout")),
      };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      await trigger.triggerPipeline(makeCommand());

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].eventType).toBe("PipelineTriggerFailedEvent");
    });

    it("PipelineTriggerFailedEvent contains repo, branch, triggerTimestamp, and failureReason (Req 1.4)", async () => {
      const jenkins: JenkinsClient = {
        triggerJob: jest.fn().mockRejectedValue(new Error("connection refused")),
      };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      const cmd = makeCommand({
        repositoryName: "crm-api",
        branchName: "main",
        triggerTimestamp: "2024-06-01T09:00:00.000Z",
        correlationId: "corr-fail",
      });
      await trigger.triggerPipeline(cmd);

      const evt = emittedEvents[0] as Record<string, unknown>;
      expect(evt.repositoryName).toBe("crm-api");
      expect(evt.branchName).toBe("main");
      expect(evt.triggerTimestamp).toBe("2024-06-01T09:00:00.000Z");
      expect(typeof evt.failureReason).toBe("string");
      expect((evt.failureReason as string).length).toBeGreaterThan(0);
    });

    it("PipelineTriggerFailedEvent propagates the correlationId", async () => {
      const jenkins: JenkinsClient = {
        triggerJob: jest.fn().mockRejectedValue(new Error("down")),
      };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      const cmd = makeCommand({ correlationId: "corr-xyz" });
      await trigger.triggerPipeline(cmd);

      expect(emittedEvents[0].correlationId).toBe("corr-xyz");
    });

    it("failure reason in event reflects the last Jenkins error message", async () => {
      const jenkins: JenkinsClient = {
        triggerJob: jest.fn().mockRejectedValue(new Error("Jenkins HTTP 503")),
      };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      await trigger.triggerPipeline(makeCommand());

      const evt = emittedEvents[0] as Record<string, unknown>;
      expect(evt.failureReason as string).toContain("Jenkins HTTP 503");
    });
  });

  // -------------------------------------------------------------------------
  // Partial retry recovery
  // -------------------------------------------------------------------------

  describe("partial retry recovery", () => {
    it("succeeds on the second attempt after the first fails", async () => {
      const triggerJobMock = jest
        .fn()
        .mockRejectedValueOnce(new Error("transient error"))
        .mockResolvedValue("run-recovered");
      const jenkins: JenkinsClient = { triggerJob: triggerJobMock };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      const result = await trigger.triggerPipeline(makeCommand());

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe("run-recovered");
      }
      expect(triggerJobMock).toHaveBeenCalledTimes(2);
    });

    it("emits a PipelineTriggeredEvent (not a failed event) when recovery succeeds", async () => {
      const triggerJobMock = jest
        .fn()
        .mockRejectedValueOnce(new Error("transient"))
        .mockResolvedValue("run-ok");
      const jenkins: JenkinsClient = { triggerJob: triggerJobMock };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      await trigger.triggerPipeline(makeCommand());

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].eventType).toBe("PipelineTriggeredEvent");
    });

    it("succeeds on the third attempt after two failures", async () => {
      const triggerJobMock = jest
        .fn()
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"))
        .mockResolvedValue("run-third-time-lucky");
      const jenkins: JenkinsClient = { triggerJob: triggerJobMock };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      const result = await trigger.triggerPipeline(makeCommand());

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.value).toBe("run-third-time-lucky");
      }
      expect(triggerJobMock).toHaveBeenCalledTimes(3);
    });
  });

  // -------------------------------------------------------------------------
  // No job configured
  // -------------------------------------------------------------------------

  describe("no job configured for repository", () => {
    it("returns Err(JENKINS_ERROR) immediately without calling Jenkins", async () => {
      const triggerJobMock = jest.fn();
      const jenkins: JenkinsClient = { triggerJob: triggerJobMock };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      const result = await trigger.triggerPipeline(makeCommand({ repositoryName: "unknown-repo" }));

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("JENKINS_ERROR");
      }
      expect(triggerJobMock).not.toHaveBeenCalled();
    });

    it("emits a PipelineTriggerFailedEvent when no job is configured", async () => {
      const jenkins: JenkinsClient = { triggerJob: jest.fn() };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      await trigger.triggerPipeline(makeCommand({ repositoryName: "unknown-repo" }));

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].eventType).toBe("PipelineTriggerFailedEvent");
    });
  });

  // -------------------------------------------------------------------------
  // Event shape invariants
  // -------------------------------------------------------------------------

  describe("event shape invariants", () => {
    it("every emitted event has a non-empty eventId", async () => {
      const jenkins: JenkinsClient = {
        triggerJob: jest.fn().mockResolvedValue("run-shape"),
      };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      await trigger.triggerPipeline(makeCommand());

      expect(typeof emittedEvents[0].eventId).toBe("string");
      expect(emittedEvents[0].eventId.length).toBeGreaterThan(0);
    });

    it("every emitted event has a non-empty timestamp", async () => {
      const jenkins: JenkinsClient = {
        triggerJob: jest.fn().mockResolvedValue("run-ts"),
      };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      await trigger.triggerPipeline(makeCommand());

      expect(typeof emittedEvents[0].timestamp).toBe("string");
      expect(emittedEvents[0].timestamp.length).toBeGreaterThan(0);
    });

    it("every emitted event has source = 'Pipeline_Agent'", async () => {
      const jenkins: JenkinsClient = {
        triggerJob: jest.fn().mockRejectedValue(new Error("down")),
      };

      const trigger = new PipelineTrigger(jenkins, emitFn, JOB_MAP, silentLogger());
      await trigger.triggerPipeline(makeCommand());

      expect(emittedEvents[0].source).toBe("Pipeline_Agent");
    });
  });
});
