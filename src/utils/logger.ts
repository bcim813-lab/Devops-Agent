/**
 * Structured logger with credential/token masking.
 *
 * Masks sensitive values before writing log entries to stdout (or a
 * configurable sink), satisfying Requirements 8.1, 8.2, and 8.4.
 *
 * Keys that are always masked (value replaced with "***"), matched
 * case-insensitively:
 *   apiToken, botToken, webhookSecret, kubeconfig,
 *   password, secret, token, credential
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  /** Human-readable name of the operation being logged. */
  action: string;
  /** Input parameters for the action. Sensitive values will be masked. */
  params?: Record<string, unknown>;
  /** Result of the action. */
  outcome: "success" | "failure" | "pending" | string;
  /** ISO 8601 timestamp — defaults to now if omitted. */
  timestamp?: string;
  /** Correlation ID propagated from the originating inbound event. */
  correlationId?: string;
  /** Error message if the action failed. */
  errorMessage?: string;
  /** Stack trace if the action produced an error. */
  stackTrace?: string;
  /** Any additional structured fields. */
  [key: string]: unknown;
}

/**
 * Canonical lowercase sensitive key names.
 * Matching is performed case-insensitively by lowercasing the actual key
 * before checking membership.
 */
export const SENSITIVE_KEYS = new Set<string>([
  "apitoken",
  "bottoken",
  "webhooksecret",
  "kubeconfig",
  "password",
  "secret",
  "token",
  "credential",
]);

/** Replacement value for masked fields. */
const MASK = "***";

/**
 * Returns true if `key` is a sensitive key (case-insensitive comparison).
 */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

// ---------------------------------------------------------------------------
// Masking helpers
// ---------------------------------------------------------------------------

/**
 * Recursively walk an object and replace values whose key matches a
 * sensitive key (case-insensitive) with the MASK constant.
 *
 * Returns a new object — the original is never mutated.
 */
export function maskSensitiveValues(
  obj: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key)) {
      result[key] = MASK;
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = maskSensitiveValues(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item !== null && typeof item === "object"
          ? maskSensitiveValues(item as Record<string, unknown>)
          : item
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

/** Sink function type — receives the final serialised log line. */
export type LogSink = (line: string) => void;

/** Default sink writes to stdout. */
const defaultSink: LogSink = (line: string) => process.stdout.write(line + "\n");

export class StructuredLogger {
  private readonly sink: LogSink;

  constructor(sink: LogSink = defaultSink) {
    this.sink = sink;
  }

  // -------------------------------------------------------------------------
  // Public log methods
  // -------------------------------------------------------------------------

  debug(entry: LogEntry): void {
    this.write("debug", entry);
  }

  info(entry: LogEntry): void {
    this.write("info", entry);
  }

  warn(entry: LogEntry): void {
    this.write("warn", entry);
  }

  error(entry: LogEntry): void {
    this.write("error", entry);
  }

  // -------------------------------------------------------------------------
  // Core write
  // -------------------------------------------------------------------------

  private write(level: LogLevel, entry: LogEntry): void {
    const masked = this.maskEntry(entry);

    const logLine: Record<string, unknown> = {
      level,
      action: masked.action,
      outcome: masked.outcome,
      timestamp: masked.timestamp ?? new Date().toISOString(),
      ...(masked.correlationId !== undefined && { correlationId: masked.correlationId }),
      ...(masked.params !== undefined && { params: masked.params }),
      ...(masked.errorMessage !== undefined && { errorMessage: masked.errorMessage }),
      ...(masked.stackTrace !== undefined && { stackTrace: masked.stackTrace }),
    };

    // Include any extra fields (already masked via maskEntry)
    for (const key of Object.keys(masked)) {
      if (
        key !== "action" &&
        key !== "outcome" &&
        key !== "timestamp" &&
        key !== "correlationId" &&
        key !== "params" &&
        key !== "errorMessage" &&
        key !== "stackTrace"
      ) {
        logLine[key] = masked[key];
      }
    }

    this.sink(JSON.stringify(logLine));
  }

  /**
   * Return a copy of the entry with all sensitive values masked.
   */
  private maskEntry(entry: LogEntry): LogEntry {
    const { params, ...rest } = entry;

    const maskedRest = maskSensitiveValues(rest as Record<string, unknown>);

    return {
      ...(maskedRest as Omit<LogEntry, "params">),
      ...(params !== undefined && {
        params: maskSensitiveValues(params),
      }),
    } as LogEntry;
  }
}

// ---------------------------------------------------------------------------
// Default singleton logger
// ---------------------------------------------------------------------------

/** Default logger instance writing to stdout. Replace the sink for testing. */
export const logger = new StructuredLogger();
