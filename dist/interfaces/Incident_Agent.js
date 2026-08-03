"use strict";
/**
 * Incident_Agent interface — executes runbooks in response to PagerDuty alerts.
 *
 * Key behaviors:
 * - Responds only to P1/P2 alerts; ignores P3/P4.
 * - Looks up and executes the latest registered runbook version within 30 s.
 * - If no runbook found: escalates via Slack within 30 s; marks incident as manual.
 * - Runbook timeout at 300 s → treated as failure → escalation.
 * - On success: acknowledges PagerDuty incident; emits IncidentResolvedEvent.
 * - On failure: escalates; leaves PD incident open; emits IncidentExecutionFailureEvent.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=Incident_Agent.js.map