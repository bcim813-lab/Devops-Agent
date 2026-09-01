# Implementation Plan: CRM DevOps Agents

## Overview

Implement an event-driven automation platform for a CRM DevOps pipeline. The system consists of a central Orchestrator and four specialized agents (Pipeline, Deployment, Incident, Notification) built in TypeScript/Node.js. The implementation proceeds bottom-up: shared types and interfaces first, then each agent's core logic, then the Orchestrator wiring, observability, and configuration management.

All external API clients (Jenkins, Kubernetes, Slack, PagerDuty) are injected via constructor injection for testability. Property-based tests use **fast-check** and run a minimum of 100 iterations per property.

---

## Tasks

- [x] 1. Set up project structure, shared types, and interfaces
  - [x] 1.1 Initialize TypeScript/Node.js project scaffolding
    - Project initialized with `tsconfig.json`, `package.json`, Jest + fast-check test runner
    - `src/types/events.ts` contains all `BaseEvent`, `EventType`, and `AgentType` definitions
    - `src/types/models.ts` contains all Pipeline, Deployment, Incident, Notification, Health, and Config data models
    - `src/interfaces/` contains `Orchestrator`, `Pipeline_Agent`, `Deployment_Agent`, `Incident_Agent`, `Notification_Agent`, and `RunbookLibrary` interface definitions
    - _Requirements: 1.1, 1.2, 2.2, 6.6, 7.1, 8.1, 8.2, 8.4_

  - [x] 1.2 Implement shared utilities
    - `src/utils/backoff.ts` — exponential backoff + jitter utility parameterized by `{ initial, max }` (shared by Pipeline_Agent and Notification_Agent)
    - `src/utils/correlation.ts` — UUID v4 correlation ID generator
    - `src/utils/logger.ts` — structured logger that masks credentials/tokens before writing log entries
    - _Requirements: 1.3, 6.5, 8.1, 8.2, 8.4_

- [x] 2. Implement the Pipeline_Agent
  - [x] 2.1 Implement pipeline trigger logic in `src/agents/pipeline/trigger.ts`
    - Implement `triggerPipeline()` calling the Jenkins API; on failure retry up to 3× with exponential backoff (initial 5 s, cap 60 s, jitter factor [0.8, 1.2])
    - Emit `PipelineTriggeredEvent` on success; emit `PipelineTriggerFailedEvent` (with repo, branch, timestamp, reason) after all retries exhausted
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [x] 2.2 Write property test for exponential backoff bounds (pipeline trigger)
    - **Property 1: Exponential Backoff Bounds (Pipeline Trigger)**
    - For any retry attempt index 0–2, `computeRetryDelay(attempt, {initial:5000, max:60000})` must return a value ≥ 5000 ms and ≤ 60000 ms
    - Tag comment: `// Property 1: Exponential Backoff Bounds (Pipeline Trigger)`
    - File: `tests/property/backoff.property.test.ts`
    - **Validates: Requirements 1.3**

  - [x] 2.3 Implement pipeline polling logic in `src/agents/pipeline/polling.ts`
    - Implement `pollPipelineStatus()` polling Jenkins every 30 s; on poll failure retry once after 10 s; emit `PipelinePollFailureEvent` to Orchestrator if retry also fails
    - Implement timeout detection: when elapsed time exceeds `max_duration_seconds` (must be a positive integer; if unset, skip timeout monitoring), emit `PipelineTimeoutEvent` with `pipelineRunId` and configured max
    - Emit `PipelineCompletedEvent` (with runId, repo, branch, terminal state, duration) within 10 s of detecting a terminal state
    - _Requirements: 2.1, 2.2, 2.3, 2.5_

  - [x] 2.4 Write property test for `PipelineCompletedEvent` completeness and timeout integrity
    - **Property 2: Pipeline Completion Event Completeness**
    - For any randomly generated completed pipeline run, the emitted event must have non-null `pipelineRunId`, `repositoryName`, `branchName`, valid `terminalState`, and non-negative `durationSeconds`
    - **Property 3: Timeout Event Integrity**
    - For any run where `max_duration_seconds` is configured and exceeded, `PipelineTimeoutEvent.pipelineRunId` and `.configuredMaxDurationSeconds` must match the originating run
    - File: `tests/property/event_completeness.property.test.ts`
    - **Validates: Requirements 2.2, 2.3**

  - [x] 2.5 Implement pipeline run record persistence in `src/agents/pipeline/records.ts`
    - Store `PipelineRunRecord` entries (status, duration, `retainUntil = triggerTimestamp + 30 days`)
    - Implement a TTL-based cleanup job that removes records older than 30 days
    - _Requirements: 2.4_

  - [x] 2.6 Write unit tests for Pipeline_Agent
    - Test trigger success, all 3 retry exhaustion, and partial retry recovery scenarios
    - Test polling: normal completion, poll failure + single retry, timeout detection with null vs. set `max_duration_seconds`
    - Test record retention boundary (records at exactly 30 days are still present; at 30 days + 1 s are eligible for removal)
    - File: `tests/unit/pipeline_agent/trigger.test.ts`, `polling.test.ts`
    - _Requirements: 1.1–1.4, 2.1–2.5_

