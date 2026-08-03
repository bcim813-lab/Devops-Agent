/**
 * Notification_Agent — message formatting.
 *
 * Builds Slack Block Kit messages from NotifyCommand payloads.
 * Always includes: eventType, orchestratorTimestamp, affectedServiceName, outcome.
 * For escalation events: includes on-call @mention when available.
 *
 * Requirements: 6.4, 6.6, 6.7
 */
import type { NotifyCommand, SlackMessage } from "../../types/models";
/**
 * Formats a NotifyCommand into a Slack Block Kit message.
 *
 * Required fields in every message (Requirement 6.6):
 *  - eventType
 *  - orchestratorTimestamp
 *  - affectedServiceName
 *  - outcome
 *
 * For escalation events (Requirement 6.7):
 *  - Include on-call @mention when handle is available.
 *  - If handle is unresolvable (null), append the note:
 *    "(Note: on-call handle unresolvable at delivery time)"
 *
 * Requirements: 6.4, 6.6, 6.7
 */
export declare class NotificationFormatter {
    /**
     * Format a NotifyCommand into a SlackMessage.
     *
     * @param command  - The notify command to format.
     * @param channel  - Target Slack channel (filled in by caller).
     * @returns        - SlackMessage with Block Kit layout.
     */
    format(command: NotifyCommand, channel: string): SlackMessage;
    private _outcomeEmoji;
}
//# sourceMappingURL=formatter.d.ts.map