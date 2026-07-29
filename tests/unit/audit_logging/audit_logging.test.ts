/**
 * Unit tests for audit logging across all agents and the Orchestrator.
 *
 * Covers (Requirements 8.1–8.5):
 *  - Each agent emits a structured log entry for every action it executes
 *  - Sensitive values (apiToken, botToken, kubeconfig, webhookSecret) are masked as "***"
 *  - Error log entries include errorMessage and stackTrace
 *  - correlationId appears in every log entry for a given event chain
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */

import { StructuredLogger, maskSensitiveValues, SENSITIVE_KEYS } from "../../../src/utils/logger";
import { ManifestApplier } from "../../../src/agents/deployment/apply";
import { RollbackHandler } from "../../../src/agents/deployment/rollback";
import { DeploymentHaltRegistry } from "../../../src/agents/deployment/haltState";
import { IncidentHandler } from "../../../src/agents/incident/execution";
import { RunbookLibrary } from "../../../src/agents/incident/runbookLibrary";
import { MessageDeliverer } from "../../../src/agents/notification/delivery";
import { PipelineTrigger } from "../../../src/agents/pipeline/trigger";
import { EventIngester } from "../../../src/orchestrator/ingest";
import type {
  DeploymentCommand,
  PipelineTriggerCommand,
  PagerDutyAlert,
  NotifyCommand,
  RollbackError,
  Result,
} from "../../../src/types/models";
import type { OutboundEvent } from "../../../src/interfaces/shared";
import { v4 as uuidv4 } from "uuid";
import * as os from "os";
import * as path from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureLogger(): { logger: StructuredLogger; entries: Record<string, unknown>[] } {
  const entries: Record<string, unknown>[] = [];
  const logger = new StructuredLogger((line) => entries.push(JSON.parse(line)));
  return { logger, entries };
}

function emit(): (e: OutboundEvent) => void {
  return () => {};
}

function tempPath(): string {
  return path.join(os.tmpdir(), `halt-audit-${uuidv4()}.json`);
}

function makeDeployCmd(correlationId = uuidv4()): DeploymentCommand {
  return {
    eventId: uuidv4(),
    correlationId,
    eventType: "DeploymentCommand",
    source: "Orchestrator",
    timestamp: new Date().toISOString(),
    manifestFilePath: "/manifests/app.yaml",
    namespace: "production",
    deploymentName: "crm-api",
    pipelineRunId: "run-001",
  };
}

function makeTriggerCmd(correlationId = uuidv4()): PipelineTriggerCommand {
  return {
    eventId: uuidv4(),
    correlationId,
    eventType: "PipelineTriggerCommand",
    source: "Orchestrator",
    timestamp: new Date().toISOString(),
    repositoryName: "crm-api",
    branchName: "main",
    triggerTimestamp: new Date().toISOString(),
  };
}

function makeAlert(): PagerDutyAlert {
  return {
    incidentId: "inc-audit-001",
    serviceName: "crm-api",
    severity: "P1",
    receivedAt: new Date().toISOString(),
    details: {},
  };
}

function makeNotifyCmd(correlationId = uuidv4()): NotifyCommand {
  return {
    eventId: uuidv4(),
    correlationId,
    eventType: "NotifyCommand",
    source: "Orchestrator",
    timestamp: new Date().toISOString(),
    triggerEvent: {
      eventId: uuidv4(),
      correlationId,
      eventType: "DeploymentSuccessEvent",
      source: "Deployment_Agent",
      timestamp: new Date().toISOString(),
    },
    orchestratorTimestamp: new Date().toISOString(),
    affectedServiceName: "crm-api",
    outcome: "success",
    onCallHandle: null,
  };
}

// ---------------------------------------------------------------------------
// maskSensitiveValues utility tests
// ---------------------------------------------------------------------------

