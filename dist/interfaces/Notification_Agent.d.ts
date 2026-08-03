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
import type { NotifyCommand, SlackHandle, HandleError, NotifyError, Result } from "../types/models";
export interface Notification_Agent {
    /**
     * Post a structured Slack message in response to a NotifyCommand.
     *
     * Builds a Block Kit message including all required fields.
     * Retries on Slack API error up to 3× with exponential backoff.
     * After exhausting retries: emits NotificationDeliveryFailureEvent and logs.
     *
     * @returns Ok(void) on successful delivery, Err(NotifyError) otherwise.
     */
    postMessage(command: NotifyCommand): Promise<Result<void, NotifyError>>;
    /**
     * Resolve the on-call Slack user handle for a given service name.
     *
     * Looks up the handle in the current config (onCallHandles map).
     * On failure: the caller should proceed without the mention per design spec.
     *
     * @returns Ok(SlackHandle) if resolved, Err(HandleError) if not configured.
     */
    resolveOnCallHandle(service: string): Promise<Result<SlackHandle, HandleError>>;
}
//# sourceMappingURL=Notification_Agent.d.ts.map