- [x] 3. Checkpoint — pipeline layer
  - Ensure all pipeline unit and property tests pass before proceeding. Ask the user if questions arise.

- [x] 4. Implement the Deployment_Agent
  - [x] 4.1 Implement manifest application in `src/agents/deployment/apply.ts`
    - Implement `applyManifest()`: only proceed when `manifestFilePath` is explicitly set in the pipeline config
    - On Kubernetes API error, emit `DeploymentFailureEvent` (with name, namespace, manifest path, error message); do NOT initiate rollback
    - _Requirements: 3.1, 3.7_

  - [x] 4.2 Implement rollout monitoring in `src/agents/deployment/monitor.ts`
    - Poll Kubernetes rollout status every 15 s
    - On successful rollout, emit `DeploymentSuccessEvent`
    - When rollout timeout elapses without ready state (default 600 s, configurable per pipeline), initiate automatic rollback
    - Emit `RollbackEvent` (with deployment name, namespace, reason) when rollback is initiated
    - _Requirements: 3.2, 3.3, 3.4, 3.5_

  - [x] 4.3 Implement automatic rollback in `src/agents/deployment/rollback.ts`
    - Dispatch rollback command to Kubernetes within 5 s of initiating
    - Rollback must complete within 120 s of dispatch
    - After rollback, verify all pods for the previous revision have reached Ready state at desired replica count before emitting `RollbackSuccessEvent`
    - On rollback dispatch failure, rollback timeout, or Kubernetes API error during rollback: emit `CriticalFailureEvent` and record the `(deploymentName, namespace)` pair in the halt registry
    - Log every rollback attempt with timestamp, deployment name, namespace, and outcome (`success` | `failed` | `timed-out`)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 4.4 Implement deployment halt registry in `src/agents/deployment/haltState.ts`
    - Maintain an in-memory (and persisted) `DeploymentHaltState` registry
    - All incoming commands for a halted `(deploymentName, namespace)` pair return `HaltedError` immediately without executing
    - Implement `resumeDeployment(deploymentRef)` to clear a halt (DevOps_Engineer-gated)
    - Log every rejected command with halt reason and timestamp
    - _Requirements: 4.3, 4.4_

  - [x] 4.5 Write property test for rollback trigger condition
    - **Property 4: Rollback Trigger Condition**
    - For any deployment, rollback is initiated if and only if rollout timeout elapses; a Kubernetes API manifest-apply error must NOT trigger a rollback
    - File: `tests/property/deployment_safety.property.test.ts`
    - **Validates: Requirements 3.4, 3.7**

  - [x] 4.6 Write property test for rollback completeness verification
    - **Property 5: Rollback Completeness Verification**
    - For any completed rollback, `RollbackSuccessEvent` must not be emitted unless all pods for the previous revision are Ready at desired replica count
    - File: `tests/property/deployment_safety.property.test.ts`
    - **Validates: Requirements 4.2**

  - [x] 4.7 Write property test for halt invariant
    - **Property 6: Halt Invariant**
    - For any `(deploymentName, namespace)` pair in halted state, all subsequent deployment and rollback commands must return `HaltedError` without executing, until `resumeDeployment` is called
    - File: `tests/property/deployment_safety.property.test.ts`
    - **Validates: Requirements 4.3, 4.4**

  - [x] 4.8 Support multiple Kubernetes namespaces
    - Ensure `DeploymentCommand` routing respects the `namespace` field from pipeline config
    - Validate namespace names against the `kubernetes.clusters[*].namespaces` config at dispatch time
    - _Requirements: 3.6_

  - [x] 4.9 Write unit tests for Deployment_Agent
    - Test manifest apply: success path, missing manifest path (no deploy), Kubernetes API error (no rollback)
    - Test rollout monitor: success, timeout → rollback initiation
    - Test rollback: dispatch within 5 s, completion within 120 s, pod readiness check, timeout → critical failure, Kubernetes API error during rollback → critical failure
    - Test halt registry: halt on critical failure, reject subsequent commands without executing, resume clears halt
    - File: `tests/unit/deployment_agent/manifest_apply.test.ts`, `rollback.test.ts`, `halt_state.test.ts`
    - _Requirements: 3.1–3.7, 4.1–4.5_

