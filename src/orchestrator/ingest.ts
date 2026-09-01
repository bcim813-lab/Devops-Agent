/**
 * Orchestrator — event ingestion and correlation ID assignment.
 *
 * Receives inbound events, assigns correlation IDs, and routes to appropriate agents.
 *
 * Requirements: 8.1, 8.4
 */

import { v4 as uuidv4 } from "uuid";
import { StructuredLogger } from "../utils/logger";
import type { BaseEvent, EventType } from "../types/models";
import type { OutboundEvent } from "../interfaces/shared";

/**
 * Envelope for an inbound event with correlation ID.
 */
export interface EventEnvelope {
  correlationId: string;
  event: BaseEvent;
  receivedAt: string; // ISO 8601
}

/**
 * Callback type for routing events to agents.
 */
export type RouteFn = (
  eventType: EventType,
  correlationId: string,
  event: BaseEvent
) => Promise<void>;

/**
 * Ingests inbound events, assigns correlation IDs, and routes them to agents.
 *
 * Requirements: 8.1, 8.4
 */
export class EventIngester {
  private readonly route: RouteFn;
  private readonly logger: StructuredLogger;

  constructor(route: RouteFn, logger?: StructuredLogger) {
    this.route = route;
    this.logger = logger ?? new StructuredLogger();
  }

  /**
   * Ingest an inbound event from an external source (webhook, API, etc).
   *
   * Requirement 8.1: Generate a UUID v4 correlation ID and assign it to the event envelope.
   * Write a structured log entry per event (event type, source, timestamp, correlation ID).
   * Route events to the correct agent based on eventType.
   */
  async ingest(event: BaseEvent): Promise<void> {
    // Generate correlation ID if not present
    const correlationId = event.correlationId || uuidv4();

    const envelope: EventEnvelope = {
      correlationId,
      event,
      receivedAt: new Date().toISOString(),
    };

    // Requirement 8.1: Log ingestion
    this.logger.info({
      action: "orchestrator.ingest",
      outcome: "received",
      eventType: event.eventType,
      source: event.source,
      timestamp: event.timestamp,
      correlationId,
    });

    // Route to appropriate agent
    try {
      await this.route(event.eventType, correlationId, event);
    } catch (err) {
      this.logger.error({
        action: "orchestrator.ingest",
        outcome: "routing_failed",
        eventType: event.eventType,
        correlationId,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
