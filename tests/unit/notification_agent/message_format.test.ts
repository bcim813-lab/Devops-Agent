/**
 * Unit tests for NotificationFormatter and message format
 * (src/agents/notification/formatter.ts, src/agents/notification/delivery.ts)
 *
 * Covers:
 *  - Each trigger event type produces correctly structured message (Req 6.6)
 *  - Message always includes eventType, orchestratorTimestamp, affectedServiceName, outcome
 *  - Escalation events include on-call @mention when handle available (Req 6.7)
 *  - When handle unresolvable: message posted without mention, note appended (Req 6.7)
 *  - SlackMessage has required channel, text, and blocks fields
 *
 * Requirements: 6.4, 6.6, 6.7
 */

import { NotificationFormatter } from "../../../src/agents/notification/formatter";
import { MessageFormatter } from "../../../src/agents/notification/delivery";
import { StructuredLogger } from "../../../src/utils/logger";
import type { NotifyCommand } from "../../../src/types/models";
import { v4 as uuidv4 } from "uuid";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNotifyCmd(overrides: Partial<NotifyCommand> = {}): NotifyCommand {
  return {
    eventId: uuidv4(),
    correlationId: uuidv4(),
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
    orchestratorTimestamp: "2024-06-01T10:00:00.000Z",
    affectedServiceName: "crm-api",
    outcome: "success",
    onCallHandle: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// NotificationFormatter tests (formatter.ts)
// ---------------------------------------------------------------------------

describe("NotificationFormatter", () => {
  const formatter = new NotificationFormatter();

  // ── Required fields (Req 6.6) ─────────────────────────────────────────

  describe("required fields in every message (Req 6.6)", () => {
    it("includes eventType in message text", () => {
      const cmd = makeNotifyCmd({ eventType: "NotifyCommand" });
      const msg = formatter.format(cmd, "#deployments");

      expect(msg.text).toContain("NotifyCommand");
    });

    it("includes orchestratorTimestamp in message blocks", () => {
      const cmd = makeNotifyCmd({ orchestratorTimestamp: "2024-06-01T10:00:00.000Z" });
      const msg = formatter.format(cmd, "#deployments");

      const blocksStr = JSON.stringify(msg.blocks);
      expect(blocksStr).toContain("2024-06-01T10:00:00.000Z");
    });

    it("includes affectedServiceName in message blocks", () => {
      const cmd = makeNotifyCmd({ affectedServiceName: "crm-payments" });
      const msg = formatter.format(cmd, "#deployments");

      const blocksStr = JSON.stringify(msg.blocks);
      expect(blocksStr).toContain("crm-payments");
    });

    it("includes outcome in message blocks", () => {
      const cmd = makeNotifyCmd({ outcome: "failure" });
      const msg = formatter.format(cmd, "#deployments");

      const blocksStr = JSON.stringify(msg.blocks);
      expect(blocksStr).toContain("failure");
    });

    it("sets the channel on the SlackMessage", () => {
      const cmd = makeNotifyCmd();
      const msg = formatter.format(cmd, "#alerts");

      expect(msg.channel).toBe("#alerts");
    });

    it("includes non-empty text field", () => {
      const cmd = makeNotifyCmd();
      const msg = formatter.format(cmd, "#ops");

      expect(typeof msg.text).toBe("string");
      expect(msg.text.length).toBeGreaterThan(0);
    });

    it("includes blocks array", () => {
      const cmd = makeNotifyCmd();
      const msg = formatter.format(cmd, "#ops");

      expect(Array.isArray(msg.blocks)).toBe(true);
      expect((msg.blocks ?? []).length).toBeGreaterThan(0);
    });
  });

  // ── On-call mention for escalations (Req 6.7) ─────────────────────────

  describe("escalation event with resolvable on-call handle (Req 6.7)", () => {
    it("includes on-call handle in message text when outcome is escalated", () => {
      const cmd = makeNotifyCmd({
        outcome: "escalated",
        onCallHandle: "@alice",
        triggerEvent: {
          eventId: uuidv4(),
          correlationId: uuidv4(),
          eventType: "IncidentEscalationEvent",
          source: "Incident_Agent",
          timestamp: new Date().toISOString(),
        },
      });

      const msg = formatter.format(cmd, "#incidents");
      expect(msg.text).toContain("@alice");
    });

    it("includes on-call handle in blocks for escalation events", () => {
      const cmd = makeNotifyCmd({
        outcome: "escalated",
        onCallHandle: "@bob",
        triggerEvent: {
          eventId: uuidv4(),
          correlationId: uuidv4(),
          eventType: "IncidentEscalationEvent",
          source: "Incident_Agent",
          timestamp: new Date().toISOString(),
        },
      });

      const msg = formatter.format(cmd, "#incidents");
      const blocksStr = JSON.stringify(msg.blocks);
      expect(blocksStr).toContain("@bob");
    });
  });

  describe("escalation event with unresolvable handle (Req 6.7)", () => {
    it("posts without mention when onCallHandle is null", () => {
      const cmd = makeNotifyCmd({
        outcome: "escalated",
        onCallHandle: null,
        triggerEvent: {
          eventId: uuidv4(),
          correlationId: uuidv4(),
          eventType: "IncidentEscalationEvent",
          source: "Incident_Agent",
          timestamp: new Date().toISOString(),
        },
      });

      const msg = formatter.format(cmd, "#incidents");
      // Should not contain any @ handle
      expect(msg.text).not.toMatch(/@\w+/);
    });

    it("appends unresolvable note when handle is null", () => {
      const cmd = makeNotifyCmd({
        outcome: "escalated",
        onCallHandle: null,
        triggerEvent: {
          eventId: uuidv4(),
          correlationId: uuidv4(),
          eventType: "IncidentEscalationEvent",
          source: "Incident_Agent",
          timestamp: new Date().toISOString(),
        },
      });

      const msg = formatter.format(cmd, "#incidents");
      const fullContent = msg.text + JSON.stringify(msg.blocks);
      expect(fullContent).toContain("unresolvable");
    });
  });

  // ── Different outcome types ───────────────────────────────────────────

  describe("each trigger event type produces a valid message", () => {
    it.each([
      "success",
      "failure",
      "rollback",
      "escalated",
    ] as const)("outcome '%s' produces a valid SlackMessage", (outcome) => {
      const cmd = makeNotifyCmd({ outcome });
      const msg = formatter.format(cmd, "#ops");

      expect(msg.channel).toBe("#ops");
      expect(typeof msg.text).toBe("string");
      expect(msg.text.length).toBeGreaterThan(0);
      expect(Array.isArray(msg.blocks)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// MessageFormatter (delivery.ts) tests
// ---------------------------------------------------------------------------

describe("MessageFormatter (delivery.ts)", () => {
  const formatter = new MessageFormatter();

  it("formats a NotifyCommand into a SlackMessage", () => {
    const cmd = makeNotifyCmd({ outcome: "success" });
    const msg = formatter.formatMessage(cmd);

    expect(typeof msg.text).toBe("string");
    expect(msg.text.length).toBeGreaterThan(0);
    expect(Array.isArray(msg.blocks)).toBe(true);
  });

  it("includes the eventType in the text", () => {
    const cmd = makeNotifyCmd();
    const msg = formatter.formatMessage(cmd);

    expect(msg.text).toContain("NotifyCommand");
  });

  it("includes outcome in the text", () => {
    const cmd = makeNotifyCmd({ outcome: "rollback" });
    const msg = formatter.formatMessage(cmd);

    expect(msg.text).toContain("rollback");
  });

  it("includes on-call handle in text when provided", () => {
    const cmd = makeNotifyCmd({ onCallHandle: "@oncall-user" });
    const msg = formatter.formatMessage(cmd);

    expect(msg.text).toContain("@oncall-user");
  });
});
