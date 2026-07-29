/**
 * Unit tests for MessageDeliverer retry logic
 * (src/agents/notification/delivery.ts)
 *
 * Covers:
 *  - Successful delivery on first attempt
 *  - Retry on Slack 500 error → up to 3 attempts → NotificationDeliveryFailureEvent
 *  - Successful delivery after 1 retry
 *  - Successful delivery after 2 retries
 *  - handle_unresolvable: onCallHandle null → NotificationDeliveryFailureEvent with correct failureReason
 *  - NotificationDeliveryFailureEvent contains targetChannel, originalEventType, failureReason
 *  - correlationId propagated to failure event
 *
 * Requirements: 6.1, 6.2, 6.3, 6.5, 6.7
 */

import { MessageDeliverer, SlackClient } from "../../../src/agents/notification/delivery";
import { StructuredLogger } from "../../../src/utils/logger";
import type { NotifyCommand, NotificationDeliveryFailureEvent } from "../../../src/types/models";
import type { OutboundEvent } from "../../../src/interfaces/shared";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): StructuredLogger {
  return new StructuredLogger(() => {/* discard */});
}

function makeEmit(): { events: OutboundEvent[]; emit: (e: OutboundEvent) => void } {
  const events: OutboundEvent[] = [];
  return { events, emit: (e) => events.push(e) };
}

