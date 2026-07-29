/**
 * Unit tests for PipelinePoller (src/agents/pipeline/polling.ts)
 *
 * Covers:
 *  - Normal completion: poll returns terminal state → PipelineCompletedEvent emitted
 *  - Poll failure + single retry: first poll fails, retry succeeds
 *  - Poll failure + retry also fails → PipelinePollFailureEvent emitted
 *  - Timeout detection: elapsed time exceeds max_duration_seconds → PipelineTimeoutEvent
 *  - Null / unset max_duration_seconds → no timeout event emitted
 *  - PipelineCompletedEvent fields: runId, repo, branch, terminalState, non-negative durationSeconds
 *  - PipelineTimeoutEvent fields: pipelineRunId, configuredMaxDurationSeconds
 *  - PipelinePollFailureEvent fields: pipelineRunId, repositoryName, branchName, failureReason
 *  - stop() halts the loop cleanly
 *  - Invalid max_duration_seconds (non-positive, non-integer) throws RangeError
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5
 */

import {
  PipelinePoller,
  pollPipelineStatus,
  type JenkinsClient,
  type PollConfig,
  type OrchestratorEmit,
} from "../../../src/agents/pipeline/polling";
import type { PipelineStatus, PollError, Result } from "../../../src/types/models";
import type { OutboundEvent } from "../../../src/interfaces/shared";
import { StructuredLogger } from "../../../src/utils/logger";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Silent logger — discards all output to keep test stdout clean. */
function silentLogger(): StructuredLogger {
  return new StructuredLogger(() => {/* discard */});
}

/** Collect emitted events into an array and return both. */
function makeEmit(): { emittedEvents: OutboundEvent[]; emit: OrchestratorEmit } {
  const emittedEvents: OutboundEvent[] = [];
  const emit: OrchestratorEmit = (event) => emittedEvents.push(event);
  return { emittedEvents, emit };
}

/** Build a minimal PollConfig with timing overrides (0 ms) for fast tests. */
function makeConfig(overrides: Partial<PollConfig> = {}): PollConfig {
  return {
    pipelineRunId: "run-001",
    repositoryName: "crm-api",
    branchName: "main",
    pollIntervalMs: 0,   // no real waiting in tests
    retryDelayMs: 0,     // no real waiting in tests
    ...overrides,
  };
}

/** Build an Ok PipelineStatus result. */
function statusOk(state: PipelineStatus["state"], durationSeconds: number | null = null): Result<PipelineStatus, PollError> {
  return { success: true, value: { runId: "run-001", state, durationSeconds } };
}

/** Build an Err PollError result. */
function statusErr(message = "Jenkins poll failed"): Result<PipelineStatus, PollError> {
  return { success: false, error: { code: "JENKINS_POLL_FAILED", message } };
}

// ---------------------------------------------------------------------------
// PipelinePoller tests
// ---------------------------------------------------------------------------

