"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateCorrelationId = void 0;
const uuid_1 = require("uuid");
/**
 * Generate a UUID v4 correlation ID.
 *
 * Used by the Orchestrator to stamp every inbound event with a unique
 * correlation ID that is then propagated through all downstream agent
 * log entries (Requirement 8.4).
 *
 * @returns A UUID v4 string, e.g. "550e8400-e29b-41d4-a716-446655440000".
 */
function generateCorrelationId() {
    return (0, uuid_1.v4)();
}
exports.generateCorrelationId = generateCorrelationId;
//# sourceMappingURL=correlation.js.map