/**
 * Notification_Agent — message formatting and delivery.
 *
 * Formats events into Slack Block Kit messages and delivers them with retry logic.
 * On-call handles are @mentioned when available; if unresolvable, posts without mention.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 */

import { v4 as uuidv4 } from "uuid";
import { computeRetryDelay, NOTIFICATION_BACKOFF_MS } from "../../utils/backoff";
import { StructuredLogger } from "../../utils/logger";
import type {
  NotifyCommand,
  SlackMessage,
  NotificationDeliveryFailureEvent,
  BaseEvent,
  EventType,
  ISO8601String,
} from "../../types/models";
import type { OutboundEvent } from "../../interfaces/shared";

/**
 * Slack API client interface.
 */
export interface SlackClient {
  /**
   * Post a message to a Slack channel.
   * @returns Ok on success, error message on failure.
   */
  postMessage(
    channel: string,
    message: SlackMessage
  ): Promise<{ success: boolean; error?: Error }>;
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
export class MessageFormatter {
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
  formatMessage(command: NotifyCommand): SlackMessage {
    const {
      affectedServiceName,
      orchestratorTimestamp,
      outcome,
      onCallHandle,
      triggerEvent,
    } = command;

    const eventType = command.eventType; // or use triggerEvent.eventType

    // Build text summary
    let text = `Event: ${eventType} | Service: ${affectedServiceName} | Outcome: ${outcome}`;

    if (onCallHandle) {
      text += ` | ${onCallHandle}`;
    }

    // Build Block Kit blocks (simplified)
    const blocks = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${outcome.toUpperCase()}: ${affectedServiceName}`,
        },
      },
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

    // Requirement 6.7: Include on-call mention if available
    if (onCallHandle) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📞 *On-Call*: ${onCallHandle}`,
        },
      });
    }

    return {
      channel: "", // Filled in by the deliverer based on command
      text,
      blocks,
    };
  }
}

/**
 * Delivers Slack messages with exponential backoff retry logic.
 *
 * Posts within 15 s of receiving a NotifyCommand.
 * Retries up to 3× on Slack API errors with exponential backoff (1 s, 8 s cap, jitter).
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5, 6.7
 */
export class MessageDeliverer {
  private readonly slack: SlackClient;
  private readonly formatter: MessageFormatter;
  private readonly emit: EmitFn;
  private readonly logger: StructuredLogger;

  constructor(
    slack: SlackClient,
    emit: EmitFn,
    logger?: StructuredLogger
  ) {
    this.slack = slack;
    this.formatter = new MessageFormatter();
    this.emit = emit;
    this.logger = logger ?? new StructuredLogger();
  }

  /**
   * Deliver a notification message with retry logic.
   *
   * Requirement: 6.1 — Post to Slack within 15 s of receiving a NotifyCommand.
   * Requirement: 6.2 — On Slack API error, retry up to 3× with exponential backoff.
   * Requirement: 6.5 — Exponential backoff (initial 1 s, cap 8 s, jitter [0.8, 1.2]).
   * Requirement: 6.7 — If on-call handle is unresolvable, post without mention.
   */
  async deliver(
    command: NotifyCommand,
    channel: string
  ): Promise<void> {
    const deliveryStart = Date.now();
    const { onCallHandle, correlationId } = command;

    this.logger.info({
      action: "messageDeliverer.deliver",
      outcome: "pending",
      params: { channel, onCallHandle: !!onCallHandle },
      correlationId,
    });

    // Format the message
    const slackMessage = this.formatter.formatMessage(command);
    slackMessage.channel = channel;

    // Attempt delivery with retries
    const MAX_ATTEMPTS = 3;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        // Compute retry delay (exponential backoff with jitter)
        const delayMs = computeRetryDelay(attempt - 1, NOTIFICATION_BACKOFF_MS);

        this.logger.info({
          action: "messageDeliverer.retry",
          outcome: "pending",
          params: { channel, attempt, delayMs },
          correlationId,
        });

        // Sleep before retry
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }

      const result = await this.slack.postMessage(channel, slackMessage);

      if (result.success) {
        const elapsedMs = Date.now() - deliveryStart;

        if (elapsedMs > 15_000) {
          this.logger.warn({
            action: "messageDeliverer.deliver",
            outcome: "slow_delivery",
            params: { channel, elapsedMs },
            correlationId,
          });
        } else {
          this.logger.info({
            action: "messageDeliverer.deliver",
            outcome: "success",
            params: { channel, elapsedMs, attempt },
            correlationId,
          });
        }

        return;
      }

      lastError = result.error ?? new Error("Slack API error");
    }

    // Requirement 6.2 & 6.3: All retries exhausted — emit failure event
    const failureReason =
      onCallHandle === null ? "handle_unresolvable" : "retries_exhausted";

    this.logger.error({
      action: "messageDeliverer.deliver",
      outcome: "failure",
      params: { channel, failureReason },
      correlationId,
      errorMessage: lastError?.message,
    });

    const failureEvent: NotificationDeliveryFailureEvent = {
      eventId: uuidv4(),
      correlationId,
      eventType: "NotificationDeliveryFailureEvent",
      source: "Notification_Agent",
      timestamp: new Date().toISOString(),
      targetChannel: channel,
      originalEventType: command.eventType,
      failureReason,
    };

    this.emit(failureEvent);
  }
}
