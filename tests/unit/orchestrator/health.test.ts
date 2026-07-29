/**
 * Unit tests for HealthMonitor (src/orchestrator/health.ts) and
 * PrometheusMetricsCollector (src/orchestrator/metrics.ts)
 *
 * Covers:
 *  - GET /health returns correct status per agent in healthy/unhealthy/unknown states
 *  - Agent transitions to unhealthy after 60 s silence → AgentHealthDegradedEvent (Req 9.2, 9.3)
 *  - Agent recovers to healthy when heartbeat resumes (Req 9.4)
 *  - All four agent types are tracked
 *  - lastHeartbeatAt is updated on recordHeartbeat()
 *  - Prometheus metrics endpoint outputs correct labels and counters (Req 9.5)
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5
 */

import { HealthMonitor } from "../../../src/orchestrator/health";
import { PrometheusMetricsCollector } from "../../../src/orchestrator/metrics";
import { StructuredLogger } from "../../../src/utils/logger";
import type { AgentType, AgentHealthDegradedEvent } from "../../../src/types/models";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_AGENTS: AgentType[] = [
  "Pipeline_Agent",
  "Deployment_Agent",
  "Incident_Agent",
  "Notification_Agent",
];

function silentLogger(): StructuredLogger {
  return new StructuredLogger(() => {/* discard */});
}

// Subclass to expose private _checkHealth for unit testing
class TestableHealthMonitor extends HealthMonitor {
  triggerCheck(): void {
    (this as any)._checkHealth();
  }

  setLastHeartbeat(agentType: AgentType, timestamp: string, status: "healthy" | "unhealthy" | "unknown"): void {
    const agents: Map<AgentType, any> = (this as any).agents;
    const tracker = agents.get(agentType);
    if (tracker) {
      tracker.lastHeartbeatAt = timestamp;
      tracker.status = status;
    }
  }
}

// ---------------------------------------------------------------------------
// HealthMonitor tests
// ---------------------------------------------------------------------------

