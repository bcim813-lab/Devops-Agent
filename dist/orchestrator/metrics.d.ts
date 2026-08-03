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
export declare class PrometheusMetricsCollector implements MetricsCollector {
    private readonly agentMetrics;
    constructor();
    /**
     * Record an event processed by an agent.
     */
    recordEvent(agentType: AgentType, eventType: EventType, success: boolean, latencyMs: number): void;
    /**
     * Export metrics in Prometheus text format.
     *
     * Requirement: 9.5
     */
    getMetrics(): string;
    private _percentile;
}
//# sourceMappingURL=metrics.d.ts.map