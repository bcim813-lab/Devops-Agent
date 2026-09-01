/**
 * Orchestrator metrics collection and Prometheus export.
 *
 * Tracks per-agent metrics and exposes them in Prometheus text format.
 *
 * Requirements: 9.5
 */

import type { EventType, AgentType } from "../types/models";

/**
 * Per-agent metrics collection.
 */
export interface MetricsCollector {
  recordEvent(agentType: AgentType, eventType: EventType, success: boolean, latencyMs: number): void;
  getMetrics(): string;
}

/**
 * Simple in-memory metrics collector.
 *
 * Tracks:
 * - Total events processed per agent
 * - Events by type per agent
 * - Action success rate per agent
 * - Action latency (p50, p99) per agent
 *
 * Requirement: 9.5
 */
export class PrometheusMetricsCollector implements MetricsCollector {
  private readonly agentMetrics: Map<
    AgentType,
    {
      totalEvents: number;
      eventsByType: Map<EventType, number>;
      successCount: number;
      latencies: number[];
    }
  > = new Map();

  constructor() {
    const agentTypes: AgentType[] = [
      "Pipeline_Agent",
      "Deployment_Agent",
      "Incident_Agent",
      "Notification_Agent",
    ];

    for (const agentType of agentTypes) {
      this.agentMetrics.set(agentType, {
        totalEvents: 0,
        eventsByType: new Map(),
        successCount: 0,
        latencies: [],
      });
    }
  }

  /**
   * Record an event processed by an agent.
   */
  recordEvent(
    agentType: AgentType,
    eventType: EventType,
    success: boolean,
    latencyMs: number
  ): void {
    const metrics = this.agentMetrics.get(agentType);
    if (!metrics) return;

    metrics.totalEvents++;
    if (success) {
      metrics.successCount++;
    }

    const count = metrics.eventsByType.get(eventType) || 0;
    metrics.eventsByType.set(eventType, count + 1);

    metrics.latencies.push(latencyMs);

    // Keep only recent latencies (prevent unbounded growth)
    if (metrics.latencies.length > 10_000) {
      metrics.latencies = metrics.latencies.slice(-5_000);
    }
  }

  /**
   * Export metrics in Prometheus text format.
   *
   * Requirement: 9.5
   */
  getMetrics(): string {
    let output = "# HELP crm_agent_total_events Total events processed\n";
    output += "# TYPE crm_agent_total_events counter\n";

    for (const [agentType, metrics] of this.agentMetrics) {
      output += `crm_agent_total_events{agent="${agentType}"} ${metrics.totalEvents}\n`;
    }

    output += "\n# HELP crm_agent_events_by_type Events processed by type\n";
    output += "# TYPE crm_agent_events_by_type counter\n";

    for (const [agentType, metrics] of this.agentMetrics) {
      for (const [eventType, count] of metrics.eventsByType) {
        output += `crm_agent_events_by_type{agent="${agentType}",event_type="${eventType}"} ${count}\n`;
      }
    }

    output += "\n# HELP crm_agent_action_success_rate Success rate (0.0 - 1.0)\n";
    output += "# TYPE crm_agent_action_success_rate gauge\n";

    for (const [agentType, metrics] of this.agentMetrics) {
      const rate =
        metrics.totalEvents > 0
          ? (metrics.successCount / metrics.totalEvents).toFixed(4)
          : "0";
      output += `crm_agent_action_success_rate{agent="${agentType}"} ${rate}\n`;
    }

    output += "\n# HELP crm_agent_action_latency_ms Action latency in milliseconds\n";
    output += "# TYPE crm_agent_action_latency_ms histogram\n";

    for (const [agentType, metrics] of this.agentMetrics) {
      const p50 = this._percentile(metrics.latencies, 0.5);
      const p99 = this._percentile(metrics.latencies, 0.99);

      output += `crm_agent_action_latency_ms{agent="${agentType}",quantile="0.5"} ${p50}\n`;
      output += `crm_agent_action_latency_ms{agent="${agentType}",quantile="0.99"} ${p99}\n`;
    }

    return output;
  }

  private _percentile(values: number[], p: number): number {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * p) - 1;
    return Math.max(0, sorted[Math.max(0, index)]);
  }
}