- [x] 5. Checkpoint — deployment layer
  - Ensure all deployment unit and property tests pass before proceeding. Ask the user if questions arise.

- [x] 6. Implement the Incident_Agent
  - [x] 6.1 Implement the RunbookLibrary in `src/agents/incident/runbookLibrary.ts`
    - Implement `register()`, `getLatest()` (returns highest semver for a service name), and `list()`
    - Runbooks are versioned and identified by unique service name
    - _Requirements: 5.5_

  - [x] 6.2 Implement runbook execution in `src/agents/incident/execution.ts`
    - On P1/P2 alert, look up the latest registered runbook within 30 s; if none found, immediately escalate via Slack within 30 s and mark incident as requiring manual action
    - Execute runbook steps sequentially; enforce 300 s timeout (terminate and treat as failure if exceeded)
    - On success: acknowledge PagerDuty incident and emit `IncidentResolvedEvent`
    - On failure or timeout: escalate via Slack within 30 s, leave PagerDuty incident open, emit `IncidentExecutionFailureEvent` (with incidentId, serviceName, failureReason)
    - Ignore P3/P4 alerts (no action taken)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6_

  - [x] 6.3 Write unit tests for Incident_Agent
    - Test P1/P2 success path (runbook found, executed, PagerDuty acked, `IncidentResolvedEvent` emitted)
    - Test P1/P2 no-runbook path (escalation within 30 s, incident marked manual)
    - Test runbook failure path (escalation, PD left open, `IncidentExecutionFailureEvent` emitted)
    - Test runbook 300 s timeout (terminated and treated as failure)
    - Test P3/P4 alerts are ignored (no runbook lookup, no escalation)
    - File: `tests/unit/incident_agent/runbook_execution.test.ts`, `escalation.test.ts`
    - _Requirements: 5.1–5.6_

