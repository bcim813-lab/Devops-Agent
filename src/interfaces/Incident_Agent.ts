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

import type {
  PagerDutyAlert,
  Runbook,
  IncidentRef,
  RunbookError,
  Result,
} from "../types/models";

export interface Incident_Agent {
  /**
   * Handle an inbound PagerDuty alert.
   *
   * P1/P2: looks up runbook within 30 s, executes it.
   *        No runbook → Slack escalation within 30 s.
   * P3/P4: no action taken (ignored silently).
   */
  handleAlert(alert: PagerDutyAlert): Promise<void>;

  /**
   * Execute all steps of the given runbook for the specified incident.
   *
   * Steps run sequentially. Enforces a 300 s total timeout.
   * On success: acknowledges the PagerDuty incident; emits IncidentResolvedEvent.
   * On failure/timeout: escalates to Slack; emits IncidentExecutionFailureEvent.
   *
   * @returns Ok(void) on success, Err(RunbookError) on failure/timeout.
   */
  executeRunbook(
    runbook: Runbook,
    incident: IncidentRef
  ): Promise<Result<void, RunbookError>>;

  /**
   * Escalate an incident to the on-call DevOps_Engineer via Slack.
   *
   * Posts a message within 30 s. If the on-call handle is unresolvable,
   * posts without mention and notes the resolution failure.
   */
  escalate(incident: IncidentRef, reason: string): Promise<void>;
}
