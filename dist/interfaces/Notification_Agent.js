"use strict";
/**
 * Notification_Agent interface — posts structured Slack messages.
 *
 * Key behaviors:
 * - Posts within 15 s of receiving a NotifyCommand.
 * - Retries Slack API failures up to 3× with exponential backoff (1 s / 8 s cap, jitter [0.8, 1.2]).
 * - Every message must include: eventType, orchestratorTimestamp, affectedServiceName, outcome.
 * - Incident escalations mention on-call handle; if unresolvable, posts without mention + note.
 * - After exhausting retries: emits NotificationDeliveryFailureEvent.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=Notification_Agent.js.map