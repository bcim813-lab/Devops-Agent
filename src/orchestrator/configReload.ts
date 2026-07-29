/**
 * Orchestrator — configuration hot-reload.
 *
 * Watches for configuration store changes and reloads affected keys
 * within 30 seconds without a full restart.
 *
 * On reload validation failure:
 *  - Retains previous valid config.
 *  - Continues operating.
 *  - Logs each failing key.
 *
 * Requirements: 7.4, 7.5
 */

import { StructuredLogger } from "../utils/logger";
import type { SystemConfig, ConfigError } from "../types/models";

/**
 * Callback invoked when a validated new config is ready.
 */
export type ConfigUpdateHandler = (newConfig: SystemConfig) => void;

/**
 * Abstract store interface — concrete implementations wrap environment
 * variables, etcd, AWS Parameter Store, etc.
 */
export interface ConfigStore {
  /**
   * Fetch the latest raw config values from the backing store.
   * Returns a plain object whose keys mirror SystemConfig.
   */
  fetchLatest(): Promise<Record<string, unknown>>;

  /**
   * Subscribe to change notifications from the backing store.
   * The callback is invoked when the store signals a change.
   * Returns an unsubscribe function.
   */
  subscribe(onChange: () => void): () => void;
}

/**
 * Validates a raw config object and returns a typed SystemConfig on success,
 * or an array of ConfigErrors on failure.
 */
export type ConfigValidator = (
  raw: Record<string, unknown>
) => { valid: true; config: SystemConfig } | { valid: false; errors: ConfigError[] };

/**
 * Manages configuration hot-reloads.
 *
 * Polls/watches the config store and reloads within 30 s of detecting a change.
 * On validation failure: retains previous valid config and logs each failing key.
 *
 * Requirements: 7.4, 7.5
 */
export class ConfigReloader {
  private readonly store: ConfigStore;
  private readonly validate: ConfigValidator;
  private readonly onUpdate: ConfigUpdateHandler;
  private readonly logger: StructuredLogger;

  /** How often to poll the config store (ms). Also serves as the max reload latency. */
  private readonly pollIntervalMs: number;

  private currentConfig: SystemConfig;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private reloadInProgress = false;

  constructor(
    store: ConfigStore,
    validate: ConfigValidator,
    initialConfig: SystemConfig,
    onUpdate: ConfigUpdateHandler,
    options: { pollIntervalMs?: number; logger?: StructuredLogger } = {}
  ) {
    this.store = store;
    this.validate = validate;
    this.onUpdate = onUpdate;
    this.currentConfig = initialConfig;
    this.logger = options.logger ?? new StructuredLogger();
    // Default: poll every 10 s to stay well within the 30 s SLA.
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
  }

  /**
   * Start watching for configuration changes.
   *
   * Combines subscription-based push notifications (when the store supports them)
   * with a periodic poll to guarantee we never miss a change.
   *
   * Requirement 7.4: Reload affected keys within 30 s without full restart.
   */
  start(): void {
    // Subscribe to push notifications
    this.unsubscribe = this.store.subscribe(() => {
      void this._reload("push");
    });

    // Also poll on a fixed interval as a safety net
    this.pollTimer = setInterval(() => {
      void this._reload("poll");
    }, this.pollIntervalMs);

    if (this.pollTimer.unref) {
      this.pollTimer.unref();
    }

    this.logger.info({
      action: "configReloader.start",
      outcome: "success",
      pollIntervalMs: this.pollIntervalMs,
    });
  }

  /**
   * Stop watching for configuration changes.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.logger.debug({
      action: "configReloader.stop",
      outcome: "success",
    });
  }

  /**
   * Get the current (last successfully validated) config.
   */
  getCurrentConfig(): SystemConfig {
    return this.currentConfig;
  }

  /**
   * Manually trigger a reload. Useful for tests or forced refreshes.
   */
  async reload(): Promise<void> {
    return this._reload("manual");
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private async _reload(trigger: "push" | "poll" | "manual"): Promise<void> {
    // Prevent concurrent reloads
    if (this.reloadInProgress) {
      return;
    }

    this.reloadInProgress = true;

    try {
      const reloadStart = Date.now();

      this.logger.info({
        action: "configReloader.reload",
        outcome: "pending",
        trigger,
      });

      // Fetch latest raw values
      let raw: Record<string, unknown>;
      try {
        raw = await this.store.fetchLatest();
      } catch (err) {
        this.logger.error({
          action: "configReloader.reload.fetch",
          outcome: "failure",
          trigger,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
        return;
      }

      // Validate
      const result = this.validate(raw);

      if (!result.valid) {
        // Requirement 7.5: On failure, retain previous valid config and log each failing key
        for (const configError of result.errors) {
          this.logger.error({
            action: "configReloader.reload.validate",
            outcome: "CONFIG_ERROR",
            key: configError.key,
            expectedType: configError.expectedType,
            reason: configError.reason,
            // Mask the actual invalid value
            value: "***",
          });
        }

        this.logger.warn({
          action: "configReloader.reload",
          outcome: "rejected",
          trigger,
          failingKeys: result.errors.map((e) => e.key),
          message: "Retaining previous valid config",
        });

        return;
      }

      // Valid — apply and notify
      this.currentConfig = result.config;
      this.onUpdate(result.config);

      const elapsedMs = Date.now() - reloadStart;
      this.logger.info({
        action: "configReloader.reload",
        outcome: "success",
        trigger,
        elapsedMs,
      });

      // Requirement 7.4: Log a warning if reload took longer than 30 s
      if (elapsedMs > 30_000) {
        this.logger.warn({
          action: "configReloader.reload",
          outcome: "slow_reload",
          trigger,
          elapsedMs,
          maxAllowedMs: 30_000,
        });
      }
    } finally {
      this.reloadInProgress = false;
    }
  }
}