- [x] 7. Implement the Notification_Agent
  - [x] 7.1 Implement message formatting in `src/agents/notification/formatter.ts`
    - Build `SlackMessage` with Block Kit layout; always include: `eventType`, `orchestratorTimestamp`, `affectedServiceName`, `outcome`
    - For escalation events: include on-call `@mention`; if handle unresolvable, post without mention and append `"(Note: on-call handle unresolvable at delivery time)"`
    - _Requirements: 6.4, 6.6, 6.7_

  - [x] 7.2 Implement message delivery with retry in `src/agents/notification/delivery.ts`
    - Post to Slack within 15 s of receiving a `NotifyCommand`
    - On Slack API error: retry up to 3× with exponential backoff (initial 1 s, cap 8 s, jitter [0.8, 1.2])
    - After exhausting retries: emit `NotificationDeliveryFailureEvent` and log the failure
    - If on-call handle is unresolvable: emit `NotificationDeliveryFailureEvent` with `failureReason = "handle_unresolvable"`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7_

  - [x] 7.3 Write property test for exponential backoff bounds (Slack notification)
    - **Property 7: Exponential Backoff Bounds (Slack Notification)**
    - For any retry attempt index 0–2, `computeRetryDelay(attempt, {initial:1000, max:8000})` must return a value ≥ 1000 ms and ≤ 8000 ms
    - File: `tests/property/backoff.property.test.ts` (extend existing file)
    - **Validates: Requirements 6.5**

  - [x] 7.4 Write property test for Slack message required fields
    - **Property 8: Slack Message Required Fields**
    - For any randomly generated `NotifyCommand`, the formatted `SlackMessage` must contain `eventType`, `orchestratorTimestamp`, `affectedServiceName`, and `outcome`
    - File: `tests/property/event_completeness.property.test.ts` (extend existing file)
    - **Validates: Requirements 6.6**

  - [x] 7.5 Write unit tests for Notification_Agent
    - Test each trigger event type (deployment success, pipeline failure, rollback, incident escalation, polling failure) produces a correctly structured message
    - Test retry logic: Slack 500 error → 3 retries → `NotificationDeliveryFailureEvent`
    - Test handle unresolvable: message posted without mention, failure event emitted with `failureReason = "handle_unresolvable"`
    - File: `tests/unit/notification_agent/message_format.test.ts`, `retry.test.ts`
    - _Requirements: 6.1–6.7_

- [x] 8. Checkpoint — agent layer
  - Ensure all agent unit and property tests pass before proceeding. Ask the user if questions arise.

- [x] 9. Implement the Orchestrator — core routing and correlation
  - [x] 9.1 Implement event ingestion and correlation ID assignment in `src/orchestrator/ingest.ts`
    - On every inbound event, generate a UUID v4 correlation ID and attach it to the event envelope
    - Write a structured log entry per event (event type, source, timestamp, correlation ID)
    - Route events to the correct agent based on `eventType`
    - _Requirements: 8.1, 8.4_

  - [x] 9.2 Implement agent command dispatch in `src/orchestrator/dispatch.ts`
    - Implement `dispatch(command, target)` that delivers commands to the named agent
    - Forward `correlationId` from the originating event into all dispatched commands
    - Handle `PipelineTriggerFailedEvent` → route `NotifyCommand` to Notification_Agent
    - Handle `PipelinePollFailureEvent` → route `NotifyCommand` to Notification_Agent (within 15 s of event receipt)
    - Handle `PipelineCompletedEvent` (success + manifest present) → route `DeploymentCommand` to Deployment_Agent
    - Handle `DeploymentSuccessEvent`, `RollbackEvent`, `IncidentEscalationEvent`, `CriticalFailureEvent` → route `NotifyCommand` to Notification_Agent
    - _Requirements: 1.4, 2.5, 3.1, 6.1, 6.2, 6.3, 6.4, 8.4_

  - [x] 9.3 Write property test for correlation ID propagation
    - **Property 9: Correlation ID Propagation**
    - For any inbound event processed by the Orchestrator, every downstream agent log entry emitted in response must carry the same `correlationId`
    - File: `tests/property/correlation.property.test.ts`
    - **Validates: Requirements 8.4**

  - [x] 9.4 Write unit tests for Orchestrator routing
    - Test each `EventType` routes to the expected agent
    - Test `PipelinePollFailureEvent` routes to Notification_Agent within 15 s
    - Test correlation ID is forwarded through the full dispatch chain
    - File: `tests/unit/orchestrator/routing.test.ts`
    - _Requirements: 1.4, 2.5, 8.1, 8.4_

