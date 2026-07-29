/**
 * Orchestrator interface — the central coordinator of the CRM DevOps Agents system.
 *
 * Responsibilities:
 * - Accept inbound events from external webhooks and internal agent emissions
 * - Assign UUID v4 correlation IDs on every inbound event before routing
 * - Route events/commands to the appropriate agent based on event type
 * - Manage agent health via heartbeats (every 15 s; unhealthy after 60 s silence)
 * - Expose /health and /metrics endpoints
 * - Load and hot-reload configuration from the versioned config store
 */

import type {
  AgentCommand,
  InboundEvent,
  OutboundEvent,
} from "./shared";
import type {
  AgentType,
  HealthStatus,
  MetricSnapshot,
  ConfigError,
  Result,
} from "../types/models";

export interface Orchestrator {
  /**
   * Accept an inbound event (from an external source or an agent).
   * Assigns a correlation ID if not already present, writes a structured log entry,
   * and routes the event to the appropriate agent.
   */
  ingest(event: InboundEvent): void;

  /**
   * Dispatch a command to a specific agent.
   * Forwards the correlationId from the originating event.
   */
  dispatch(command: AgentCommand, target: AgentType): void;

  /**
   * Emit an outbound event (e.g., from agent to Orchestrator).
   * The Orchestrator may route this to other agents.
   */
  emit(event: OutboundEvent): void;

  /**
   * Returns the current health snapshot for all connected agents.
   * Used by GET /health.
   */
  getHealth(): HealthStatus;

  /**
   * Returns the current metrics snapshot for all connected agents.
   * Used by GET /metrics.
   */
  getMetrics(): MetricSnapshot;

  /**
   * Trigger a configuration reload from the versioned config store.
   * On validation failure: retains previous valid config, logs each failing key.
   * On startup validation failure: the process exits non-zero (handled externally).
   */
  reloadConfig(): Result<void, ConfigError[]>;
}
