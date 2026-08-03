"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.StructuredLogger = exports.maskSensitiveValues = exports.SENSITIVE_KEYS = void 0;
/**
 * Canonical lowercase sensitive key names.
 * Matching is performed case-insensitively by lowercasing the actual key
 * before checking membership.
 */
exports.SENSITIVE_KEYS = new Set([
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
function isSensitiveKey(key) {
    return exports.SENSITIVE_KEYS.has(key.toLowerCase());
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
function maskSensitiveValues(obj) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (isSensitiveKey(key)) {
            result[key] = MASK;
        }
        else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            result[key] = maskSensitiveValues(value);
        }
        else if (Array.isArray(value)) {
            result[key] = value.map((item) => item !== null && typeof item === "object"
                ? maskSensitiveValues(item)
                : item);
        }
        else {
            result[key] = value;
        }
    }
    return result;
}
exports.maskSensitiveValues = maskSensitiveValues;
/** Default sink writes to stdout. */
const defaultSink = (line) => process.stdout.write(line + "\n");
class StructuredLogger {
    constructor(sink = defaultSink) {
        this.sink = sink;
    }
    // -------------------------------------------------------------------------
    // Public log methods
    // -------------------------------------------------------------------------
    debug(entry) {
        this.write("debug", entry);
    }
    info(entry) {
        this.write("info", entry);
    }
    warn(entry) {
        this.write("warn", entry);
    }
    error(entry) {
        this.write("error", entry);
    }
    // -------------------------------------------------------------------------
    // Core write
    // -------------------------------------------------------------------------
    write(level, entry) {
        const masked = this.maskEntry(entry);
        const logLine = {
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
            if (key !== "action" &&
                key !== "outcome" &&
                key !== "timestamp" &&
                key !== "correlationId" &&
                key !== "params" &&
                key !== "errorMessage" &&
                key !== "stackTrace") {
                logLine[key] = masked[key];
            }
        }
        this.sink(JSON.stringify(logLine));
    }
    /**
     * Return a copy of the entry with all sensitive values masked.
     */
    maskEntry(entry) {
        const { params, ...rest } = entry;
        const maskedRest = maskSensitiveValues(rest);
        return {
            ...maskedRest,
            ...(params !== undefined && {
                params: maskSensitiveValues(params),
            }),
        };
    }
}
exports.StructuredLogger = StructuredLogger;
// ---------------------------------------------------------------------------
// Default singleton logger
// ---------------------------------------------------------------------------
/** Default logger instance writing to stdout. Replace the sink for testing. */
exports.logger = new StructuredLogger();
//# sourceMappingURL=logger.js.map