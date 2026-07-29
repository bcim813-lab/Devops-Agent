/**
 * Notification_Agent — message formatting.
 *
 * Builds Slack Block Kit messages from NotifyCommand payloads.
 * Always includes: eventType, orchestratorTimestamp, affectedServiceName, outcome.
 * For escalation events: includes on-call @mention when available.
 *
 * Requirements: 6.4, 6.6, 6.7
 */

import type {
  NotifyCommand,
  SlackMessage,
  SlackBlock,
} from "../../types/models";

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
export class NotificationFormatter {
  /**
   * Format a NotifyCommand into a SlackMessage.
   *
   * @param command  - The notify command to format.
   * @param channel  - Target Slack channel (filled in by caller).
   * @returns        - SlackMessage with Block Kit layout.
   */
  format(command: NotifyCommand, channel: string): SlackMessage {
    const {
      eventType,
      orchestratorTimestamp,
      affectedServiceName,
      outcome,
      onCallHandle,
    } = command;

    const isEscalation =
      outcome === "escalated" ||
      (command.triggerEvent &&
        (command.triggerEvent.eventType === "IncidentEscalationEvent" ||
          command.triggerEvent.eventType === "CriticalFailureEvent"));

    // ── Build text fallback ─────────────────────────────────────────────
    let text =
      `[${outcome.toUpperCase()}] ${affectedServiceName} — ${eventType}` +
      ` | ${orchestratorTimestamp}`;

    if (isEscalation) {
      if (onCallHandle) {
        text += ` | ${onCallHandle}`;
      } else {
        text += ` (Note: on-call handle unresolvable at delivery time)`;
      }
    }

    // ── Build Block Kit blocks ──────────────────────────────────────────
    const blocks: SlackBlock[] = [
      // Header
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${this._outcomeEmoji(outcome)} ${outcome.toUpperCase()}: ${affectedServiceName}`,
          emoji: true,
        },
      },
      // Required fields section (Requirement 6.6)
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Event Type*\n${eventType}`,
          },
          {
            type: "mrkdwn",
            text: `*Timestamp*\n${orchestratorTimestamp}`,
          },
          {
            type: "mrkdwn",
            text: `*Service*\n${affectedServiceName}`,
          },
          {
            type: "mrkdwn",
            text: `*Outcome*\n${outcome}`,
          },
        ],
      },
    ];

    // Divider
    blocks.push({ type: "divider" });

    // ── On-call mention for escalations (Requirement 6.7) ───────────────
    if (isEscalation) {
      if (onCallHandle) {
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `📞 *On-Call Required*: ${onCallHandle}`,
          },
        });
      } else {
        // Requirement 6.7: handle unresolvable — post without mention, append note
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `⚠️ *Escalation Required* (Note: on-call handle unresolvable at delivery time)`,
          },
        });
      }
    }

    return {
      channel,
      text,
      blocks,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────

  private _outcomeEmoji(outcome: string): string {
    switch (outcome) {
      case "success":
        return "✅";
      case "failure":
        return "❌";
      case "rollback":
        return "🔄";
      case "escalated":
        return "🚨";
      default:
        return "ℹ️";
    }
  }
}
