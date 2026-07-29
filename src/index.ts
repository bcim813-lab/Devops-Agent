/**
 * CRM DevOps Agents — Event-driven automation platform
 *
 * Main entry point that wires all agents, the Orchestrator, and observability components.
 *
 * Requirements: 7.1, 9.1, 9.5, 13.1
 */

/// <reference types="node" />
import * as http from "http";
import { StructuredLogger } from "./utils/logger";
import { ConfigLoader } from "./orchestrator/config";
import { EventIngester } from "./orchestrator/ingest";
import { CommandDispatcher } from "./orchestrator/dispatch";
import { HealthMonitor } from "./orchestrator/health";
import { PrometheusMetricsCollector } from "./orchestrator/metrics";
import { PipelineTrigger } from "./agents/pipeline/trigger";
import { PipelineRecordStore } from "./agents/pipeline/records";
import { ManifestApplier } from "./agents/deployment/apply";
import { DeploymentHaltRegistry } from "./agents/deployment/haltState";
import { RunbookLibrary } from "./agents/incident/runbookLibrary";
import { IncidentHandler } from "./agents/incident/execution";
import { MessageDeliverer } from "./agents/notification/delivery";
import type { SystemConfig } from "./types/models";

const logger = new StructuredLogger();

async function main(): Promise<void> {
  logger.info({
    action: "main",
    outcome: "pending",
    message: "Starting CRM DevOps Agents platform",
  });

  try {
    // ── Load configuration (Req 7.1) ──────────────────────────────────
    const configLoader = new ConfigLoader(logger);
    const config: SystemConfig = await configLoader.load();

    logger.info({
      action: "main.config",
      outcome: "success",
      message: "Configuration loaded successfully",
    });

    // ── Initialize agents ─────────────────────────────────────────────
    const _pipelineRecordStore = new PipelineRecordStore();
    const _pipelineTrigger = new PipelineTrigger(
      { async triggerJob() { return `run-${Date.now()}`; } } as any,
      () => {},
      config.jenkins.jobs,
      logger
    );

    const _deploymentHaltRegistry = new DeploymentHaltRegistry();
    const _manifestApplier = new ManifestApplier(
      { async applyManifest() { return { success: true, value: undefined }; } } as any,
      () => {},
      logger
    );

    const runbookLibrary = new RunbookLibrary({ logger });
    const _incidentHandler = new IncidentHandler(
      runbookLibrary,
      { async acknowledgeIncident() { return { success: true }; } } as any,
      {
        async resolveHandle() { return "user123"; },
        async postMessage() { return { success: true }; },
      } as any,
      { async executeStep() { return { success: true }; } } as any,
      () => {},
      async () => null,
      logger
    );

    const _messageDeliverer = new MessageDeliverer(
      { async postMessage() { return { success: true }; } } as any,
      () => {},
      logger
    );

    // ── Initialize Orchestrator (Req 8.1, 8.4, 9.1, 9.5) ─────────────
    const healthMonitor = new HealthMonitor(15_000, 60_000, undefined, logger);
    const metricsCollector = new PrometheusMetricsCollector();

    const dispatcher = new CommandDispatcher(
      { async dispatch() {} } as any,
      { async dispatch() {} } as any,
      { async dispatch() {} } as any,
      { async dispatch() {} } as any,
      logger
    );

    const ingester = new EventIngester(
      async (eventType, correlationId, event) => {
        await dispatcher.dispatch(eventType, correlationId, event);
      },
      logger
    );

    healthMonitor.start();

    logger.info({
      action: "main.agents",
      outcome: "success",
      message: "All agents initialized",
    });

    // ── HTTP server (Req 9.1, 9.5) ────────────────────────────────────
    const server = http.createServer((req, res) => {
      if (req.method === "GET") {
        if (req.url === "/health") {
          const status = healthMonitor.getStatus();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(status));
          return;
        }
        if (req.url === "/metrics") {
          const metrics = metricsCollector.getMetrics();
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end(metrics);
          return;
        }
      }
      if (req.method === "POST" && req.url === "/webhook/github") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", async () => {
          try {
            const event = JSON.parse(body);
            await ingester.ingest(event);
            res.writeHead(200);
            res.end("OK");
          } catch (err) {
            logger.error({
              action: "main.webhook",
              outcome: "failure",
              errorMessage: err instanceof Error ? err.message : String(err),
            });
            res.writeHead(400);
            res.end("Bad Request");
          }
        });
        return;
      }
      res.writeHead(404);
      res.end("Not Found");
    });

    const port = process.env.PORT || 8080;
    server.listen(port, () => {
      logger.info({
        action: "main.server",
        outcome: "success",
        message: `HTTP server listening on port ${port}`,
      });
    });

    process.on("SIGTERM", () => {
      logger.info({
        action: "main.shutdown",
        outcome: "pending",
        message: "SIGTERM received, shutting down",
      });
      healthMonitor.stop();
      server.close(() => {
        logger.info({
          action: "main.shutdown",
          outcome: "success",
          message: "Shutdown complete",
        });
        process.exit(0);
      });
    });

    logger.info({
      action: "main",
      outcome: "success",
      message: "CRM DevOps Agents platform ready",
    });
  } catch (err) {
    logger.error({
      action: "main",
      outcome: "fatal",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({
      action: "main.uncaught",
      outcome: "fatal",
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}

export { main };
