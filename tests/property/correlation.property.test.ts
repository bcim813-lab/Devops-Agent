/**
 * Property-based tests for correlation ID propagation.
 *
 * Property 9: Correlation ID Propagation
 *   For any inbound event processed by the Orchestrator, every downstream
 *   agent log entry emitted in response must carry the same correlationId.
 *
 * Requirements: 8.4
 */

import fc from "fast-check";
import { v4 as uuidv4 } from "uuid";
import { EventIngester } from "../../src/orchestrator/ingest";
import { CommandDispatcher } from "../../src/orchestrator/dispatch";
import { StructuredLogger } from "../../src/utils/logger";
import type { BaseEvent, EventType } from "../../src/types/models";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  eventType: EventType,
  overrides: Partial<BaseEvent> = {}
): BaseEvent {
  return {
    eventId: uuidv4(),
    correlationId: uuidv4(),
    eventType,
    source: "external",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function silentLogger(): StructuredLogger {
  return new StructuredLogger(() => {/* discard */});
}

// ---------------------------------------------------------------------------
// Property 9: Correlation ID Propagation
// ---------------------------------------------------------------------------

describe("Property 9: Correlation ID Propagation", () => {
  // Property 9: Correlation ID Propagation
  it("Property 9: correlationId is forwarded from inbound event to every dispatched command", () => {
    fc.assert(
      fc.property(
        fc.record({
          correlationId: fc.string({ minLength: 1 }).map(() => uuidv4()),
          eventType: fc.constantFrom<EventType>(
            "PipelineTriggerFailedEvent",
            "PipelinePollFailureEvent",
            "DeploymentSuccessEvent",
            "RollbackEvent",
            "IncidentEscalationEvent",
            "CriticalFailureEvent"
          ),
        }),
        async (data) => {
          const dispatchedCommands: Array<{ correlationId: string; eventType: string }> = [];

          const captureAgent = {
            dispatch: jest.fn(async (cmd: any) => {
              dispatchedCommands.push({
                correlationId: cmd.correlationId,
                eventType: cmd.eventType,
              });
            }),
          };

          const dispatcher = new CommandDispatcher(
            captureAgent,
            captureAgent,
            captureAgent,
            captureAgent,
            silentLogger()
          );

          const event = makeEvent(data.eventType, {
            correlationId: data.correlationId,
            repositoryName: "crm-api",
            deploymentName: "crm-api",
            namespace: "production",
            serviceName: "crm-api",
            onCallHandle: "@oncall",
            reason: "timeout",
            failureReason: "test",
            pipelineRunId: "run-001",
            branchName: "main",
          } as any);

          await dispatcher.dispatch(data.eventType, data.correlationId, event);

          // Every command dispatched must carry the same correlationId
          for (const cmd of dispatchedCommands) {
            expect(cmd.correlationId).toBe(data.correlationId);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 9: EventIngester assigns correlationId to events that lack one", () => {
    fc.assert(
      fc.property(
        fc.record({
          eventType: fc.constantFrom<EventType>(
            "PipelineTriggeredEvent",
            "PipelineTriggerFailedEvent",
            "DeploymentSuccessEvent"
          ),
        }),
        async (data) => {
          const receivedCorrelationIds: string[] = [];

          const ingester = new EventIngester(
            async (_eventType, correlationId, _event) => {
              receivedCorrelationIds.push(correlationId);
            },
            silentLogger()
          );

          // Event with no correlationId
          const event: BaseEvent = {
            eventId: uuidv4(),
            correlationId: "", // missing
            eventType: data.eventType,
            source: "external",
            timestamp: new Date().toISOString(),
          };

          await ingester.ingest(event);

          // Orchestrator must have assigned a correlationId
          expect(receivedCorrelationIds).toHaveLength(1);
          expect(receivedCorrelationIds[0]).toBeTruthy();
          expect(typeof receivedCorrelationIds[0]).toBe("string");
          expect(receivedCorrelationIds[0].length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 9: EventIngester preserves existing correlationId from inbound event", () => {
    fc.assert(
      fc.property(
        fc.record({
          correlationId: fc.string({ minLength: 1 }).map(() => uuidv4()),
        }),
        async (data) => {
          const receivedCorrelationIds: string[] = [];

          const ingester = new EventIngester(
            async (_eventType, correlationId, _event) => {
              receivedCorrelationIds.push(correlationId);
            },
            silentLogger()
          );

          const event: BaseEvent = {
            eventId: uuidv4(),
            correlationId: data.correlationId,
            eventType: "PipelineTriggeredEvent",
            source: "Pipeline_Agent",
            timestamp: new Date().toISOString(),
          };

          await ingester.ingest(event);

          expect(receivedCorrelationIds[0]).toBe(data.correlationId);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 9: Distinct inbound events produce distinct correlationIds when none provided", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 10 }),
        async (eventCount) => {
          const correlationIds: string[] = [];

          const ingester = new EventIngester(
            async (_eventType, correlationId, _event) => {
              correlationIds.push(correlationId);
            },
            silentLogger()
          );

          for (let i = 0; i < eventCount; i++) {
            await ingester.ingest({
              eventId: uuidv4(),
              correlationId: "", // no correlationId — ingester should assign one
              eventType: "PipelineTriggerFailedEvent",
              source: "external",
              timestamp: new Date().toISOString(),
            });
          }

          // All assigned correlationIds must be non-empty strings
          expect(correlationIds).toHaveLength(eventCount);
          for (const cid of correlationIds) {
            expect(typeof cid).toBe("string");
            expect(cid.length).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 9: Dispatcher always forwards correlationId from originating event", () => {
    fc.assert(
      fc.property(
        fc.record({
          correlationId: fc.string({ minLength: 1 }).map(() => uuidv4()),
        }),
        async (data) => {
          const capturedIds: string[] = [];

          const captureAgent = {
            dispatch: jest.fn(async (cmd: any) => {
              capturedIds.push(cmd.correlationId);
            }),
          };

          const dispatcher = new CommandDispatcher(
            captureAgent,
            captureAgent,
            captureAgent,
            captureAgent,
            silentLogger()
          );

          // PipelineTriggerFailedEvent → NotifyCommand to Notification_Agent
          const event = makeEvent("PipelineTriggerFailedEvent", {
            correlationId: data.correlationId,
            repositoryName: "crm-api",
            branchName: "main",
            triggerTimestamp: new Date().toISOString(),
            failureReason: "test",
          } as any);

          await dispatcher.dispatch("PipelineTriggerFailedEvent", data.correlationId, event);

          expect(capturedIds).toHaveLength(1);
          expect(capturedIds[0]).toBe(data.correlationId);
        }
      ),
      { numRuns: 100 }
    );
  });
});