describe("PipelinePoller", () => {

  // ── Normal completion ──────────────────────────────────────────────────────

  describe("normal completion", () => {
    it.each(["success", "failure", "aborted"] as const)(
      "emits PipelineCompletedEvent when terminal state '%s' is detected",
      async (state) => {
        const client: JenkinsClient = {
          getPipelineStatus: jest.fn().mockResolvedValue(statusOk(state, 120)),
        };
        const { emittedEvents, emit } = makeEmit();
        const poller = new PipelinePoller(client, emit, silentLogger());

        await poller.start(makeConfig());

        expect(emittedEvents).toHaveLength(1);
        expect(emittedEvents[0].eventType).toBe("PipelineCompletedEvent");
      }
    );

    it("PipelineCompletedEvent contains all required fields (Req 2.2)", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusOk("success", 240)),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig({
        pipelineRunId: "run-abc",
        repositoryName: "crm-repo",
        branchName: "release/v2",
      }));

      const evt = emittedEvents[0] as Record<string, unknown>;
      expect(evt.eventType).toBe("PipelineCompletedEvent");
      expect(evt.pipelineRunId).toBe("run-abc");
      expect(evt.repositoryName).toBe("crm-repo");
      expect(evt.branchName).toBe("release/v2");
      expect(evt.terminalState).toBe("success");
      expect(typeof evt.durationSeconds).toBe("number");
      expect(evt.durationSeconds as number).toBeGreaterThanOrEqual(0);
    });

    it("durationSeconds in event comes from Jenkins response when provided", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusOk("success", 300)),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig());

      const evt = emittedEvents[0] as Record<string, unknown>;
      expect(evt.durationSeconds).toBe(300);
    });

    it("durationSeconds falls back to elapsed time when Jenkins returns null", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusOk("success", null)),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      const startTimestamp = new Date(Date.now() - 5000).toISOString(); // pretend started 5s ago
      await poller.start(makeConfig({ startTimestamp }));

      const evt = emittedEvents[0] as Record<string, unknown>;
      expect(typeof evt.durationSeconds).toBe("number");
      expect(evt.durationSeconds as number).toBeGreaterThanOrEqual(0);
    });

    it("polls in_progress state multiple times before reaching terminal state", async () => {
      const getPipelineStatus = jest.fn()
        .mockResolvedValueOnce(statusOk("in_progress"))
        .mockResolvedValueOnce(statusOk("in_progress"))
        .mockResolvedValue(statusOk("success", 90));

      const client: JenkinsClient = { getPipelineStatus };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig());

      expect(getPipelineStatus).toHaveBeenCalledTimes(3);
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].eventType).toBe("PipelineCompletedEvent");
    });

    it("emits source = 'Pipeline_Agent' on PipelineCompletedEvent", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusOk("failure", 10)),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig());

      expect(emittedEvents[0].source).toBe("Pipeline_Agent");
    });
  });

  // ── Poll failure and single retry ─────────────────────────────────────────

  describe("poll failure with single retry", () => {
    it("retries once after a poll failure and succeeds on retry", async () => {
      const getPipelineStatus = jest.fn()
        .mockResolvedValueOnce(statusErr("transient error"))
        .mockResolvedValue(statusOk("success", 60));

      const client: JenkinsClient = { getPipelineStatus };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig());

      expect(getPipelineStatus).toHaveBeenCalledTimes(2);
      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].eventType).toBe("PipelineCompletedEvent");
    });

    it("emits PipelinePollFailureEvent when both poll attempts fail (Req 2.1)", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusErr("Jenkins is down")),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig());

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].eventType).toBe("PipelinePollFailureEvent");
    });

    it("PipelinePollFailureEvent contains pipelineRunId, repositoryName, branchName, failureReason", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusErr("503 Service Unavailable")),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig({
        pipelineRunId: "run-fail-99",
        repositoryName: "crm-service",
        branchName: "hotfix/patch",
      }));

      const evt = emittedEvents[0] as Record<string, unknown>;
      expect(evt.pipelineRunId).toBe("run-fail-99");
      expect(evt.repositoryName).toBe("crm-service");
      expect(evt.branchName).toBe("hotfix/patch");
      expect(typeof evt.failureReason).toBe("string");
      expect((evt.failureReason as string).length).toBeGreaterThan(0);
    });

    it("PipelinePollFailureEvent has source = 'Pipeline_Agent'", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusErr()),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig());

      expect(emittedEvents[0].source).toBe("Pipeline_Agent");
    });

    it("stops polling after PipelinePollFailureEvent (does not retry again)", async () => {
      const getPipelineStatus = jest.fn().mockResolvedValue(statusErr());
      const client: JenkinsClient = { getPipelineStatus };
      const { emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig());

      // First attempt + one retry = 2 total calls only
      expect(getPipelineStatus).toHaveBeenCalledTimes(2);
    });
  });

  // ── Timeout detection ─────────────────────────────────────────────────────

  describe("timeout detection", () => {
    it("emits PipelineTimeoutEvent when elapsed time exceeds max_duration_seconds (Req 2.3)", async () => {
      // Simulate that the run started 120s ago, with max of 60s
      const startTimestamp = new Date(Date.now() - 120_000).toISOString();

      const client: JenkinsClient = {
        // This should never be reached — timeout fires before first poll
        getPipelineStatus: jest.fn().mockResolvedValue(statusOk("in_progress")),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig({
        maxDurationSeconds: 60,
        startTimestamp,
      }));

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].eventType).toBe("PipelineTimeoutEvent");
    });

    it("PipelineTimeoutEvent contains exact pipelineRunId and configuredMaxDurationSeconds", async () => {
      const startTimestamp = new Date(Date.now() - 500_000).toISOString();

      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusOk("in_progress")),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig({
        pipelineRunId: "run-timeout-42",
        maxDurationSeconds: 300,
        startTimestamp,
      }));

      const evt = emittedEvents[0] as Record<string, unknown>;
      expect(evt.eventType).toBe("PipelineTimeoutEvent");
      expect(evt.pipelineRunId).toBe("run-timeout-42");
      expect(evt.configuredMaxDurationSeconds).toBe(300);
    });

    it("PipelineTimeoutEvent has source = 'Pipeline_Agent'", async () => {
      const startTimestamp = new Date(Date.now() - 200_000).toISOString();
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusOk("in_progress")),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig({ maxDurationSeconds: 60, startTimestamp }));

      expect(emittedEvents[0].source).toBe("Pipeline_Agent");
    });

    it("does NOT poll Jenkins when timeout is detected before first poll", async () => {
      const startTimestamp = new Date(Date.now() - 120_000).toISOString();
      const getPipelineStatus = jest.fn().mockResolvedValue(statusOk("in_progress"));
      const client: JenkinsClient = { getPipelineStatus };
      const { emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig({ maxDurationSeconds: 60, startTimestamp }));

      expect(getPipelineStatus).not.toHaveBeenCalled();
    });

    it("emits PipelineCompletedEvent (not timeout) when run finishes before max_duration_seconds", async () => {
      // Start right now, max is 1 hour — should complete normally
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusOk("success", 30)),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig({ maxDurationSeconds: 3600 }));

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].eventType).toBe("PipelineCompletedEvent");
    });
  });

  // ── Null / unset max_duration_seconds ─────────────────────────────────────

  describe("null / unset max_duration_seconds — no timeout monitoring", () => {
    it("does not emit a PipelineTimeoutEvent when max_duration_seconds is null", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusOk("success", 60)),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig({ maxDurationSeconds: null }));

      const timeoutEvents = emittedEvents.filter(e => e.eventType === "PipelineTimeoutEvent");
      expect(timeoutEvents).toHaveLength(0);
    });

    it("does not emit a PipelineTimeoutEvent when max_duration_seconds is undefined", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusOk("aborted", 45)),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      // maxDurationSeconds intentionally omitted
      await poller.start(makeConfig());

      const timeoutEvents = emittedEvents.filter(e => e.eventType === "PipelineTimeoutEvent");
      expect(timeoutEvents).toHaveLength(0);
    });

    it("still emits PipelineCompletedEvent when max_duration_seconds is null", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusOk("failure", 10)),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig({ maxDurationSeconds: null }));

      expect(emittedEvents).toHaveLength(1);
      expect(emittedEvents[0].eventType).toBe("PipelineCompletedEvent");
    });
  });

  // ── Invalid max_duration_seconds ──────────────────────────────────────────

  describe("invalid max_duration_seconds", () => {
    it("throws RangeError when max_duration_seconds is 0", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn(),
      };
      const { emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await expect(poller.start(makeConfig({ maxDurationSeconds: 0 }))).rejects.toThrow(RangeError);
    });

    it("throws RangeError when max_duration_seconds is negative", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn(),
      };
      const { emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await expect(poller.start(makeConfig({ maxDurationSeconds: -60 }))).rejects.toThrow(RangeError);
    });

    it("throws RangeError when max_duration_seconds is a non-integer (float)", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn(),
      };
      const { emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await expect(poller.start(makeConfig({ maxDurationSeconds: 30.5 }))).rejects.toThrow(RangeError);
    });
  });

  // ── stop() ────────────────────────────────────────────────────────────────

  describe("stop()", () => {
    it("stop() called before start() causes loop to exit immediately without polling", async () => {
      const getPipelineStatus = jest.fn().mockResolvedValue(statusOk("in_progress"));
      const client: JenkinsClient = { getPipelineStatus };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      poller.stop();
      await poller.start(makeConfig());

      expect(getPipelineStatus).not.toHaveBeenCalled();
      expect(emittedEvents).toHaveLength(0);
    });
  });

  // ── Event envelope invariants ──────────────────────────────────────────────

  describe("event envelope invariants", () => {
    it("every emitted event has a non-empty eventId", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusOk("success", 10)),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig());

      for (const evt of emittedEvents) {
        expect(typeof evt.eventId).toBe("string");
        expect(evt.eventId.length).toBeGreaterThan(0);
      }
    });

    it("every emitted event has a non-empty correlationId", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusErr()),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig());

      for (const evt of emittedEvents) {
        expect(typeof evt.correlationId).toBe("string");
        expect(evt.correlationId.length).toBeGreaterThan(0);
      }
    });

    it("every emitted event has a valid ISO 8601 timestamp", async () => {
      const client: JenkinsClient = {
        getPipelineStatus: jest.fn().mockResolvedValue(statusOk("aborted", 5)),
      };
      const { emittedEvents, emit } = makeEmit();
      const poller = new PipelinePoller(client, emit, silentLogger());

      await poller.start(makeConfig());

      for (const evt of emittedEvents) {
        expect(typeof evt.timestamp).toBe("string");
        expect(evt.timestamp).toContain("T");
        expect(isNaN(Date.parse(evt.timestamp))).toBe(false);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Standalone pollPipelineStatus() function tests
// ---------------------------------------------------------------------------

describe("pollPipelineStatus (standalone helper)", () => {
  it("returns Ok(PipelineStatus) when first attempt succeeds", async () => {
    const client: JenkinsClient = {
      getPipelineStatus: jest.fn().mockResolvedValue(statusOk("success", 60)),
    };

    const result = await pollPipelineStatus("run-1", client, 0);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.state).toBe("success");
    }
  });

  it("retries once after first failure and returns Ok on retry success", async () => {
    const getPipelineStatus = jest.fn()
      .mockResolvedValueOnce(statusErr("first attempt fails"))
      .mockResolvedValue(statusOk("failure", 45));

    const client: JenkinsClient = { getPipelineStatus };
    const result = await pollPipelineStatus("run-2", client, 0);

    expect(result.success).toBe(true);
    expect(getPipelineStatus).toHaveBeenCalledTimes(2);
  });

  it("returns Err when both attempts fail", async () => {
    const client: JenkinsClient = {
      getPipelineStatus: jest.fn().mockResolvedValue(statusErr("persistent failure")),
    };

    const result = await pollPipelineStatus("run-3", client, 0);

    expect(result.success).toBe(false);
  });

  it("calls Jenkins with the provided runId", async () => {
    const getPipelineStatus = jest.fn().mockResolvedValue(statusOk("success", 10));
    const client: JenkinsClient = { getPipelineStatus };

    await pollPipelineStatus("specific-run-id", client, 0);

    expect(getPipelineStatus).toHaveBeenCalledWith("specific-run-id");
  });
});
