"use strict";
/**
 * Orchestrator health tracking and status reporting.
 *
 * Sends heartbeats to agents and tracks their responsiveness.
 * Exposes GET /health endpoint with current health status.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HealthMonitor = void 0;
const logger_1 = require("../utils/logger");
const uuid_1 = require("uuid");
class HealthMonitor {
    constructor(heartbeatIntervalMs = 15000, healthCheckTimeoutMs = 60000, emit, logger) {
        this.agents = new Map();
        this.heartbeatTimer = null;
        this.heartbeatIntervalMs = heartbeatIntervalMs;
        this.healthCheckTimeoutMs = healthCheckTimeoutMs;
        this.emit = emit || (() => { });
        this.logger = logger ?? new logger_1.StructuredLogger();
    }
    start() {
        this.logger.info({
            action: "healthMonitor.start",
            outcome: "pending",
        });
        const agentTypes = [
            "Pipeline_Agent",
            "Deployment_Agent",
            "Incident_Agent",
            "Notification_Agent",
        ];
        for (const agentType of agentTypes) {
            this.agents.set(agentType, {
                agentType,
                lastHeartbeatAt: null,
                status: "unknown",
            });
        }
        this.heartbeatTimer = setInterval(() => this._checkHealth(), this.heartbeatIntervalMs);
        if (this.heartbeatTimer.unref) {
            this.heartbeatTimer.unref();
        }
    }
    stop() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        this.logger.debug({
            action: "healthMonitor.stop",
            outcome: "success",
        });
    }
    recordHeartbeat(agentType) {
        const tracker = this.agents.get(agentType);
        if (!tracker)
            return;
        const now = new Date().toISOString();
        const wasUnhealthy = tracker.status === "unhealthy";
        tracker.lastHeartbeatAt = now;
        tracker.status = "healthy";
        if (wasUnhealthy) {
            this.logger.info({
                action: "healthMonitor.recovered",
                outcome: "success",
                agentType,
                recoveredAt: now,
            });
        }
    }
    getStatus() {
        const agents = [];
        for (const [, tracker] of this.agents) {
            agents.push({
                agentType: tracker.agentType,
                status: tracker.status,
                lastHeartbeatAt: tracker.lastHeartbeatAt,
            });
        }
        return {
            agents,
            timestamp: new Date().toISOString(),
        };
    }
    _checkHealth() {
        const now = Date.now();
        for (const [, tracker] of this.agents) {
            const lastHeartbeat = tracker.lastHeartbeatAt
                ? new Date(tracker.lastHeartbeatAt).getTime()
                : null;
            const elapsedMs = lastHeartbeat ? now - lastHeartbeat : Infinity;
            if (elapsedMs > this.healthCheckTimeoutMs) {
                if (tracker.status === "healthy" || tracker.status === "unknown") {
                    tracker.status = "unhealthy";
                    const degradedEvent = {
                        eventId: (0, uuid_1.v4)(),
                        correlationId: (0, uuid_1.v4)(),
                        eventType: "AgentHealthDegradedEvent",
                        source: "Orchestrator",
                        timestamp: new Date().toISOString(),
                        agentType: tracker.agentType,
                        lastSeenAt: tracker.lastHeartbeatAt,
                    };
                    this.emit(degradedEvent);
                    this.logger.warn({
                        action: "healthMonitor.degraded",
                        outcome: "unhealthy",
                        agentType: tracker.agentType,
                        lastHeartbeatAt: tracker.lastHeartbeatAt,
                        elapsedMs,
                    });
                }
            }
        }
    }
}
exports.HealthMonitor = HealthMonitor;
//# sourceMappingURL=health.js.map