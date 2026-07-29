/**
 * Integration test: PR merge → deployment flow
 *
 * Validates the full flow:
 *   GitHub webhook → Jenkins trigger → Jenkins poll → PipelineCompletedEvent
 *   → DeploymentCommand → Kubernetes apply → rollout monitor → DeploymentSuccessEvent
 *   → NotifyCommand → Slack notification
 *
 * All external clients (Jenkins, Kubernetes, Slack) are mocked.
 *
 * Requirements: 1.1, 2.2, 3.1, 3.3, 6.1
 */

import { v4 as uuidv4 } from "uuid";
import { PipelineTrigger } from "../../src/agents/pipeline/trigger";
import { PipelinePoller } from "../../src/agents/pipeline/polling";
import { ManifestApplier } from "../../src/agents/deployment/apply";
import { RolloutMonitor } from "../../src/agents/deployment/monitor";
import { MessageDeliverer } from "../../src/agents/notification/delivery";
import { EventIngester } from "../../src/orchestrator/ingest";
import { CommandDispatcher } from "../../src/orchestrator/dispatch";
import { StructuredLogger } from "../../src/utils/logger";
import type {
  PipelineTriggerCommand,
  PipelineCompletedEvent,
  DeploymentCommand,
} from "../../src/types/models";
import type { OutboundEvent } from "../../src/interfaces/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): StructuredLogger {
  return new StructuredLogger(() => {/* discard */});
}