function makeCmd(overrides: Partial<NotifyCommand> = {}): NotifyCommand {
  return {
    eventId: uuidv4(),
    correlationId: "corr-notify-001",
    eventType: "NotifyCommand",
    source: "Orchestrator",
    timestamp: new Date().toISOString(),
    triggerEvent: {
      eventId: uuidv4(),
      correlationId: uuidv4(),
      eventType: "DeploymentSuccessEvent",
      source: "Deployment_Agent",
      timestamp: new Date().toISOString(),
    },
    orchestratorTimestamp: new Date().toISOString(),
    affectedServiceName: "crm-api",
    outcome: "success",
    onCallHandle: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MessageDeliverer", () => {

  // ── Success on first attempt ──────────────────────────────────────────

  describe("success on first attempt", () => {
    it("does not emit any events when Slack accepts the message", async () => {
      const slack: SlackClient = {
        postMessage: jest.fn().mockResolvedValue({ success: true }),
      };
      const { events, emit } = makeEmit();
      const deliverer = new MessageDeliverer(slack, emit, silentLogger());

      await deliverer.deliver(makeCmd(), "#deployments");

      expect(events).toHaveLength(0);
    });

    it("calls Slack postMessage exactly once on first-attempt success", async () => {
      const postMessage = jest.fn().mockResolvedValue({ success: true });
      const slack: SlackClient = { postMessage };
      const { emit } = makeEmit();
      const deliverer = new MessageDeliverer(slack, emit, silentLogger());

      await deliverer.deliver(makeCmd(), "#deployments");

      expect(postMessage).toHaveBeenCalledTimes(1);
    });

    it("calls Slack with the correct channel", async () => {
      const postMessage = jest.fn().mockResolvedValue({ success: true });
      const slack: SlackClient = { postMessage };
      const { emit } = makeEmit();
      const deliverer = new MessageDeliverer(slack, emit, silentLogger());

      await deliverer.deliver(makeCmd(), "#my-channel");

      expect(postMessage).toHaveBeenCalledWith("#my-channel", expect.any(Object));
    });
  });

  // ── Retry on Slack error ─────────────────────────────────────────────

  describe("retry logic on Slack API errors (Req 6.2, 6.5)", () => {
    it("retries up to 3 total attempts on Slack API error", async () => {
      const postMessage = jest.fn().mockResolvedValue({
        success: false,
        error: new Error("Slack 500"),
      });
      const slack: SlackClient = { postMessage };
      const { emit } = makeEmit();
      const deliverer = new MessageDeliverer(slack, emit, silentLogger());

      await deliverer.deliver(makeCmd(), "#alerts");

      expect(postMessage).toHaveBeenCalledTimes(3);
    });

    it("emits NotificationDeliveryFailureEvent after all 3 retries exhausted (Req 6.3)", async () => {
      const slack: SlackClient = {
        postMessage: jest.fn().mockResolvedValue({ success: false, error: new Error("500") }),
      };
      const { events, emit } = makeEmit();
      const deliverer = new MessageDeliverer(slack, emit, silentLogger());

      await deliverer.deliver(makeCmd(), "#alerts");

      const failures = events.filter(e => e.eventType === "NotificationDeliveryFailureEvent");
      expect(failures).toHaveLength(1);
    });

    it("NotificationDeliveryFailureEvent contains targetChannel", async () => {
      const slack: SlackClient = {
        postMessage: jest.fn().mockResolvedValue({ success: false, error: new Error("err") }),
      };
      const { events, emit } = makeEmit();
      const deliverer = new MessageDeliverer(slack, emit, silentLogger());

      await deliverer.deliver(makeCmd(), "#my-team");

      const evt = events.find(e => e.eventType === "NotificationDeliveryFailureEvent") as Record<string, unknown>;
      expect(evt.targetChannel).toBe("#my-team");
    });

    it("NotificationDeliveryFailureEvent contains originalEventType", async () => {
      const slack: SlackClient = {
        postMessage: jest.fn().mockResolvedValue({ success: false, error: new Error("err") }),
      };
      const { events, emit } = makeEmit();
      const deliverer = new MessageDeliverer(slack, emit, silentLogger());

      await deliverer.deliver(makeCmd({ eventType: "NotifyCommand" }), "#ch");

      const evt = events.find(e => e.eventType === "NotificationDeliveryFailureEvent") as Record<string, unknown>;
      expect(evt.originalEventType).toBe("NotifyCommand");
    });

    it("NotificationDeliveryFailureEvent propagates correlationId (Req 8.4)", async () => {
      const slack: SlackClient = {
        postMessage: jest.fn().mockResolvedValue({ success: false, error: new Error("err") }),
      };
      const { events, emit } = makeEmit();
      const deliverer = new MessageDeliverer(slack, emit, silentLogger());

      await deliverer.deliver(makeCmd({ correlationId: "corr-fail-99" }), "#ch");

      const evt = events.find(e => e.eventType === "NotificationDeliveryFailureEvent");
      expect(evt?.correlationId).toBe("corr-fail-99");
    });

    it("succeeds on second attempt (1 retry) without emitting failure event", async () => {
      const postMessage = jest.fn()
        .mockResolvedValueOnce({ success: false, error: new Error("transient") })
        .mockResolvedValue({ success: true });
      const slack: SlackClient = { postMessage };
      const { events, emit } = makeEmit();
      const deliverer = new MessageDeliverer(slack, emit, silentLogger());

      await deliverer.deliver(makeCmd(), "#ch");

      expect(postMessage).toHaveBeenCalledTimes(2);
      expect(events.filter(e => e.eventType === "NotificationDeliveryFailureEvent")).toHaveLength(0);
    });

    it("succeeds on third attempt (2 retries) without emitting failure event", async () => {
      const postMessage = jest.fn()
        .mockResolvedValueOnce({ success: false, error: new Error("err1") })
        .mockResolvedValueOnce({ success: false, error: new Error("err2") })
        .mockResolvedValue({ success: true });
      const slack: SlackClient = { postMessage };
      const { events, emit } = makeEmit();
      const deliverer = new MessageDeliverer(slack, emit, silentLogger());

      await deliverer.deliver(makeCmd(), "#ch");

      expect(postMessage).toHaveBeenCalledTimes(3);
      expect(events.filter(e => e.eventType === "NotificationDeliveryFailureEvent")).toHaveLength(0);
    });
  });

  // ── handle_unresolvable (Req 6.7) ─────────────────────────────────────

  describe("handle_unresolvable failureReason (Req 6.7)", () => {
    it("emits NotificationDeliveryFailureEvent with failureReason = 'handle_unresolvable' when onCallHandle is null and delivery fails", async () => {
      const slack: SlackClient = {
        postMessage: jest.fn().mockResolvedValue({ success: false, error: new Error("error") }),
      };
      const { events, emit } = makeEmit();
      const deliverer = new MessageDeliverer(slack, emit, silentLogger());

      await deliverer.deliver(makeCmd({ onCallHandle: null }), "#ch");

      const evt = events.find(e => e.eventType === "NotificationDeliveryFailureEvent") as Record<string, unknown>;
      expect(evt.failureReason).toBe("handle_unresolvable");
    });

    it("failure event has a non-empty failureReason when retries exhausted and handle is not null", async () => {
      const slack: SlackClient = {
        postMessage: jest.fn().mockResolvedValue({ success: false, error: new Error("err") }),
      };
      const { events, emit } = makeEmit();
      const deliverer = new MessageDeliverer(slack, emit, silentLogger());

      await deliverer.deliver(makeCmd({ onCallHandle: "@someone" }), "#ch");

      const evt = events.find(e => e.eventType === "NotificationDeliveryFailureEvent") as Record<string, unknown>;
      expect(typeof evt.failureReason).toBe("string");
      expect((evt.failureReason as string).length).toBeGreaterThan(0);
    });
  });

  // ── Event shape invariants ────────────────────────────────────────────

  describe("failure event shape invariants", () => {
    it("NotificationDeliveryFailureEvent has source = 'Notification_Agent'", async () => {
      const slack: SlackClient = {
        postMessage: jest.fn().mockResolvedValue({ success: false, error: new Error("err") }),
      };
      const { events, emit } = makeEmit();
      const deliverer = new MessageDeliverer(slack, emit, silentLogger());

      await deliverer.deliver(makeCmd(), "#ch");

      const evt = events.find(e => e.eventType === "NotificationDeliveryFailureEvent");
      expect(evt?.source).toBe("Notification_Agent");
    });

    it("NotificationDeliveryFailureEvent has non-empty eventId and timestamp", async () => {
      const slack: SlackClient = {
        postMessage: jest.fn().mockResolvedValue({ success: false, error: new Error("err") }),
      };
      const { events, emit } = makeEmit();
      const deliverer = new MessageDeliverer(slack, emit, silentLogger());

      await deliverer.deliver(makeCmd(), "#ch");

      const evt = events.find(e => e.eventType === "NotificationDeliveryFailureEvent");
      expect(evt?.eventId?.length).toBeGreaterThan(0);
      expect(evt?.timestamp?.length).toBeGreaterThan(0);
    });
  });
});
