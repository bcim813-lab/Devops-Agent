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

import * as fs from "fs";
import * as path from "path";
import type { PipelineRunRecord } from "../../types/models";
import { logger } from "../../utils/logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Retention period in milliseconds: 30 days */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Default cleanup interval in milliseconds: 1 hour */
export const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Default path for the JSON persistence file */
export const DEFAULT_DATA_FILE = path.resolve(".data", "pipeline-records.json");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute `retainUntil` as triggerTimestamp + 30 days.
 * Returns an ISO 8601 string.
 */
export function computeRetainUntil(triggerTimestamp: string): string {
  const triggerMs = Date.parse(triggerTimestamp);
  return new Date(triggerMs + RETENTION_MS).toISOString();
}

// ---------------------------------------------------------------------------
// PipelineRecordStore
// ---------------------------------------------------------------------------

export interface PipelineRecordStoreOptions {
  /** Absolute or relative path to the JSON persistence file. */
  dataFilePath?: string;
  /** Interval in ms at which the cleanup job fires. 0 disables auto-cleanup. */
  cleanupIntervalMs?: number;
}

export class PipelineRecordStore {
  private readonly records: Map<string, PipelineRunRecord> = new Map();
  private readonly dataFilePath: string;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: PipelineRecordStoreOptions = {}) {
    this.dataFilePath = options.dataFilePath ?? DEFAULT_DATA_FILE;
    const intervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;

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
  save(record: PipelineRunRecord): void {
    // Ensure retainUntil is always correctly set regardless of what the
    // caller supplied (defensive: the field should already be correct, but
    // we recompute to guarantee the invariant).
    const retainUntil = computeRetainUntil(record.triggerTimestamp);
    const stored: PipelineRunRecord = { ...record, retainUntil };

    this.records.set(stored.pipelineRunId, stored);
    this._persist();

    logger.info({
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
  get(runId: string): PipelineRunRecord | undefined {
    return this.records.get(runId);
  }

  /**
   * Return all stored records as an array (order is not guaranteed).
   */
  list(): PipelineRunRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * Remove all records whose `retainUntil` is strictly in the past.
   *
   * A record at exactly `Date.now()` is NOT removed (≤ boundary kept).
   * Returns the number of records deleted.
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [id, record] of this.records) {
      if (Date.parse(record.retainUntil) < now) {
        this.records.delete(id);
        removed++;
        logger.info({
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
  destroy(): void {
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
  private _load(): void {
    try {
      const raw = fs.readFileSync(this.dataFilePath, "utf-8");
      const parsed: unknown = JSON.parse(raw);

      if (!Array.isArray(parsed)) {
        logger.warn({
          action: "PipelineRecordStore._load",
          outcome: "failure",
          errorMessage: "Expected a JSON array in persistence file; skipping load.",
          dataFilePath: this.dataFilePath,
        });
        return;
      }

      for (const item of parsed) {
        const record = item as PipelineRunRecord;
        if (record.pipelineRunId) {
          this.records.set(record.pipelineRunId, record);
        }
      }

      logger.info({
        action: "PipelineRecordStore._load",
        outcome: "success",
        count: this.records.size,
        dataFilePath: this.dataFilePath,
      });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // First run — no file yet, start with an empty store.
        return;
      }
      logger.error({
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
  private _persist(): void {
    try {
      const dir = path.dirname(this.dataFilePath);
      fs.mkdirSync(dir, { recursive: true });

      const data = JSON.stringify(Array.from(this.records.values()), null, 2);
      fs.writeFileSync(this.dataFilePath, data, "utf-8");
    } catch (err: unknown) {
      logger.error({
        action: "PipelineRecordStore._persist",
        outcome: "failure",
        errorMessage: err instanceof Error ? err.message : String(err),
        stackTrace: err instanceof Error ? err.stack : undefined,
        dataFilePath: this.dataFilePath,
      });
    }
  }
}
