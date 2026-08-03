/**
 * Shared interface helpers — lightweight aliases used across all agent interfaces
 * to keep them decoupled from concrete event shapes.
 */
import type { BaseEvent } from "../types/events";
/**
 * An event arriving from an external source (GitHub webhook, PagerDuty webhook)
 * or re-emitted by an agent back to the Orchestrator.
 * Before routing, the Orchestrator assigns a correlationId.
 */
export type InboundEvent = BaseEvent & Record<string, unknown>;
/**
 * A command or event dispatched by the Orchestrator to an agent.
 * Always carries the correlationId from the originating inbound event.
 */
export type AgentCommand = BaseEvent & Record<string, unknown>;
/**
 * An event emitted by an agent back to the Orchestrator after completing work.
 */
export type OutboundEvent = BaseEvent & Record<string, unknown>;
//# sourceMappingURL=shared.d.ts.map