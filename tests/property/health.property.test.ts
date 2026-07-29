/**
 * Property-based tests for heartbeat health state transitions.
 *
 * Property 11: Heartbeat Health Transition
 *   - If elapsed time since last heartbeat > 60 s → status must be "unhealthy".
 *   - If a heartbeat response is received within the 60 s window → status must be "healthy".
 *
 * Requirements: 9.2, 9.4
 */

import fc from "fast-check";
import { v4 as uuidv4 } from "uuid";
import { HealthMonitor } from "../../src/orchestrator/health";
import { StructuredLogger } from "../../src/utils/logger";
import type { AgentType, AgentHealthDegradedEvent } from "../../src/types/models";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_TYPES: AgentType[] = [
  "Pipeline_Agent",
  "Deployment_Agent",
  "Incident_Agent",
  "Notification_Agent",
];

function silentLogger(): StructuredLogger {
  return new StructuredLogger(() => {/* discard */});
}

// HealthMonitor exposes _checkHealth as private; we call it via a test-friendly subclass.
class TestableHealthMonitor extends HealthMonitor {
  triggerCheck(): void {
    (this as any)._checkHealth();
  }
}

// ---------------------------------------------------------------------------
// Property 11: Heartbeat Health Transition
// ---------------------------------------------------------------------------

