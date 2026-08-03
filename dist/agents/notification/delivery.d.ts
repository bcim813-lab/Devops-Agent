/**
 * Notification_Agent — message formatting and delivery.
 *
 * Formats events into Slack Block Kit messages and delivers them with retry logic.
 * On-call handles are @mentioned when available; if unresolvable, posts without mention.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 */
import { StructuredLogger } from "../../utils/logger";
import type { NotifyCommand, SlackMessage } from "../../types/models";
import type { OutboundEvent } from "../../interfaces/shared";
/**
 * Slack API client interface.
 */
export interface SlackClient {
    /**
     * Post a message to a Slack channel.
     * @returns Ok on success, error message on failure.
     */
    postMessage(channel: string, message: SlackMessage): Promise<{
        success: boolean;
        error?: Error;
    }>;
}
/**
 * Callback type for emitting events to the Orchestrator.
 */
export type EmitFn = (event: OutboundEvent) => void;
/**
 * Formats events into Slack Block Kit messages.
 *
 * Requirement: 6.6, 6.7
 */
export declare class MessageFormatter {
    /**
     * Format a NotifyCommand into a SlackMessage with Block Kit layout.
     *
     * Always includes:
     * - eventType
     * - orchestratorTimestamp
     * - affectedServiceName
     * - outcome
     *
     * For escalation events, includes on-call @mention if available.
     *
     * Requirements: 6.4, 6.6, 6.7
     */
    formatMessage(command: NotifyCommand): SlackMessage;
}
/**
 * Delivers Slack messages with exponential backoff retry logic.
 *
 * Posts within 15 s of receiving a NotifyCommand.
 * Retries up to 3× on Slack API errors with exponential backoff (1 s, 8 s cap, jitter).
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5, 6.7
 */
export declare class MessageDeliverer {
    private readonly slack;
    private readonly formatter;
    private readonly emit;
    private readonly logger;
    constructor(slack: SlackClient, emit: EmitFn, logger?: StructuredLogger);
    /**
     * Deliver a notification message with retry logic.
     *
     * Requirement: 6.1 — Post to Slack within 15 s of receiving a NotifyCommand.
     * Requirement: 6.2 — On Slack API error, retry up to 3× with exponential backoff.
     * Requirement: 6.5 — Exponential backoff (initial 1 s, cap 8 s, jitter [0.8, 1.2]).
     * Requirement: 6.7 — If on-call handle is unresolvable, post without mention.
     */
    deliver(command: NotifyCommand, channel: string): Promise<void>;
}
//# sourceMappingURL=delivery.d.ts.map