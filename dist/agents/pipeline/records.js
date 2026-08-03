"use strict";
/**
 * Pipeline run record persistence.
 *
 * Stores `PipelineRunRecord` entries in an in-memory Map, flushed to a JSON
 * file at `.data/pipeline-records.json` after every write.  A TTL-based
 * cleanup job runs on a configurable interval (default: every hour) and
 * removes records whose `retainUntil` timestamp is in the past.
 *
 * Retention policy (Requirement 2.4):
 *   retainUntil = triggerTimestamp + 30 days
 *
 * Records at exactly 30 days are still present; records whose retainUntil
 * has already elapsed are eligible for removal on the next cleanup pass.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PipelineRecordStore = exports.computeRetainUntil = exports.DEFAULT_DATA_FILE = exports.DEFAULT_CLEANUP_INTERVAL_MS = exports.RETENTION_MS = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("../../utils/logger");
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** Retention period in milliseconds: 30 days */
exports.RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Default cleanup interval in milliseconds: 1 hour */
exports.DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
/** Default path for the JSON persistence file */
exports.DEFAULT_DATA_FILE = path.resolve(".data", "pipeline-records.json");
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Compute `retainUntil` as triggerTimestamp + 30 days.
 * Returns an ISO 8601 string.
 */
function computeRetainUntil(triggerTimestamp) {
    const triggerMs = Date.parse(triggerTimestamp);
    return new Date(triggerMs + exports.RETENTION_MS).toISOString();
}
exports.computeRetainUntil = computeRetainUntil;
class PipelineRecordStore {
    constructor(options = {}) {
        this.records = new Map();
        this.cleanupTimer = null;
        this.dataFilePath = options.dataFilePath ?? exports.DEFAULT_DATA_FILE;
        const intervalMs = options.cleanupIntervalMs ?? exports.DEFAULT_CLEANUP_INTERVAL_MS;
        this._load();
        if (intervalMs > 0) {
            this.cleanupTimer = setInterval(() => this.cleanup(), intervalMs);
            // Allow the Node.js process to exit even while the timer is active.
            if (this.cleanupTimer.unref) {
                this.cleanupTimer.unref();
            }
        }
    }
    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------
    /**
     * Persist a pipeline run record.
     *
     * If a record for the same `pipelineRunId` already exists it is
     * overwritten (idempotent upsert).  `retainUntil` is always set to
     * `triggerTimestamp + 30 days` — callers may omit it and it will be
     * computed here.
     */
    save(record) {
        // Ensure retainUntil is always correctly set regardless of what the
        // caller supplied (defensive: the field should already be correct, but
        // we recompute to guarantee the invariant).
        const retainUntil = computeRetainUntil(record.triggerTimestamp);
        const stored = { ...record, retainUntil };
        this.records.set(stored.pipelineRunId, stored);
        this._persist();
        logger_1.logger.info({
            action: "PipelineRecordStore.save",
            outcome: "success",
            pipelineRunId: stored.pipelineRunId,
            terminalState: stored.terminalState,
            retainUntil: stored.retainUntil,
        });
    }
    /**
     * Retrieve a single record by `pipelineRunId`.
     * Returns `undefined` if no record exists for the given ID.
     */
    get(runId) {
        return this.records.get(runId);
    }
    /**
     * Return all stored records as an array (order is not guaranteed).
     */
    list() {
        return Array.from(this.records.values());
    }
    /**
     * Remove all records whose `retainUntil` is strictly in the past.
     *
     * A record at exactly `Date.now()` is NOT removed (≤ boundary kept).
     * Returns the number of records deleted.
     */
    cleanup() {
        const now = Date.now();
        let removed = 0;
        for (const [id, record] of this.records) {
            if (Date.parse(record.retainUntil) < now) {
                this.records.delete(id);
                removed++;
                logger_1.logger.info({
                    action: "PipelineRecordStore.cleanup",
                    outcome: "success",
                    pipelineRunId: id,
                    retainUntil: record.retainUntil,
                    removedAt: new Date(now).toISOString(),
                });
            }
        }
        if (removed > 0) {
            this._persist();
        }
        return removed;
    }
    /**
     * Stop the background cleanup timer (if running) and release resources.
     * Call this before letting the store go out of scope in tests or on
     * graceful shutdown.
     */
    destroy() {
        if (this.cleanupTimer !== null) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }
    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------
    /**
     * Load records from the JSON file into the in-memory map.
     * Silently ignores a missing file (first-run scenario).
     */
    _load() {
        try {
            const raw = fs.readFileSync(this.dataFilePath, "utf-8");
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                logger_1.logger.warn({
                    action: "PipelineRecordStore._load",
                    outcome: "failure",
                    errorMessage: "Expected a JSON array in persistence file; skipping load.",
                    dataFilePath: this.dataFilePath,
                });
                return;
            }
            for (const item of parsed) {
                const record = item;
                if (record.pipelineRunId) {
                    this.records.set(record.pipelineRunId, record);
                }
            }
            logger_1.logger.info({
                action: "PipelineRecordStore._load",
                outcome: "success",
                count: this.records.size,
                dataFilePath: this.dataFilePath,
            });
        }
        catch (err) {
            if (err.code === "ENOENT") {
                // First run — no file yet, start with an empty store.
                return;
            }
            logger_1.logger.error({
                action: "PipelineRecordStore._load",
                outcome: "failure",
                errorMessage: err instanceof Error ? err.message : String(err),
                stackTrace: err instanceof Error ? err.stack : undefined,
                dataFilePath: this.dataFilePath,
            });
        }
    }
    /**
     * Flush the in-memory map to the JSON file.
     * Creates the parent directory if it does not yet exist.
     */
    _persist() {
        try {
            const dir = path.dirname(this.dataFilePath);
            fs.mkdirSync(dir, { recursive: true });
            const data = JSON.stringify(Array.from(this.records.values()), null, 2);
            fs.writeFileSync(this.dataFilePath, data, "utf-8");
        }
        catch (err) {
            logger_1.logger.error({
                action: "PipelineRecordStore._persist",
                outcome: "failure",
                errorMessage: err instanceof Error ? err.message : String(err),
                stackTrace: err instanceof Error ? err.stack : undefined,
                dataFilePath: this.dataFilePath,
            });
        }
    }
}
exports.PipelineRecordStore = PipelineRecordStore;
//# sourceMappingURL=records.js.map