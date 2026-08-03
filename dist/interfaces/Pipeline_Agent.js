"use strict";
/**
 * Pipeline_Agent interface — manages Jenkins/GitHub Actions pipeline lifecycle.
 *
 * Key behaviors:
 * - Triggers pipeline within 60 s of a PR merge event.
 * - Retries trigger up to 3× with exponential backoff (initial 5 s, cap 60 s, jitter [0.8, 1.2]).
 * - Polls Jenkins every 30 s; retries poll once after 10 s on failure.
 * - Emits PipelineTimeoutEvent when max_duration_seconds is exceeded (if configured).
 * - Emits PipelineCompletedEvent within 10 s of detecting a terminal state.
 * - Retains pipeline run records for ≥ 30 days.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=Pipeline_Agent.js.map