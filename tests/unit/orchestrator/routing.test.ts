/**
 * Unit tests for CommandDispatcher (src/orchestrator/dispatch.ts) and
 * EventIngester (src/orchestrator/ingest.ts)
 *
 * Covers:
 *  - Each EventType routes to the expected agent
 *  - PipelinePollFailureEvent routes to Notification_Agent
 *  - correlationId is forwarded through the full dispatch chain (Req 8.4)
 *  - EventIngester assigns correlationId when missing
 *  - EventIngester preserves existing correlationId
 *  - Unknown event types are silently dropped (no error)
 *
 * Requirements: 1.4, 2.5, 8.1, 8.4
 */

import { CommandDispatcher } from "../../../src/orchestrator/dispatch";
import { EventIngester } from "../../../src/orchestrator/ingest";
import { StructuredLogger } from "../../../src/utils/logger";
import type { BaseEvent, EventType } from "../../../src/types/models";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): StructuredLogger {
  return new StructuredLogger(() => {/* discard */});
}

function makeAgent() {
  return { dispatch: jest.fn().mockResolvedValue(undefined) };
}

function makeDispatcher() {
  const pipeline = makeAgent();
  const deployment = makeAgent();
  const incident = makeAgent();
  const notification = makeAgent();

  const dispatcher = new CommandDispatcher(
    pipeline,
    deployment,
    incident,
    notification,
    silentLogger()
  );

  return { dispatcher, pipeline, deployment, incident, notification };
}