- [x] 10. Implement the Orchestrator — configuration management
  - [x] 10.1 Implement configuration loading and validation in `src/orchestrator/config.ts`
    - Load all config from the versioned config store at startup; validate type, format, and range for every key
    - On validation failure: log `CONFIG_ERROR key=<key> value=<masked> expected=<type/format/range> reason=<human-readable>` for each failing key and halt startup (exit non-zero)
    - Supported config keys: GitHub repos/webhook secret, Jenkins base URL/token/jobs, Kubernetes cluster credentials/namespaces, PagerDuty token/service-runbook map, Slack token/channels/on-call handles, pipeline `maxDurationSeconds`/`rolloutTimeoutSeconds`
    - Mask sensitive values (API tokens, kubeconfigs, webhook secrets) in all log output
    - _Requirements: 7.1, 7.2, 7.3_

  - [x] 10.2 Implement configuration hot-reload in `src/orchestrator/configReload.ts`
    - Watch for configuration store changes; reload affected keys within 30 s without full restart
    - On reload validation failure: retain previous valid config, continue operating, and log each failing key
    - _Requirements: 7.4, 7.5_

  - [x] 10.3 Write property test for configuration validation completeness
    - **Property 10: Config Validation Completeness**
    - For any config object with one or more absent or invalid keys, the loader must neither apply partial config nor proceed — it must log the failing keys and retain the previous valid state (or halt on startup)
    - File: `tests/property/config.property.test.ts`
    - **Validates: Requirements 7.2, 7.5**

  - [x] 10.4 Write unit tests for configuration management
    - Test startup halt on missing required key (with correct `CONFIG_ERROR` log format)
    - Test startup halt on wrong-type value
    - Test hot-reload applies valid updates within 30 s
    - Test hot-reload retains old config on invalid update and logs failing keys
    - File: `tests/unit/orchestrator/config_validation.test.ts`
    - _Requirements: 7.1–7.5_

- [x] 11. Implement the Orchestrator — health and observability
  - [x] 11.1 Implement heartbeat tracking in `src/orchestrator/health.ts`
    - Send a heartbeat to each agent every 15 s
    - Track `lastHeartbeatAt` per agent; mark agent `unhealthy` if no response within 60 s
    - Mark agent `healthy` when a heartbeat response is received within the 60 s window
    - On transition healthy → unhealthy: emit `AgentHealthDegradedEvent` to Notification_Agent within 15 s
    - Expose `GET /health` endpoint returning `HealthStatus` (agent name + status + last heartbeat timestamp)
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 11.2 Implement Prometheus metrics endpoint in `src/orchestrator/metrics.ts`
    - Expose `GET /metrics` in Prometheus text format
    - Per-agent metrics: `total_events_processed`, `events_by_type` (labeled), `action_success_rate`, `action_latency_ms` (histogram with p50/p99 summary)
    - _Requirements: 9.5_

  - [x] 11.3 Write property test for heartbeat health transition
    - **Property 11: Heartbeat Health Transition**
    - For any agent, if elapsed time since last heartbeat > 60 s → status must be `"unhealthy"`; if a response is received within the 60 s window → status must be `"healthy"`
    - File: `tests/property/health.property.test.ts`
    - **Validates: Requirements 9.2, 9.4**

  - [x] 11.4 Write unit tests for health and observability
    - Test health endpoint returns correct status for each agent in healthy/unhealthy/unknown states
    - Test unhealthy transition after 60 s silence triggers `AgentHealthDegradedEvent` within 15 s
    - Test recovery to healthy when heartbeat resumes
    - Test metrics endpoint emits correct Prometheus labels and histogram buckets
    - File: `tests/unit/orchestrator/health.test.ts`
    - _Requirements: 9.1–9.5_

