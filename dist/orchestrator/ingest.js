"use strict";
/**
 * Orchestrator — event ingestion and correlation ID assignment.
 *
 * Receives inbound events, assigns correlation IDs, and routes to appropriate agents.
 *
 * Requirements: 8.1, 8.4
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EventIngester = void 0;
const uuid_1 = require("uuid");
const logger_1 = require("../utils/logger");
/**
 * Ingests inbound events, assigns correlation IDs, and routes them to agents.
 *
 * Requirements: 8.1, 8.4
 */
class EventIngester {
    constructor(route, logger) {
        this.route = route;
        this.logger = logger ?? new logger_1.StructuredLogger();
    }
    /**
     * Ingest an inbound event from an external source (webhook, API, etc).
     *
     * Requirement 8.1: Generate a UUID v4 correlation ID and assign it to the event envelope.
     * Write a structured log entry per event (event type, source, timestamp, correlation ID).
     * Route events to the correct agent based on eventType.
     */
    async ingest(event) {
        // Generate correlation ID if not present
        const correlationId = event.correlationId || (0, uuid_1.v4)();
        const envelope = {
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
        }
        catch (err) {
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
exports.EventIngester = EventIngester;
//# sourceMappingURL=ingest.js.map