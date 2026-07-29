/**
 * Orchestrator health tracking and status reporting.
 *
 * Sends heartbeats to agents and tracks their responsiveness.
 * Exposes GET /health endpoint with current health status.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */

import { StructuredLogger } from "../utils/logger";
import type { HealthStatus, AgentHealthEntry, AgentHealthDegradedEvent, AgentType } from "../types/models";
import { v4 as uuidv4 } from "uuid";

export interface AgentHealthTracker {
  agentType: AgentType;
  lastHeartbeatAt: string | null;
  status: "healthy" | "unhealthy" | "unknown";
}

export type EmitHealthEventFn = (event: AgentHealthDegradedEvent) => void;

export class HealthMonitor {
  private readonly agents: Map<AgentType, AgentHealthTracker> = new Map();
  private readonly heartbeatIntervalMs: number;
  private readonly healthCheckTimeoutMs: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly emit: EmitHealthEventFn;
  private readonly logger: StructuredLogger;

  constructor(
    heartbeatIntervalMs: number = 15_000,
    healthCheckTimeoutMs: number = 60_000,
    emit?: EmitHealthEventFn,
    logger?: StructuredLogger
  ) {
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.healthCheckTimeoutMs = healthCheckTimeoutMs;
    this.emit = emit || (() => {});
    this.logger = logger ?? new StructuredLogger();
  }

  start(): void {
    this.logger.info({
      action: "healthMonitor.start",
      outcome: "pending",
    });

    const agentTypes: AgentType[] = [
      "Pipeline_Agent",
      "Deployment_Agent",
      "Incident_Agent",
      "Notification_Agent",
    ];

    for (const agentType of agentTypes) {
      this.agents.set(agentType, {
        agentType,
        lastHeartbeatAt: null,
        status: "unknown",
      });
    }

    this.heartbeatTimer = setInterval(() => this._checkHealth(), this.heartbeatIntervalMs);
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.logger.debug({
      action: "healthMonitor.stop",
      outcome: "success",
    });
  }

  recordHeartbeat(agentType: AgentType): void {
    const tracker = this.agents.get(agentType);
    if (!tracker) return;

    const now = new Date().toISOString();
    const wasUnhealthy = tracker.status === "unhealthy";

    tracker.lastHeartbeatAt = now;
    tracker.status = "healthy";

    if (wasUnhealthy) {
      this.logger.info({
        action: "healthMonitor.recovered",
        outcome: "success",
        agentType,
        recoveredAt: now,
      });
    }
  }

  getStatus(): HealthStatus {
    const agents: AgentHealthEntry[] = [];

    for (const [, tracker] of this.agents) {
      agents.push({
        agentType: tracker.agentType,
        status: tracker.status,
        lastHeartbeatAt: tracker.lastHeartbeatAt,
      });
    }

    return {
      agents,
      timestamp: new Date().toISOString(),
    };
  }

  private _checkHealth(): void {
    const now = Date.now();

    for (const [, tracker] of this.agents) {
      const lastHeartbeat = tracker.lastHeartbeatAt
        ? new Date(tracker.lastHeartbeatAt).getTime()
        : null;

      const elapsedMs = lastHeartbeat ? now - lastHeartbeat : Infinity;

      if (elapsedMs > this.healthCheckTimeoutMs) {
        if (tracker.status === "healthy" || tracker.status === "unknown") {
          tracker.status = "unhealthy";

          const degradedEvent: AgentHealthDegradedEvent = {
            eventId: uuidv4(),
            correlationId: uuidv4(),
            eventType: "AgentHealthDegradedEvent",
            source: "Orchestrator",
            timestamp: new Date().toISOString(),
            agentType: tracker.agentType,
            lastSeenAt: tracker.lastHeartbeatAt,
          };

          this.emit(degradedEvent);

          this.logger.warn({
            action: "healthMonitor.degraded",
            outcome: "unhealthy",
            agentType: tracker.agentType,
            lastHeartbeatAt: tracker.lastHeartbeatAt,
            elapsedMs,
          });
        }
      }
    }
  }
}
