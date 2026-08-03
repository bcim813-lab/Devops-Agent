"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigReloader = void 0;
const logger_1 = require("../utils/logger");
/**
 * Manages configuration hot-reloads.
 *
 * Polls/watches the config store and reloads within 30 s of detecting a change.
 * On validation failure: retains previous valid config and logs each failing key.
 *
 * Requirements: 7.4, 7.5
 */
class ConfigReloader {
    constructor(store, validate, initialConfig, onUpdate, options = {}) {
        this.pollTimer = null;
        this.unsubscribe = null;
        this.reloadInProgress = false;
        this.store = store;
        this.validate = validate;
        this.onUpdate = onUpdate;
        this.currentConfig = initialConfig;
        this.logger = options.logger ?? new logger_1.StructuredLogger();
        // Default: poll every 10 s to stay well within the 30 s SLA.
        this.pollIntervalMs = options.pollIntervalMs ?? 10000;
    }
    /**
     * Start watching for configuration changes.
     *
     * Combines subscription-based push notifications (when the store supports them)
     * with a periodic poll to guarantee we never miss a change.
     *
     * Requirement 7.4: Reload affected keys within 30 s without full restart.
     */
    start() {
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
    stop() {
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
    getCurrentConfig() {
        return this.currentConfig;
    }
    /**
     * Manually trigger a reload. Useful for tests or forced refreshes.
     */
    async reload() {
        return this._reload("manual");
    }
    // ── Private ─────────────────────────────────────────────────────────────
    async _reload(trigger) {
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
            let raw;
            try {
                raw = await this.store.fetchLatest();
            }
            catch (err) {
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
            if (elapsedMs > 30000) {
                this.logger.warn({
                    action: "configReloader.reload",
                    outcome: "slow_reload",
                    trigger,
                    elapsedMs,
                    maxAllowedMs: 30000,
                });
            }
        }
        finally {
            this.reloadInProgress = false;
        }
    }
}
exports.ConfigReloader = ConfigReloader;
//# sourceMappingURL=configReload.js.map