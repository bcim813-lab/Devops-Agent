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
import type { PipelineRunRecord } from "../../types/models";
/** Retention period in milliseconds: 30 days */
export declare const RETENTION_MS: number;
/** Default cleanup interval in milliseconds: 1 hour */
export declare const DEFAULT_CLEANUP_INTERVAL_MS: number;
/** Default path for the JSON persistence file */
export declare const DEFAULT_DATA_FILE: string;
/**
 * Compute `retainUntil` as triggerTimestamp + 30 days.
 * Returns an ISO 8601 string.
 */
export declare function computeRetainUntil(triggerTimestamp: string): string;
export interface PipelineRecordStoreOptions {
    /** Absolute or relative path to the JSON persistence file. */
    dataFilePath?: string;
    /** Interval in ms at which the cleanup job fires. 0 disables auto-cleanup. */
    cleanupIntervalMs?: number;
}
export declare class PipelineRecordStore {
    private readonly records;
    private readonly dataFilePath;
    private cleanupTimer;
    constructor(options?: PipelineRecordStoreOptions);
    /**
     * Persist a pipeline run record.
     *
     * If a record for the same `pipelineRunId` already exists it is
     * overwritten (idempotent upsert).  `retainUntil` is always set to
     * `triggerTimestamp + 30 days` — callers may omit it and it will be
     * computed here.
     */
    save(record: PipelineRunRecord): void;
    /**
     * Retrieve a single record by `pipelineRunId`.
     * Returns `undefined` if no record exists for the given ID.
     */
    get(runId: string): PipelineRunRecord | undefined;
    /**
     * Return all stored records as an array (order is not guaranteed).
     */
    list(): PipelineRunRecord[];
    /**
     * Remove all records whose `retainUntil` is strictly in the past.
     *
     * A record at exactly `Date.now()` is NOT removed (≤ boundary kept).
     * Returns the number of records deleted.
     */
    cleanup(): number;
    /**
     * Stop the background cleanup timer (if running) and release resources.
     * Call this before letting the store go out of scope in tests or on
     * graceful shutdown.
     */
    destroy(): void;
    /**
     * Load records from the JSON file into the in-memory map.
     * Silently ignores a missing file (first-run scenario).
     */
    private _load;
    /**
     * Flush the in-memory map to the JSON file.
     * Creates the parent directory if it does not yet exist.
     */
    private _persist;
}
//# sourceMappingURL=records.d.ts.map