- [x] 12. Implement audit logging across all agents
  - [x] 12.1 Add structured log entries to all agents in `src/agents/*/` and `src/orchestrator/`
    - Each agent logs every action: action name, input params (masked sensitive values), outcome (`success`|`failure`), timestamp, correlation ID
    - On error: include error message and stack trace in the log entry
    - Configure log retention for ≥ 30 days (log rotation policy or storage backend config)
    - _Requirements: 8.2, 8.3, 8.5_

  - [x] 12.2 Write unit tests for audit logging
    - Test each agent emits a log entry for every action it executes
    - Test sensitive values (API tokens, kubeconfig, webhook secrets) are masked (`***`) in log output
    - Test error log entries include message and stack trace
    - Test correlation ID appears in every log entry for a given event chain
    - File: `tests/unit/*/` (one test per agent log behavior)
    - _Requirements: 8.1–8.5_

- [x] 13. Integration wiring and end-to-end tests
  - [x] 13.1 Wire all components together in `src/index.ts`
    - Instantiate all agents with injected API clients (Jenkins, Kubernetes, Slack, PagerDuty)
    - Instantiate Orchestrator with all agent references, config store, and event bus
    - Start config loader, hot-reload watcher, heartbeat loop, health endpoint, and metrics endpoint
    - _Requirements: 7.1, 9.1, 9.5_

  - [x] 13.2 Write integration test: PR merge → deployment flow
    - Mock GitHub webhook → Jenkins API → Kubernetes API → Slack API
    - Validate full flow: trigger within 60 s, poll, complete, deploy, success notification
    - File: `tests/integration/pipeline_to_deployment.test.ts`
    - _Requirements: 1.1, 2.2, 3.1, 3.3, 6.1_

  - [x] 13.3 Write integration test: incident response flow
    - Mock PagerDuty P1 alert → runbook execution → PagerDuty ack → Slack notification
    - Mock no-runbook path → Slack escalation within 30 s
    - File: `tests/integration/incident_response.test.ts`
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 13.4 Write integration test: config hot-reload
    - Update config store value → verify Orchestrator picks it up within 30 s
    - Update with invalid value → verify old config is retained and error is logged
    - File: `tests/integration/config_reload.test.ts`
    - _Requirements: 7.4, 7.5_

- [x] 14. Final checkpoint — full test suite
  - Ensure all unit, property, and integration tests pass. Verify `GET /health` and `GET /metrics` endpoints respond correctly with mocked agents. Ask the user if questions arise.

---

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Tasks 1.1 and 1.2 are already complete — all types, models, interfaces, and shared utilities exist in `src/`
- All property tests use **fast-check** with `{ numRuns: 100 }` minimum
- Each property test is tagged with a comment referencing the design property number (e.g., `// Property 1: Exponential Backoff Bounds`)
- All sensitive config values (API tokens, kubeconfig, webhook secrets) must be masked as `***` in every log output
- The backoff utility in `src/utils/backoff.ts` is shared between Pipeline_Agent (5 s / 60 s) and Notification_Agent (1 s / 8 s) — parameterized by `{ initial, max }` in milliseconds
- All external API clients are injected via constructor injection; no global singletons
- The `(deploymentName, namespace)` halt state must survive process restarts (persisted store required)
- Pipeline run records and audit logs must be retained for ≥ 30 days (configure storage backend accordingly)
- Requirement 4.4 (rollback API error → critical failure) is handled alongside timeout/dispatch failure in task 4.3

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "2.3", "2.5"] },
    { "id": 2, "tasks": ["2.2", "2.4", "4.1", "6.1"] },
    { "id": 3, "tasks": ["2.6", "4.2", "4.3", "4.4", "6.2", "7.1"] },
    { "id": 4, "tasks": ["4.5", "4.6", "4.7", "4.8", "4.9", "6.3", "7.2"] },
    { "id": 5, "tasks": ["7.3", "7.4", "7.5", "9.1"] },
    { "id": 6, "tasks": ["9.2", "9.3", "9.4", "10.1", "11.1", "11.2"] },
    { "id": 7, "tasks": ["10.2", "10.3", "10.4", "11.3", "11.4", "12.1"] },
    { "id": 8, "tasks": ["12.2", "13.1"] },
    { "id": 9, "tasks": ["13.2", "13.3", "13.4"] }
  ]
}
```
