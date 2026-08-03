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
export declare const SENSITIVE_KEYS: Set<string>;
/**
 * Recursively walk an object and replace values whose key matches a
 * sensitive key (case-insensitive) with the MASK constant.
 *
 * Returns a new object — the original is never mutated.
 */
export declare function maskSensitiveValues(obj: Record<string, unknown>): Record<string, unknown>;
/** Sink function type — receives the final serialised log line. */
export type LogSink = (line: string) => void;
export declare class StructuredLogger {
    private readonly sink;
    constructor(sink?: LogSink);
    debug(entry: LogEntry): void;
    info(entry: LogEntry): void;
    warn(entry: LogEntry): void;
    error(entry: LogEntry): void;
    private write;
    /**
     * Return a copy of the entry with all sensitive values masked.
     */
    private maskEntry;
}
/** Default logger instance writing to stdout. Replace the sink for testing. */
export declare const logger: StructuredLogger;
//# sourceMappingURL=logger.d.ts.map