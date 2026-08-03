/**
 * Orchestrator health tracking and status reporting.
 *
 * Sends heartbeats to agents and tracks their responsiveness.
 * Exposes GET /health endpoint with current health status.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4
 */
import { StructuredLogger } from "../utils/logger";
import type { HealthStatus, AgentHealthDegradedEvent, AgentType } from "../types/models";
export interface AgentHealthTracker {
    agentType: AgentType;
    lastHeartbeatAt: string | null;
    status: "healthy" | "unhealthy" | "unknown";
}
export type EmitHealthEventFn = (event: AgentHealthDegradedEvent) => void;
export declare class HealthMonitor {
    private readonly agents;
    private readonly heartbeatIntervalMs;
    private readonly healthCheckTimeoutMs;
    private heartbeatTimer;
    private readonly emit;
    private readonly logger;
    constructor(heartbeatIntervalMs?: number, healthCheckTimeoutMs?: number, emit?: EmitHealthEventFn, logger?: StructuredLogger);
    start(): void;
    stop(): void;
    recordHeartbeat(agentType: AgentType): void;
    getStatus(): HealthStatus;
    private _checkHealth;
}
//# sourceMappingURL=health.d.ts.map