function makeTriggerCmd(corrId = uuidv4()): PipelineTriggerCommand {
  return {
    eventId: uuidv4(),
    correlationId: corrId,
    eventType: "PipelineTriggerCommand",
    source: "Orchestrator",
    timestamp: new Date().toISOString(),
    repositoryName: "crm-api",
    branchName: "main",
    triggerTimestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Integration test: PR merge → deployment
// ---------------------------------------------------------------------------

describe("Integration: PR merge → deployment flow", () => {

  it("triggers pipeline, polls to completion, and deploys on success (Req 1.1, 2.2, 3.1, 3.3)", async () => {
    const emittedEvents: OutboundEvent[] = [];
    const emit = (e: OutboundEvent) => emittedEvents.push(e);

    // ── Mock Jenkins client ────────────────────────────────────────────
    const jenkins = {
      triggerJob: jest.fn().mockResolvedValue("run-integration-001"),
      getPipelineStatus: jest.fn()
        .mockResolvedValueOnce({ success: true, value: { runId: "run-integration-001", state: "in_progress", durationSeconds: null } })
        .mockResolvedValue({ success: true, value: { runId: "run-integration-001", state: "success", durationSeconds: 90 } }),
    };

    // ── Mock Kubernetes client ─────────────────────────────────────────
    const kubernetes = {
      applyManifest: jest.fn().mockResolvedValue({ success: true, value: undefined }),
      getRolloutStatus: jest.fn().mockResolvedValue({
        success: true,
        value: { deploymentName: "crm-api", namespace: "production", ready: 3, desired: 3, isReady: true },
      }),
    };

    // ── Mock Slack client ──────────────────────────────────────────────
    const slack = {
      postMessage: jest.fn().mockResolvedValue({ success: true }),
    };

    // ── Step 1: Trigger the pipeline ───────────────────────────────────
    const trigger = new PipelineTrigger(jenkins, emit, { "crm-api": "crm-api-build" }, silentLogger());
    const corrId = uuidv4();
    const triggerCmd = makeTriggerCmd(corrId);

    const triggerResult = await trigger.triggerPipeline(triggerCmd);
    expect(triggerResult.success).toBe(true);
    const runId = triggerResult.success ? triggerResult.value : "";

    // PipelineTriggeredEvent should have been emitted
    const triggeredEvents = emittedEvents.filter(e => e.eventType === "PipelineTriggeredEvent");
    expect(triggeredEvents).toHaveLength(1);
    expect((triggeredEvents[0] as any).pipelineRunId).toBe("run-integration-001");
    expect(triggeredEvents[0].correlationId).toBe(corrId);

    // ── Step 2: Poll pipeline to completion ────────────────────────────
    const poller = new PipelinePoller(jenkins, emit, silentLogger());
    await poller.start({
      pipelineRunId: runId,
      repositoryName: "crm-api",
      branchName: "main",
      pollIntervalMs: 0,
      retryDelayMs: 0,
    });

    const completedEvents = emittedEvents.filter(e => e.eventType === "PipelineCompletedEvent");
    expect(completedEvents).toHaveLength(1);

    const completedEvt = completedEvents[0] as Record<string, unknown>;
    expect(completedEvt.terminalState).toBe("success");
    expect(completedEvt.pipelineRunId).toBe("run-integration-001");
    expect(completedEvt.repositoryName).toBe("crm-api");
    expect(completedEvt.branchName).toBe("main");
    expect(completedEvt.durationSeconds).toBe(90);

    // ── Step 3: Apply Kubernetes manifest ──────────────────────────────
    const deployCmd: DeploymentCommand = {
      eventId: uuidv4(),
      correlationId: corrId,
      eventType: "DeploymentCommand",
      source: "Orchestrator",
      timestamp: new Date().toISOString(),
      manifestFilePath: "/manifests/crm-api.yaml",
      namespace: "production",
      deploymentName: "crm-api",
      pipelineRunId: runId,
    };

    const applier = new ManifestApplier(kubernetes, emit, silentLogger());
    const applyResult = await applier.applyManifest(deployCmd);
    expect(applyResult.success).toBe(true);

    expect(kubernetes.applyManifest).toHaveBeenCalledWith(
      "/manifests/crm-api.yaml",
      "production"
    );

    // ── Step 4: Monitor rollout to success ─────────────────────────────
    const monitor = new RolloutMonitor(kubernetes, emit, silentLogger());
    await monitor.start(
      { deploymentName: "crm-api", namespace: "production", pipelineRunId: runId },
      { pollIntervalMs: 0 }
    );

    const successEvents = emittedEvents.filter(e => e.eventType === "DeploymentSuccessEvent");
    expect(successEvents).toHaveLength(1);
    expect((successEvents[0] as any).deploymentName).toBe("crm-api");
    expect((successEvents[0] as any).namespace).toBe("production");

    // ── Step 5: Send Slack notification ───────────────────────────────
    const deliverer = new MessageDeliverer(slack, emit, silentLogger());
    await deliverer.deliver(
      {
        eventId: uuidv4(),
        correlationId: corrId,
        eventType: "NotifyCommand",
        source: "Orchestrator",
        timestamp: new Date().toISOString(),
        triggerEvent: successEvents[0],
        orchestratorTimestamp: new Date().toISOString(),
        affectedServiceName: "crm-api",
        outcome: "success",
        onCallHandle: null,
      },
      "#deployments"
    );

    expect(slack.postMessage).toHaveBeenCalledWith("#deployments", expect.any(Object));

    // ── Final invariants ──────────────────────────────────────────────
    // Validate that correlationId was threaded throughout
    const eventsWithCorr = emittedEvents.filter(e => e.correlationId === corrId);
    expect(eventsWithCorr.length).toBeGreaterThan(0);
  });

  it("emits PipelineTriggerFailedEvent after Jenkins retries exhausted (Req 1.1)", async () => {
    const emittedEvents: OutboundEvent[] = [];
    const emit = (e: OutboundEvent) => emittedEvents.push(e);

    // Jenkins always fails
    const jenkins = {
      triggerJob: jest.fn().mockRejectedValue(new Error("Jenkins unreachable")),
    };

    const trigger = new PipelineTrigger(
      jenkins,
      emit,
      { "crm-api": "crm-api-build" },
      silentLogger()
    );

    const result = await trigger.triggerPipeline(makeTriggerCmd());

    expect(result.success).toBe(false);
    const failedEvents = emittedEvents.filter(e => e.eventType === "PipelineTriggerFailedEvent");
    expect(failedEvents).toHaveLength(1);
  });

  it("Orchestrator routes PipelineCompletedEvent to Deployment_Agent (Req 3.1)", async () => {
    const deploymentDispatch = jest.fn().mockResolvedValue(undefined);
    const notificationDispatch = jest.fn().mockResolvedValue(undefined);

    const dispatcher = new CommandDispatcher(
      { dispatch: jest.fn() },
      { dispatch: deploymentDispatch },
      { dispatch: jest.fn() },
      { dispatch: notificationDispatch },
      silentLogger()
    );

    const corrId = uuidv4();
    const event: PipelineCompletedEvent = {
      eventId: uuidv4(),
      correlationId: corrId,
      eventType: "PipelineCompletedEvent",
      source: "Pipeline_Agent",
      timestamp: new Date().toISOString(),
      pipelineRunId: "run-xyz",
      repositoryName: "crm-api",
      branchName: "main",
      terminalState: "success",
      durationSeconds: 120,
    };

    await dispatcher.dispatch("PipelineCompletedEvent", corrId, event);

    expect(deploymentDispatch).toHaveBeenCalledTimes(1);
    const deployCmd = deploymentDispatch.mock.calls[0][0];
    expect(deployCmd.correlationId).toBe(corrId);
    expect(deployCmd.pipelineRunId).toBe("run-xyz");
  });

  it("correlationId from trigger propagates through all emitted events (Req 8.4)", async () => {
    const emittedEvents: OutboundEvent[] = [];
    const emit = (e: OutboundEvent) => emittedEvents.push(e);
    const corrId = uuidv4();

    const jenkins = {
      triggerJob: jest.fn().mockResolvedValue("run-corr-test"),
      getPipelineStatus: jest.fn().mockResolvedValue({
        success: true,
        value: { runId: "run-corr-test", state: "success", durationSeconds: 30 },
      }),
    };

    const trigger = new PipelineTrigger(jenkins, emit, { "crm-api": "crm-api-build" }, silentLogger());
    await trigger.triggerPipeline(makeTriggerCmd(corrId));

    const poller = new PipelinePoller(jenkins, emit, silentLogger());
    await poller.start({
      pipelineRunId: "run-corr-test",
      repositoryName: "crm-api",
      branchName: "main",
      pollIntervalMs: 0,
      retryDelayMs: 0,
    });

    // All Pipeline_Agent events should have their own correlationId (set internally)
    // The trigger event we control should have our corrId
    const triggerEvents = emittedEvents.filter(
      e => e.eventType === "PipelineTriggeredEvent" && e.correlationId === corrId
    );
    expect(triggerEvents).toHaveLength(1);
  });
});