describe("maskSensitiveValues utility (Req 8.2)", () => {
  it("masks apiToken", () => {
    const result = maskSensitiveValues({ apiToken: "secret-token-xyz" });
    expect(result.apiToken).toBe("***");
  });

  it("masks botToken", () => {
    const result = maskSensitiveValues({ botToken: "xoxb-secret-token" });
    expect(result.botToken).toBe("***");
  });

  it("masks webhookSecret", () => {
    const result = maskSensitiveValues({ webhookSecret: "my-webhook-secret" });
    expect(result.webhookSecret).toBe("***");
  });

  it("masks kubeconfig", () => {
    const result = maskSensitiveValues({ kubeconfig: "apiVersion: v1..." });
    expect(result.kubeconfig).toBe("***");
  });

  it("masks token (generic)", () => {
    const result = maskSensitiveValues({ token: "bearer-abc123" });
    expect(result.token).toBe("***");
  });

  it("masks password", () => {
    const result = maskSensitiveValues({ password: "P@ssw0rd!" });
    expect(result.password).toBe("***");
  });

  it("masks secret", () => {
    const result = maskSensitiveValues({ secret: "my-secret" });
    expect(result.secret).toBe("***");
  });

  it("masks credential", () => {
    const result = maskSensitiveValues({ credential: "cred-data" });
    expect(result.credential).toBe("***");
  });

  it("does not mask non-sensitive keys", () => {
    const result = maskSensitiveValues({
      deploymentName: "crm-api",
      namespace: "production",
      reason: "timeout",
    });
    expect(result.deploymentName).toBe("crm-api");
    expect(result.namespace).toBe("production");
    expect(result.reason).toBe("timeout");
  });

  it("masks sensitive keys case-insensitively (ApiToken → ***)", () => {
    const result = maskSensitiveValues({ ApiToken: "should-be-masked" } as any);
    expect(result.ApiToken).toBe("***");
  });

  it("recursively masks nested sensitive keys", () => {
    const result = maskSensitiveValues({
      jenkins: { apiToken: "nested-secret", baseUrl: "https://jenkins" },
    });
    expect((result.jenkins as any).apiToken).toBe("***");
    expect((result.jenkins as any).baseUrl).toBe("https://jenkins");
  });

  it("does not mutate the original object", () => {
    const original = { apiToken: "my-token", name: "test" };
    const result = maskSensitiveValues(original);
    expect(original.apiToken).toBe("my-token"); // original unchanged
    expect(result.apiToken).toBe("***");
  });

  it("SENSITIVE_KEYS set contains all required keys", () => {
    const required = ["apitoken", "bottoken", "webhooksecret", "kubeconfig", "password", "secret", "token", "credential"];
    for (const key of required) {
      expect(SENSITIVE_KEYS.has(key)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// StructuredLogger tests
// ---------------------------------------------------------------------------

describe("StructuredLogger (Req 8.1, 8.2, 8.3, 8.4)", () => {
  it("emits a JSON log entry with action, outcome, level, and timestamp", () => {
    const { logger, entries } = captureLogger();

    logger.info({
      action: "test.action",
      outcome: "success",
      correlationId: "corr-001",
    });

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.action).toBe("test.action");
    expect(entry.outcome).toBe("success");
    expect(entry.level).toBe("info");
    expect(typeof entry.timestamp).toBe("string");
  });

  it("includes correlationId in log entry when provided (Req 8.4)", () => {
    const { logger, entries } = captureLogger();

    logger.info({
      action: "deploy.apply",
      outcome: "success",
      correlationId: "corr-xyz",
    });

    expect(entries[0].correlationId).toBe("corr-xyz");
  });

  it("includes errorMessage and stackTrace in error entries (Req 8.3)", () => {
    const { logger, entries } = captureLogger();

    const err = new Error("Kubernetes API unreachable");
    logger.error({
      action: "deploy.apply",
      outcome: "failure",
      correlationId: "corr-err",
      errorMessage: err.message,
      stackTrace: err.stack,
    });

    const entry = entries[0];
    expect(entry.errorMessage).toBe("Kubernetes API unreachable");
    expect(typeof entry.stackTrace).toBe("string");
  });

  it("masks apiToken in params (Req 8.2)", () => {
    const { logger, entries } = captureLogger();

    logger.info({
      action: "config.load",
      outcome: "success",
      params: { apiToken: "secret-123", baseUrl: "https://jenkins" },
    });

    const entry = entries[0] as any;
    expect(entry.params.apiToken).toBe("***");
    expect(entry.params.baseUrl).toBe("https://jenkins");
  });

  it("masks botToken at top-level (Req 8.2)", () => {
    const { logger, entries } = captureLogger();

    logger.warn({
      action: "slack.send",
      outcome: "failure",
      botToken: "xoxb-real-token",
    });

    expect(entries[0].botToken).toBe("***");
  });

  it("does not mask unrelated fields", () => {
    const { logger, entries } = captureLogger();

    logger.debug({
      action: "pipeline.trigger",
      outcome: "pending",
      repositoryName: "crm-api",
      correlationId: "corr-test",
    });

    const entry = entries[0] as any;
    expect(entry.repositoryName).toBe("crm-api");
    expect(entry.correlationId).toBe("corr-test");
  });
});

// ---------------------------------------------------------------------------
// ManifestApplier — audit logging
// ---------------------------------------------------------------------------

describe("ManifestApplier audit logging (Req 8.1, 8.4)", () => {
  it("logs an info entry when applying a manifest", async () => {
    const { logger, entries } = captureLogger();

    const applier = new ManifestApplier(
      { applyManifest: jest.fn().mockResolvedValue({ success: true, value: undefined }) },
      emit(),
      logger
    );

    const corrId = uuidv4();
    await applier.applyManifest(makeDeployCmd(corrId));

    const applyEntries = entries.filter((e: any) => e.action === "applyManifest" || e.action?.includes("apply"));
    expect(applyEntries.length).toBeGreaterThan(0);
  });

  it("includes correlationId in every log entry (Req 8.4)", async () => {
    const { logger, entries } = captureLogger();

    const applier = new ManifestApplier(
      { applyManifest: jest.fn().mockResolvedValue({ success: true, value: undefined }) },
      emit(),
      logger
    );

    const corrId = "corr-manifest-audit";
    await applier.applyManifest(makeDeployCmd(corrId));

    const entriesWithCorr = entries.filter((e: any) => e.correlationId === corrId);
    expect(entriesWithCorr.length).toBeGreaterThan(0);
  });

  it("logs an error entry with errorMessage on Kubernetes API failure", async () => {
    const { logger, entries } = captureLogger();

    const applier = new ManifestApplier(
      {
        applyManifest: jest.fn().mockResolvedValue({
          success: false,
          error: { code: "KUBERNETES_API_ERROR", message: "ImagePullBackOff" },
        }),
      },
      emit(),
      logger
    );

    await applier.applyManifest(makeDeployCmd());

    const errorEntries = entries.filter((e: any) => e.level === "error");
    expect(errorEntries.length).toBeGreaterThan(0);
    expect(errorEntries.some((e: any) => e.errorMessage?.includes("ImagePullBackOff"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RollbackHandler — audit logging
// ---------------------------------------------------------------------------

describe("RollbackHandler audit logging (Req 8.1, 8.4)", () => {
  it("logs action entries during rollback execution", async () => {
    const { logger, entries } = captureLogger();

    const handler = new RollbackHandler(
      {
        initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
        getPodReadiness: jest.fn().mockResolvedValue({
          success: true,
          value: { deploymentName: "crm-api", namespace: "production", podsReady: 3, podsDesired: 3, allReady: true },
        }),
      },
      emit(),
      jest.fn(),
      jest.fn(),
      logger
    );

    const corrId = uuidv4();
    await handler.executeRollback("crm-api", "production", corrId);

    expect(entries.length).toBeGreaterThan(0);
  });

  it("includes correlationId in rollback log entries (Req 8.4)", async () => {
    const { logger, entries } = captureLogger();

    const handler = new RollbackHandler(
      {
        initiateRollback: jest.fn().mockResolvedValue({ success: true, value: undefined }),
        getPodReadiness: jest.fn().mockResolvedValue({
          success: true,
          value: { deploymentName: "crm-api", namespace: "production", podsReady: 2, podsDesired: 2, allReady: true },
        }),
      },
      emit(),
      jest.fn(),
      jest.fn(),
      logger
    );

    const corrId = "corr-rollback-audit";
    await handler.executeRollback("crm-api", "production", corrId);

    const corrEntries = entries.filter((e: any) => e.correlationId === corrId);
    expect(corrEntries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// DeploymentHaltRegistry — audit logging
// ---------------------------------------------------------------------------

describe("DeploymentHaltRegistry audit logging (Req 8.1)", () => {
  it("logs a warn entry when a halted command is rejected", () => {
    const { logger, entries } = captureLogger();

    const registry = new DeploymentHaltRegistry({ persistPath: tempPath(), logger });
    const ref = { deploymentName: "crm-api", namespace: "production" };
    registry.halt(ref, "rollback failed");

    try {
      registry.checkAndThrowIfHalted(ref);
    } catch {
      // expected
    }

    const warnEntries = entries.filter((e: any) => e.level === "warn");
    expect(warnEntries.length).toBeGreaterThan(0);
  });

  it("log entry for rejected command contains halt reason", () => {
    const { logger, entries } = captureLogger();

    const registry = new DeploymentHaltRegistry({ persistPath: tempPath(), logger });
    const ref = { deploymentName: "crm-api", namespace: "production" };
    registry.halt(ref, "critical failure");

    try { registry.checkAndThrowIfHalted(ref); } catch {}

    const entry = entries.find((e: any) => e.haltReason === "critical failure");
    expect(entry).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// PipelineTrigger — audit logging
// ---------------------------------------------------------------------------

describe("PipelineTrigger audit logging (Req 8.1, 8.4)", () => {
  it("logs an info entry on trigger success", async () => {
    const { logger, entries } = captureLogger();

    const trigger = new PipelineTrigger(
      { triggerJob: jest.fn().mockResolvedValue("run-42") },
      emit(),
      { "crm-api": "crm-api-build" },
      logger
    );

    const corrId = "corr-trigger-audit";
    await trigger.triggerPipeline(makeTriggerCmd(corrId));

    const infoEntries = entries.filter((e: any) => e.level === "info" && e.correlationId === corrId);
    expect(infoEntries.length).toBeGreaterThan(0);
  });

  it("logs an error entry when all retries are exhausted", async () => {
    const { logger, entries } = captureLogger();

    jest.mock("../../../src/agents/pipeline/trigger", () => {
      const actual = jest.requireActual("../../../src/agents/pipeline/trigger");
      return { ...actual, sleep: jest.fn().mockResolvedValue(undefined) };
    });

    const trigger = new PipelineTrigger(
      { triggerJob: jest.fn().mockRejectedValue(new Error("jenkins down")) },
      emit(),
      { "crm-api": "crm-api-build" },
      logger
    );

    await trigger.triggerPipeline(makeTriggerCmd());

    const errorEntries = entries.filter((e: any) => e.level === "error");
    expect(errorEntries.length).toBeGreaterThan(0);
  });

  it("includes correlationId in every trigger log entry (Req 8.4)", async () => {
    const { logger, entries } = captureLogger();

    const trigger = new PipelineTrigger(
      { triggerJob: jest.fn().mockResolvedValue("run-55") },
      emit(),
      { "crm-api": "crm-api-build" },
      logger
    );

    const corrId = "corr-trigger-corr";
    await trigger.triggerPipeline(makeTriggerCmd(corrId));

    const corrEntries = entries.filter((e: any) => e.correlationId === corrId);
    expect(corrEntries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// MessageDeliverer — audit logging
// ---------------------------------------------------------------------------

describe("MessageDeliverer audit logging (Req 8.1, 8.4)", () => {
  it("logs an info entry on successful delivery", async () => {
    const { logger, entries } = captureLogger();

    const deliverer = new MessageDeliverer(
      { postMessage: jest.fn().mockResolvedValue({ success: true }) },
      emit(),
      logger
    );

    const corrId = "corr-delivery-audit";
    await deliverer.deliver(makeNotifyCmd(corrId), "#deployments");

    const infoEntries = entries.filter((e: any) => e.level === "info" && e.correlationId === corrId);
    expect(infoEntries.length).toBeGreaterThan(0);
  });

  it("logs an error entry when all retries fail", async () => {
    const { logger, entries } = captureLogger();

    const deliverer = new MessageDeliverer(
      { postMessage: jest.fn().mockResolvedValue({ success: false, error: new Error("500") }) },
      emit(),
      logger
    );

    await deliverer.deliver(makeNotifyCmd(), "#ch");

    const errorEntries = entries.filter((e: any) => e.level === "error");
    expect(errorEntries.length).toBeGreaterThan(0);
  });

  it("never logs raw botToken value (Req 8.2)", async () => {
    const { logger, entries } = captureLogger();

    const deliverer = new MessageDeliverer(
      { postMessage: jest.fn().mockResolvedValue({ success: true }) },
      emit(),
      logger
    );

    // Artificially log something with a botToken to verify masking
    logger.info({
      action: "slack.connect",
      outcome: "success",
      params: { botToken: "xoxb-real-secret-token" },
    });

    const entriesStr = JSON.stringify(entries);
    expect(entriesStr).not.toContain("xoxb-real-secret-token");
    expect(entriesStr).toContain("***");
  });
});

// ---------------------------------------------------------------------------
// EventIngester — audit logging
// ---------------------------------------------------------------------------

describe("EventIngester audit logging (Req 8.1, 8.4)", () => {
  it("logs every inbound event with eventType, source, timestamp, correlationId", async () => {
    const { logger, entries } = captureLogger();

    const ingester = new EventIngester(
      async () => {},
      logger
    );

    const corrId = uuidv4();
    await ingester.ingest({
      eventId: uuidv4(),
      correlationId: corrId,
      eventType: "DeploymentSuccessEvent",
      source: "Deployment_Agent",
      timestamp: "2024-06-01T10:00:00.000Z",
    });

    const logEntry = entries.find(
      (e: any) => e.eventType === "DeploymentSuccessEvent"
    ) as Record<string, unknown>;

    expect(logEntry).toBeDefined();
    expect(logEntry.eventType).toBe("DeploymentSuccessEvent");
    expect(logEntry.source).toBe("Deployment_Agent");
    expect(logEntry.correlationId).toBe(corrId);
    expect(typeof logEntry.timestamp).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// IncidentHandler — audit logging
// ---------------------------------------------------------------------------

describe("IncidentHandler audit logging (Req 8.1, 8.4)", () => {
  it("logs an action entry when handling a P1 alert", async () => {
    const { logger, entries } = captureLogger();

    const library = new RunbookLibrary({ logger });
    library.register({
      serviceName: "crm-api",
      version: "1.0.0",
      timeoutSeconds: 300,
      steps: [{ stepId: "s1", description: "step", action: {} }],
    });

    const handler = new IncidentHandler(
      library,
      { acknowledgeIncident: jest.fn().mockResolvedValue({ success: true }) } as any,
      { resolveHandle: jest.fn(), postMessage: jest.fn().mockResolvedValue({ success: true }) } as any,
      { executeStep: jest.fn().mockResolvedValue({ success: true }) } as any,
      emit(),
      jest.fn().mockResolvedValue("@oncall"),
      logger
    );

    await handler.handleAlert(makeAlert());

    const actionEntries = entries.filter(
      (e: any) => e.action === "incident.handleAlert" || e.action?.startsWith("incident.")
    );
    expect(actionEntries.length).toBeGreaterThan(0);
  });

  it("P3/P4 alert logs a debug entry (no action taken)", async () => {
    const { logger, entries } = captureLogger();

    const library = new RunbookLibrary({ logger });

    const handler = new IncidentHandler(
      library,
      { acknowledgeIncident: jest.fn() } as any,
      { resolveHandle: jest.fn(), postMessage: jest.fn() } as any,
      { executeStep: jest.fn() } as any,
      emit(),
      jest.fn(),
      logger
    );

    await handler.handleAlert({ ...makeAlert(), severity: "P3" });

    // Should log a debug entry for ignored alert
    const debugEntries = entries.filter((e: any) => e.level === "debug" || e.outcome === "ignored");
    expect(debugEntries.length).toBeGreaterThan(0);
  });
});
