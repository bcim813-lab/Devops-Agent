"use strict";
/**
 * Orchestrator interface — the central coordinator of the CRM DevOps Agents system.
 *
 * Responsibilities:
 * - Accept inbound events from external webhooks and internal agent emissions
 * - Assign UUID v4 correlation IDs on every inbound event before routing
 * - Route events/commands to the appropriate agent based on event type
 * - Manage agent health via heartbeats (every 15 s; unhealthy after 60 s silence)
 * - Expose /health and /metrics endpoints
 * - Load and hot-reload configuration from the versioned config store
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=Orchestrator.js.map