describe("Property 11: Heartbeat Health Transition", () => {
  // Property 11: Heartbeat Health Transition
  it("Property 11: Agent is 'unhealthy' when no heartbeat received within 60 s", () => {
    fc.assert(
      fc.property(
        fc.record({
          agentType: fc.constantFrom(...AGENT_TYPES),
          elapsedSeconds: fc.integer({ min: 61, max: 300 }),
        }),
        (data) => {
          const degradedEvents: AgentHealthDegradedEvent[] = [];
          const monitor = new TestableHealthMonitor(
            15_000,
            60_000,
            (evt) => degradedEvents.push(evt),
            silentLogger()
          );

          monitor.start();

          // Simulate a heartbeat that happened elapsedSeconds ago
          const lastHeartbeat = new Date(
            Date.now() - data.elapsedSeconds * 1000
          ).toISOString();

          // Directly set lastHeartbeatAt via recordHeartbeat with a past timestamp
          // We do this by manipulating the internal agents map via a backdoor approach:
          // recordHeartbeat sets lastHeartbeatAt to now, so we call it and then rewind the time.
          monitor.recordHeartbeat(data.agentType);

          // Now override the stored timestamp to simulate elapsed time
          const agents: Map<AgentType, any> = (monitor as any).agents;
          const tracker = agents.get(data.agentType);
          if (tracker) {
            tracker.lastHeartbeatAt = lastHeartbeat;
            tracker.status = "healthy"; // reset to healthy so transition fires
          }

          // Trigger the health check
          monitor.triggerCheck();

          // Agent should now be marked unhealthy
          const status = monitor.getStatus();
          const agentStatus = status.agents.find(a => a.agentType === data.agentType);
          expect(agentStatus?.status).toBe("unhealthy");

          monitor.stop();
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 11: Agent is 'healthy' when heartbeat received within 60 s", () => {
    fc.assert(
      fc.property(
        fc.record({
          agentType: fc.constantFrom(...AGENT_TYPES),
          elapsedSeconds: fc.integer({ min: 0, max: 59 }),
        }),
        (data) => {
          const monitor = new TestableHealthMonitor(
            15_000,
            60_000,
            undefined,
            silentLogger()
          );

          monitor.start();

          // Record a heartbeat that is within the 60 s window
          monitor.recordHeartbeat(data.agentType);

          // Override the stored timestamp to simulate elapsed time within window
          const lastHeartbeat = new Date(
            Date.now() - data.elapsedSeconds * 1000
          ).toISOString();

          const agents: Map<AgentType, any> = (monitor as any).agents;
          const tracker = agents.get(data.agentType);
          if (tracker) {
            tracker.lastHeartbeatAt = lastHeartbeat;
          }

          // Trigger health check
          monitor.triggerCheck();

          // Agent should remain healthy
          const status = monitor.getStatus();
          const agentStatus = status.agents.find(a => a.agentType === data.agentType);
          expect(agentStatus?.status).toBe("healthy");

          monitor.stop();
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 11: AgentHealthDegradedEvent is emitted when transitioning healthy → unhealthy", () => {
    fc.assert(
      fc.property(
        fc.record({
          agentType: fc.constantFrom(...AGENT_TYPES),
        }),
        (data) => {
          const degradedEvents: AgentHealthDegradedEvent[] = [];
          const monitor = new TestableHealthMonitor(
            15_000,
            60_000,
            (evt) => degradedEvents.push(evt),
            silentLogger()
          );

          monitor.start();

          // Set agent to healthy with a heartbeat 120 s ago
          monitor.recordHeartbeat(data.agentType);
          const agents: Map<AgentType, any> = (monitor as any).agents;
          const tracker = agents.get(data.agentType);
          if (tracker) {
            tracker.lastHeartbeatAt = new Date(Date.now() - 120_000).toISOString();
            tracker.status = "healthy";
          }

          // Trigger check — should emit AgentHealthDegradedEvent
          monitor.triggerCheck();

          const relevant = degradedEvents.filter(e => e.agentType === data.agentType);
          expect(relevant.length).toBeGreaterThanOrEqual(1);

          // Event must have correct shape
          const evt = relevant[0];
          expect(evt.eventType).toBe("AgentHealthDegradedEvent");
          expect(evt.agentType).toBe(data.agentType);
          expect(evt.source).toBe("Orchestrator");

          monitor.stop();
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 11: Recovery to healthy after heartbeat resumes within window", () => {
    fc.assert(
      fc.property(
        fc.record({
          agentType: fc.constantFrom(...AGENT_TYPES),
        }),
        (data) => {
          const monitor = new TestableHealthMonitor(
            15_000,
            60_000,
            undefined,
            silentLogger()
          );

          monitor.start();

          // Mark as unhealthy first
          const agents: Map<AgentType, any> = (monitor as any).agents;
          const tracker = agents.get(data.agentType);
          if (tracker) {
            tracker.status = "unhealthy";
            tracker.lastHeartbeatAt = new Date(Date.now() - 120_000).toISOString();
          }

          // Now record a fresh heartbeat (within window)
          monitor.recordHeartbeat(data.agentType);

          // Status should be healthy now
          const status = monitor.getStatus();
          const agentStatus = status.agents.find(a => a.agentType === data.agentType);
          expect(agentStatus?.status).toBe("healthy");

          monitor.stop();
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 11: Agents with no heartbeat ever start as 'unknown' not 'healthy'", () => {
    fc.assert(
      fc.property(
        fc.record({
          agentType: fc.constantFrom(...AGENT_TYPES),
        }),
        (data) => {
          const monitor = new HealthMonitor(
            15_000,
            60_000,
            undefined,
            silentLogger()
          );

          monitor.start();

          const status = monitor.getStatus();
          const agentStatus = status.agents.find(a => a.agentType === data.agentType);

          // No heartbeat ever — should be unknown
          expect(agentStatus?.status).toBe("unknown");
          expect(agentStatus?.lastHeartbeatAt).toBeNull();

          monitor.stop();
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 11: getStatus() always returns all four agents", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5 }),
        (heartbeatCount) => {
          const monitor = new HealthMonitor(
            15_000,
            60_000,
            undefined,
            silentLogger()
          );

          monitor.start();

          // Record random heartbeats
          for (let i = 0; i < heartbeatCount; i++) {
            const agentType = AGENT_TYPES[i % AGENT_TYPES.length];
            monitor.recordHeartbeat(agentType);
          }

          const status = monitor.getStatus();
          expect(status.agents).toHaveLength(AGENT_TYPES.length);

          for (const agentType of AGENT_TYPES) {
            const entry = status.agents.find(a => a.agentType === agentType);
            expect(entry).toBeDefined();
            expect(["healthy", "unhealthy", "unknown"]).toContain(entry?.status);
          }

          monitor.stop();
        }
      ),
      { numRuns: 100 }
    );
  });
});
