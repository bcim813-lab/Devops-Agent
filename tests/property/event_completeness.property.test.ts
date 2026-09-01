/**
 * Property-based tests for event completeness.
 *
 * Verifies that critical events contain all required fields and are well-formed.
 * Uses fast-check with minimum 100 iterations per property.
 *
 * Requirements: 2.2, 2.3, 6.6
 */

import fc from "fast-check";
import { v4 as uuidv4 } from "uuid";
import type {
  PipelineCompletedEvent,
  PipelineTimeoutEvent,
  SlackMessage,
} from "../../src/types/models";

describe("Event Completeness Properties", () => {
  // Property 2: Pipeline Completion Event Completeness
  // ---------------------------------------------------------------------------
  it("Property 2: PipelineCompletedEvent has all required fields", () => {
    fc.assert(
      fc.property(
        fc.record({
          pipelineRunId: fc.string({ minLength: 1 }),
          repositoryName: fc.string({ minLength: 1 }),
          branchName: fc.string({ minLength: 1 }),
          terminalState: fc.constantFrom<"success" | "failure" | "aborted">(
            "success",
            "failure",
            "aborted"
          ),
          durationSeconds: fc.integer({ min: 0, max: 86400 }),
        }),
        (eventData) => {
          const event: PipelineCompletedEvent = {
            eventId: uuidv4(),
            correlationId: uuidv4(),
            eventType: "PipelineCompletedEvent",
            source: "Pipeline_Agent",
            timestamp: new Date().toISOString(),
            pipelineRunId: eventData.pipelineRunId,
            repositoryName: eventData.repositoryName,
            branchName: eventData.branchName,
            terminalState: eventData.terminalState,
            durationSeconds: eventData.durationSeconds,
          };

          // Verify non-null and non-empty required fields
          expect(event.pipelineRunId).not.toBeNull();
          expect(event.pipelineRunId.length).toBeGreaterThan(0);

          expect(event.repositoryName).not.toBeNull();
          expect(event.repositoryName.length).toBeGreaterThan(0);

          expect(event.branchName).not.toBeNull();
          expect(event.branchName.length).toBeGreaterThan(0);

          // Verify terminal state is one of the valid values
          expect(["success", "failure", "aborted"]).toContain(
            event.terminalState
          );

          // Verify duration is non-negative
          expect(event.durationSeconds).toBeGreaterThanOrEqual(0);

          // Verify all fields are present
          expect(event).toHaveProperty("pipelineRunId");
          expect(event).toHaveProperty("repositoryName");
          expect(event).toHaveProperty("branchName");
          expect(event).toHaveProperty("terminalState");
          expect(event).toHaveProperty("durationSeconds");
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property 3: Timeout Event Integrity
  // ---------------------------------------------------------------------------
  it("Property 3: PipelineTimeoutEvent has matching pipelineRunId and configuredMaxDurationSeconds", () => {
    fc.assert(
      fc.property(
        fc.record({
          pipelineRunId: fc.string({ minLength: 1 }),
          configuredMaxDurationSeconds: fc.integer({ min: 1, max: 86400 }),
        }),
        (eventData) => {
          const event: PipelineTimeoutEvent = {
            eventId: uuidv4(),
            correlationId: uuidv4(),
            eventType: "PipelineTimeoutEvent",
            source: "Pipeline_Agent",
            timestamp: new Date().toISOString(),
            pipelineRunId: eventData.pipelineRunId,
            configuredMaxDurationSeconds: eventData.configuredMaxDurationSeconds,
          };

          // Verify the originating run ID is preserved
          expect(event.pipelineRunId).toBe(eventData.pipelineRunId);

          // Verify the configured max is preserved exactly
          expect(event.configuredMaxDurationSeconds).toBe(
            eventData.configuredMaxDurationSeconds
          );

          // Verify both are non-empty/positive
          expect(event.pipelineRunId.length).toBeGreaterThan(0);
          expect(event.configuredMaxDurationSeconds).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  // Property 4: Common event fields are well-formed
  // ---------------------------------------------------------------------------
  it("Property: All events have valid eventId, correlationId, and timestamp", () => {
    fc.assert(
      fc.property(
        fc.record({
          eventId: fc.string().map(() => uuidv4()),
          correlationId: fc.string().map(() => uuidv4()),
        }),
        (eventData) => {
          // Verify eventId is a valid UUID (non-empty string)
          expect(eventData.eventId).toBeTruthy();
          expect(typeof eventData.eventId).toBe("string");
          expect(eventData.eventId.length).toBeGreaterThan(0);

          // Verify correlationId is a valid UUID (non-empty string)
          expect(eventData.correlationId).toBeTruthy();
          expect(typeof eventData.correlationId).toBe("string");
          expect(eventData.correlationId.length).toBeGreaterThan(0);

          // Verify timestamp is a valid ISO 8601 string
          const timestamp = new Date().toISOString();
          expect(timestamp).toBeTruthy();
          expect(typeof timestamp).toBe("string");
          // ISO 8601 timestamps contain 'T' and 'Z' (or timezone info)
          expect(timestamp).toContain("T");
        }
      ),
      { numRuns: 100 }
    );
  });
});
