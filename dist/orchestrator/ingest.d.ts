/**
 * Orchestrator — event ingestion and correlation ID assignment.
 *
 * Receives inbound events, assigns correlation IDs, and routes to appropriate agents.
 *
 * Requirements: 8.1, 8.4
 */
import { StructuredLogger } from "../utils/logger";
import type { BaseEvent, EventType } from "../types/models";
/**
 * Envelope for an inbound event with correlation ID.
 */
export interface EventEnvelope {
    correlationId: string;
    event: BaseEvent;
    receivedAt: string;
}
/**
 * Callback type for routing events to agents.
 */
export type RouteFn = (eventType: EventType, correlationId: string, event: BaseEvent) => Promise<void>;
/**
 * Ingests inbound events, assigns correlation IDs, and routes them to agents.
 *
 * Requirements: 8.1, 8.4
 */
export declare class EventIngester {
    private readonly route;
    private readonly logger;
    constructor(route: RouteFn, logger?: StructuredLogger);
    /**
     * Ingest an inbound event from an external source (webhook, API, etc).
     *
     * Requirement 8.1: Generate a UUID v4 correlation ID and assign it to the event envelope.
     * Write a structured log entry per event (event type, source, timestamp, correlation ID).
     * Route events to the correct agent based on eventType.
     */
    ingest(event: BaseEvent): Promise<void>;
}
//# sourceMappingURL=ingest.d.ts.map