function makeEvent(eventType: EventType, extra: Record<string, unknown> = {}): BaseEvent {
  return {
    eventId: uuidv4(),
    correlationId: uuidv4(),
    eventType,
    source: "Pipeline_Agent",
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// CommandDispatcher routing tests
// ---------------------------------------------------------------------------

describe("CommandDispatcher — routing", () => {

  // ── Pipeline events → Notification ───────────────────────────────────

  describe("PipelineTriggerFailedEvent → Notification_Agent", () => {
    it("routes PipelineTriggerFailedEvent to Notification_Agent", async () => {
      const { dispatcher, notification, deployment, incident, pipeline } = makeDispatcher();
      const event = makeEvent("PipelineTriggerFailedEvent", {
        repositoryName: "crm-api",
        branchName: "main",
        triggerTimestamp: new Date().toISOString(),
        failureReason: "timeout",
      });

      await dispatcher.dispatch("PipelineTriggerFailedEvent", event.correlationId, event);

      expect(notification.dispatch).toHaveBeenCalledTimes(1);
      expect(deployment.dispatch).not.toHaveBeenCalled();
      expect(incident.dispatch).not.toHaveBeenCalled();
      expect(pipeline.dispatch).not.toHaveBeenCalled();
    });

    it("NotifyCommand carries correlationId from originating event (Req 8.4)", async () => {
      const { dispatcher, notification } = makeDispatcher();
      const corrId = "my-pipeline-fail-corr";
      const event = makeEvent("PipelineTriggerFailedEvent", {
        correlationId: corrId,
        repositoryName: "crm-api",
        branchName: "main",
        triggerTimestamp: new Date().toISOString(),
        failureReason: "jenkins down",
      });

      await dispatcher.dispatch("PipelineTriggerFailedEvent", corrId, event);

      const dispatched = notification.dispatch.mock.calls[0][0];
      expect(dispatched.correlationId).toBe(corrId);
    });
  });

  describe("PipelinePollFailureEvent → Notification_Agent (Req 2.5)", () => {
    it("routes PipelinePollFailureEvent to Notification_Agent", async () => {
      const { dispatcher, notification, deployment } = makeDispatcher();
      const event = makeEvent("PipelinePollFailureEvent", {
        pipelineRunId: "run-001",
        repositoryName: "crm-api",
        branchName: "main",
        failureReason: "poll failed",
      });

      await dispatcher.dispatch("PipelinePollFailureEvent", event.correlationId, event);

      expect(notification.dispatch).toHaveBeenCalledTimes(1);
      expect(deployment.dispatch).not.toHaveBeenCalled();
    });

    it("NotifyCommand has outcome = 'failure' for poll failure", async () => {
      const { dispatcher, notification } = makeDispatcher();
      const event = makeEvent("PipelinePollFailureEvent", {
        pipelineRunId: "run-001",
        repositoryName: "crm-api",
        branchName: "main",
        failureReason: "jenkins unreachable",
      });

      await dispatcher.dispatch("PipelinePollFailureEvent", event.correlationId, event);

      const cmd = notification.dispatch.mock.calls[0][0];
      expect(cmd.outcome).toBe("failure");
    });
  });

  // ── PipelineCompletedEvent → Deployment (on success) ─────────────────

  describe("PipelineCompletedEvent → Deployment_Agent (Req 3.1)", () => {
    it("routes PipelineCompletedEvent (success) to Deployment_Agent", async () => {
      const { dispatcher, deployment, notification } = makeDispatcher();
      const event = makeEvent("PipelineCompletedEvent", {
        pipelineRunId: "run-007",
        repositoryName: "crm-api",
        branchName: "main",
        terminalState: "success",
        durationSeconds: 120,
      });

      await dispatcher.dispatch("PipelineCompletedEvent", event.correlationId, event);

      expect(deployment.dispatch).toHaveBeenCalledTimes(1);
    });

    it("does NOT route PipelineCompletedEvent (failure) to Deployment_Agent", async () => {
      const { dispatcher, deployment } = makeDispatcher();
      const event = makeEvent("PipelineCompletedEvent", {
        pipelineRunId: "run-008",
        repositoryName: "crm-api",
        branchName: "main",
        terminalState: "failure",
        durationSeconds: 45,
      });

      await dispatcher.dispatch("PipelineCompletedEvent", event.correlationId, event);

      expect(deployment.dispatch).not.toHaveBeenCalled();
    });

    it("DeploymentCommand carries correlationId from originating event (Req 8.4)", async () => {
      const { dispatcher, deployment } = makeDispatcher();
      const corrId = "corr-completed-123";
      const event = makeEvent("PipelineCompletedEvent", {
        correlationId: corrId,
        pipelineRunId: "run-success",
        terminalState: "success",
        durationSeconds: 60,
      });

      await dispatcher.dispatch("PipelineCompletedEvent", corrId, event);

      const cmd = deployment.dispatch.mock.calls[0][0];
      expect(cmd.correlationId).toBe(corrId);
    });
  });

  // ── Deployment events → Notification ──────────────────────────────────

  describe("DeploymentSuccessEvent → Notification_Agent", () => {
    it("routes DeploymentSuccessEvent to Notification_Agent", async () => {
      const { dispatcher, notification, deployment } = makeDispatcher();
      const event = makeEvent("DeploymentSuccessEvent", {
        deploymentName: "crm-api",
        namespace: "production",
      });

      await dispatcher.dispatch("DeploymentSuccessEvent", event.correlationId, event);

      expect(notification.dispatch).toHaveBeenCalledTimes(1);
      expect(deployment.dispatch).not.toHaveBeenCalled();
    });

    it("NotifyCommand has outcome = 'success' for DeploymentSuccessEvent", async () => {
      const { dispatcher, notification } = makeDispatcher();
      const event = makeEvent("DeploymentSuccessEvent", {
        deploymentName: "crm-api",
        namespace: "production",
      });

      await dispatcher.dispatch("DeploymentSuccessEvent", event.correlationId, event);

      const cmd = notification.dispatch.mock.calls[0][0];
      expect(cmd.outcome).toBe("success");
    });
  });

  describe("RollbackEvent → Notification_Agent", () => {
    it("routes RollbackEvent to Notification_Agent", async () => {
      const { dispatcher, notification } = makeDispatcher();
      const event = makeEvent("RollbackEvent", {
        deploymentName: "crm-api",
        namespace: "production",
        reason: "rollout timeout",
      });

      await dispatcher.dispatch("RollbackEvent", event.correlationId, event);

      expect(notification.dispatch).toHaveBeenCalledTimes(1);
    });

    it("NotifyCommand has outcome = 'rollback' for RollbackEvent", async () => {
      const { dispatcher, notification } = makeDispatcher();
      const event = makeEvent("RollbackEvent", {
        deploymentName: "crm-api",
        namespace: "production",
        reason: "timeout",
      });

      await dispatcher.dispatch("RollbackEvent", event.correlationId, event);

      const cmd = notification.dispatch.mock.calls[0][0];
      expect(cmd.outcome).toBe("rollback");
    });
  });

  describe("IncidentEscalationEvent → Notification_Agent", () => {
    it("routes IncidentEscalationEvent to Notification_Agent", async () => {
      const { dispatcher, notification } = makeDispatcher();
      const event = makeEvent("IncidentEscalationEvent", {
        incidentId: "inc-001",
        serviceName: "crm-api",
        reason: "no runbook",
        onCallHandle: "@alice",
      });

      await dispatcher.dispatch("IncidentEscalationEvent", event.correlationId, event);

      expect(notification.dispatch).toHaveBeenCalledTimes(1);
    });

    it("NotifyCommand carries the onCallHandle from IncidentEscalationEvent", async () => {
      const { dispatcher, notification } = makeDispatcher();
      const event = makeEvent("IncidentEscalationEvent", {
        incidentId: "inc-002",
        serviceName: "crm-api",
        reason: "runbook failed",
        onCallHandle: "@bob",
      });

      await dispatcher.dispatch("IncidentEscalationEvent", event.correlationId, event);

      const cmd = notification.dispatch.mock.calls[0][0];
      expect(cmd.onCallHandle).toBe("@bob");
    });
  });

  describe("CriticalFailureEvent → Notification_Agent", () => {
    it("routes CriticalFailureEvent to Notification_Agent", async () => {
      const { dispatcher, notification } = makeDispatcher();
      const event = makeEvent("CriticalFailureEvent", {
        deploymentName: "crm-api",
        namespace: "production",
        failureReason: "rollback timeout",
      });

      await dispatcher.dispatch("CriticalFailureEvent", event.correlationId, event);

      expect(notification.dispatch).toHaveBeenCalledTimes(1);
    });
  });

  // ── Unknown event type ───────────────────────────────────────────────

  describe("unknown event type", () => {
    it("does not dispatch to any agent for unknown event type", async () => {
      const { dispatcher, pipeline, deployment, incident, notification } = makeDispatcher();
      const event = makeEvent("AgentHealthDegradedEvent" as EventType, {
        agentType: "Pipeline_Agent",
        lastSeenAt: null,
      });

      await expect(
        dispatcher.dispatch("AgentHealthDegradedEvent" as EventType, event.correlationId, event)
      ).resolves.not.toThrow();

      expect(pipeline.dispatch).not.toHaveBeenCalled();
      expect(deployment.dispatch).not.toHaveBeenCalled();
      expect(incident.dispatch).not.toHaveBeenCalled();
      expect(notification.dispatch).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// EventIngester tests
// ---------------------------------------------------------------------------

describe("EventIngester", () => {
  it("assigns a correlationId when event.correlationId is empty", async () => {
    const received: string[] = [];
    const ingester = new EventIngester(
      async (_type, corrId) => { received.push(corrId); },
      silentLogger()
    );

    await ingester.ingest({
      eventId: uuidv4(),
      correlationId: "",
      eventType: "PipelineTriggeredEvent",
      source: "external",
      timestamp: new Date().toISOString(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].length).toBeGreaterThan(0);
  });

  it("preserves existing correlationId from inbound event", async () => {
    const corrId = "existing-corr-id-abc";
    const received: string[] = [];
    const ingester = new EventIngester(
      async (_type, cid) => { received.push(cid); },
      silentLogger()
    );

    await ingester.ingest({
      eventId: uuidv4(),
      correlationId: corrId,
      eventType: "PipelineTriggeredEvent",
      source: "Pipeline_Agent",
      timestamp: new Date().toISOString(),
    });

    expect(received[0]).toBe(corrId);
  });

  it("calls the route function with the correct eventType", async () => {
    const routeFn = jest.fn().mockResolvedValue(undefined);
    const ingester = new EventIngester(routeFn, silentLogger());

    await ingester.ingest({
      eventId: uuidv4(),
      correlationId: uuidv4(),
      eventType: "DeploymentSuccessEvent",
      source: "Deployment_Agent",
      timestamp: new Date().toISOString(),
    });

    expect(routeFn).toHaveBeenCalledWith(
      "DeploymentSuccessEvent",
      expect.any(String),
      expect.any(Object)
    );
  });

  it("does not throw when the route function throws", async () => {
    const routeFn = jest.fn().mockRejectedValue(new Error("routing failed"));
    const ingester = new EventIngester(routeFn, silentLogger());

    await expect(ingester.ingest({
      eventId: uuidv4(),
      correlationId: uuidv4(),
      eventType: "PipelineTriggerFailedEvent",
      source: "external",
      timestamp: new Date().toISOString(),
    })).resolves.not.toThrow();
  });
});