describe("HealthMonitor", () => {

  // ── Initial state ────────────────────────────────────────────────────

  describe("initial state (Req 9.1)", () => {
    it("returns 'unknown' status for all agents before any heartbeat", () => {
      const monitor = new HealthMonitor(15_000, 60_000, undefined, silentLogger());
      monitor.start();

      const status = monitor.getStatus();

      for (const agentType of ALL_AGENTS) {
        const entry = status.agents.find(a => a.agentType === agentType);
        expect(entry?.status).toBe("unknown");
      }

      monitor.stop();
    });

    it("returns null lastHeartbeatAt for all agents before any heartbeat", () => {
      const monitor = new HealthMonitor(15_000, 60_000, undefined, silentLogger());
      monitor.start();

      const status = monitor.getStatus();

      for (const agentType of ALL_AGENTS) {
        const entry = status.agents.find(a => a.agentType === agentType);
        expect(entry?.lastHeartbeatAt).toBeNull();
      }

      monitor.stop();
    });

    it("getStatus() returns all four agent types", () => {
      const monitor = new HealthMonitor(15_000, 60_000, undefined, silentLogger());
      monitor.start();

      const status = monitor.getStatus();

      expect(status.agents).toHaveLength(ALL_AGENTS.length);
      for (const agentType of ALL_AGENTS) {
        expect(status.agents.some(a => a.agentType === agentType)).toBe(true);
      }

      monitor.stop();
    });

    it("getStatus() includes a timestamp", () => {
      const monitor = new HealthMonitor(15_000, 60_000, undefined, silentLogger());
      monitor.start();

      const status = monitor.getStatus();
      expect(typeof status.timestamp).toBe("string");
      expect(status.timestamp).toContain("T");

      monitor.stop();
    });
  });

  // ── recordHeartbeat() ─────────────────────────────────────────────────

  describe("recordHeartbeat()", () => {
    it("sets agent status to 'healthy' after heartbeat", () => {
      const monitor = new HealthMonitor(15_000, 60_000, undefined, silentLogger());
      monitor.start();

      monitor.recordHeartbeat("Pipeline_Agent");

      const status = monitor.getStatus();
      const entry = status.agents.find(a => a.agentType === "Pipeline_Agent");
      expect(entry?.status).toBe("healthy");

      monitor.stop();
    });

    it("updates lastHeartbeatAt after heartbeat", () => {
      const monitor = new HealthMonitor(15_000, 60_000, undefined, silentLogger());
      monitor.start();

      const before = new Date().toISOString();
      monitor.recordHeartbeat("Deployment_Agent");
      const after = new Date().toISOString();

      const status = monitor.getStatus();
      const entry = status.agents.find(a => a.agentType === "Deployment_Agent");
      expect(entry?.lastHeartbeatAt).not.toBeNull();
      expect(entry!.lastHeartbeatAt! >= before).toBe(true);
      expect(entry!.lastHeartbeatAt! <= after).toBe(true);

      monitor.stop();
    });

    it.each(ALL_AGENTS)("recordHeartbeat() only changes status of %s", (agentType) => {
      const monitor = new HealthMonitor(15_000, 60_000, undefined, silentLogger());
      monitor.start();

      monitor.recordHeartbeat(agentType);

      const status = monitor.getStatus();
      const healthyAgents = status.agents.filter(a => a.status === "healthy");
      expect(healthyAgents).toHaveLength(1);
      expect(healthyAgents[0].agentType).toBe(agentType);

      monitor.stop();
    });
  });

  // ── Unhealthy transition (Req 9.2, 9.3) ─────────────────────────────

  describe("unhealthy transition after 60 s silence (Req 9.2, 9.3)", () => {
    it("marks agent as unhealthy when no heartbeat for >60 s", () => {
      const degradedEvents: AgentHealthDegradedEvent[] = [];
      const monitor = new TestableHealthMonitor(
        15_000, 60_000,
        (evt) => degradedEvents.push(evt),
        silentLogger()
      );
      monitor.start();

      // Simulate heartbeat 120 s ago
      const oldTimestamp = new Date(Date.now() - 120_000).toISOString();
      monitor.setLastHeartbeat("Incident_Agent", oldTimestamp, "healthy");

      monitor.triggerCheck();

      const status = monitor.getStatus();
      const entry = status.agents.find(a => a.agentType === "Incident_Agent");
      expect(entry?.status).toBe("unhealthy");

      monitor.stop();
    });

    it("emits AgentHealthDegradedEvent when transitioning healthy → unhealthy (Req 9.3)", () => {
      const degradedEvents: AgentHealthDegradedEvent[] = [];
      const monitor = new TestableHealthMonitor(
        15_000, 60_000,
        (evt) => degradedEvents.push(evt),
        silentLogger()
      );
      monitor.start();

      const oldTimestamp = new Date(Date.now() - 120_000).toISOString();
      monitor.setLastHeartbeat("Notification_Agent", oldTimestamp, "healthy");

      monitor.triggerCheck();

      expect(degradedEvents.length).toBeGreaterThanOrEqual(1);
      const evt = degradedEvents.find(e => e.agentType === "Notification_Agent");
      expect(evt).toBeDefined();
      expect(evt?.eventType).toBe("AgentHealthDegradedEvent");

      monitor.stop();
    });

    it("AgentHealthDegradedEvent has source = 'Orchestrator'", () => {
      const degradedEvents: AgentHealthDegradedEvent[] = [];
      const monitor = new TestableHealthMonitor(
        15_000, 60_000,
        (evt) => degradedEvents.push(evt),
        silentLogger()
      );
      monitor.start();

      const oldTimestamp = new Date(Date.now() - 120_000).toISOString();
      monitor.setLastHeartbeat("Pipeline_Agent", oldTimestamp, "healthy");
      monitor.triggerCheck();

      const evt = degradedEvents.find(e => e.agentType === "Pipeline_Agent");
      expect(evt?.source).toBe("Orchestrator");

      monitor.stop();
    });

    it("does NOT emit duplicate degraded events for already-unhealthy agent", () => {
      const degradedEvents: AgentHealthDegradedEvent[] = [];
      const monitor = new TestableHealthMonitor(
        15_000, 60_000,
        (evt) => degradedEvents.push(evt),
        silentLogger()
      );
      monitor.start();

      const oldTimestamp = new Date(Date.now() - 120_000).toISOString();
      monitor.setLastHeartbeat("Pipeline_Agent", oldTimestamp, "healthy");

      // First check → transition fires
      monitor.triggerCheck();
      const countAfterFirst = degradedEvents.filter(e => e.agentType === "Pipeline_Agent").length;

      // Second check → already unhealthy, no additional event
      monitor.triggerCheck();
      const countAfterSecond = degradedEvents.filter(e => e.agentType === "Pipeline_Agent").length;

      expect(countAfterSecond).toBe(countAfterFirst);

      monitor.stop();
    });
  });

  // ── Recovery (Req 9.4) ────────────────────────────────────────────────

  describe("recovery to healthy (Req 9.4)", () => {
    it("transitions back to healthy when fresh heartbeat received", () => {
      const monitor = new TestableHealthMonitor(
        15_000, 60_000,
        undefined,
        silentLogger()
      );
      monitor.start();

      // Mark as unhealthy
      const oldTimestamp = new Date(Date.now() - 120_000).toISOString();
      monitor.setLastHeartbeat("Deployment_Agent", oldTimestamp, "unhealthy");

      // Record fresh heartbeat
      monitor.recordHeartbeat("Deployment_Agent");

      const status = monitor.getStatus();
      const entry = status.agents.find(a => a.agentType === "Deployment_Agent");
      expect(entry?.status).toBe("healthy");

      monitor.stop();
    });
  });

  // ── stop() ───────────────────────────────────────────────────────────

  describe("stop()", () => {
    it("stop() does not throw when called after start()", () => {
      const monitor = new HealthMonitor(15_000, 60_000, undefined, silentLogger());
      monitor.start();
      expect(() => monitor.stop()).not.toThrow();
    });

    it("stop() can be called multiple times without throwing", () => {
      const monitor = new HealthMonitor(15_000, 60_000, undefined, silentLogger());
      monitor.start();
      monitor.stop();
      expect(() => monitor.stop()).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// PrometheusMetricsCollector tests
// ---------------------------------------------------------------------------

describe("PrometheusMetricsCollector (Req 9.5)", () => {

  it("getMetrics() returns a non-empty string", () => {
    const collector = new PrometheusMetricsCollector();
    const metrics = collector.getMetrics();

    expect(typeof metrics).toBe("string");
    expect(metrics.length).toBeGreaterThan(0);
  });

  it("includes crm_agent_total_events metric", () => {
    const collector = new PrometheusMetricsCollector();
    const metrics = collector.getMetrics();

    expect(metrics).toContain("crm_agent_total_events");
  });

  it("includes all four agent type labels", () => {
    const collector = new PrometheusMetricsCollector();
    const metrics = collector.getMetrics();

    for (const agentType of ALL_AGENTS) {
      expect(metrics).toContain(agentType);
    }
  });

  it("recordEvent() increments total events counter", () => {
    const collector = new PrometheusMetricsCollector();

    collector.recordEvent("Pipeline_Agent", "PipelineTriggeredEvent", true, 100);
    collector.recordEvent("Pipeline_Agent", "PipelineTriggeredEvent", true, 200);

    const metrics = collector.getMetrics();
    expect(metrics).toContain(`crm_agent_total_events{agent="Pipeline_Agent"} 2`);
  });

  it("includes events_by_type metric with event_type label", () => {
    const collector = new PrometheusMetricsCollector();
    collector.recordEvent("Deployment_Agent", "DeploymentSuccessEvent", true, 50);

    const metrics = collector.getMetrics();
    expect(metrics).toContain("crm_agent_events_by_type");
    expect(metrics).toContain("DeploymentSuccessEvent");
  });

  it("includes action_success_rate metric", () => {
    const collector = new PrometheusMetricsCollector();
    collector.recordEvent("Incident_Agent", "IncidentResolvedEvent", true, 100);
    collector.recordEvent("Incident_Agent", "IncidentExecutionFailureEvent", false, 200);

    const metrics = collector.getMetrics();
    expect(metrics).toContain("crm_agent_action_success_rate");
    expect(metrics).toContain(`agent="Incident_Agent"`);
  });

  it("includes action_latency_ms histogram with p50 and p99 quantiles", () => {
    const collector = new PrometheusMetricsCollector();
    collector.recordEvent("Notification_Agent", "NotifyCommand", true, 50);
    collector.recordEvent("Notification_Agent", "NotifyCommand", true, 100);

    const metrics = collector.getMetrics();
    expect(metrics).toContain("crm_agent_action_latency_ms");
    expect(metrics).toContain(`quantile="0.5"`);
    expect(metrics).toContain(`quantile="0.99"`);
  });

  it("success rate is 1.0 when all events succeed", () => {
    const collector = new PrometheusMetricsCollector();
    collector.recordEvent("Pipeline_Agent", "PipelineCompletedEvent", true, 100);
    collector.recordEvent("Pipeline_Agent", "PipelineCompletedEvent", true, 150);

    const metrics = collector.getMetrics();
    expect(metrics).toContain(`crm_agent_action_success_rate{agent="Pipeline_Agent"} 1.0000`);
  });

  it("success rate is 0 when no events recorded", () => {
    const collector = new PrometheusMetricsCollector();

    const metrics = collector.getMetrics();
    // All agents start at 0
    expect(metrics).toContain(`crm_agent_action_success_rate{agent="Pipeline_Agent"} 0`);
  });
});
