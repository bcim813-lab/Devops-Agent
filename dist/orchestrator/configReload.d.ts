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
export type ConfigValidator = (raw: Record<string, unknown>) => {
    valid: true;
    config: SystemConfig;
} | {
    valid: false;
    errors: ConfigError[];
};
/**
 * Manages configuration hot-reloads.
 *
 * Polls/watches the config store and reloads within 30 s of detecting a change.
 * On validation failure: retains previous valid config and logs each failing key.
 *
 * Requirements: 7.4, 7.5
 */
export declare class ConfigReloader {
    private readonly store;
    private readonly validate;
    private readonly onUpdate;
    private readonly logger;
    /** How often to poll the config store (ms). Also serves as the max reload latency. */
    private readonly pollIntervalMs;
    private currentConfig;
    private pollTimer;
    private unsubscribe;
    private reloadInProgress;
    constructor(store: ConfigStore, validate: ConfigValidator, initialConfig: SystemConfig, onUpdate: ConfigUpdateHandler, options?: {
        pollIntervalMs?: number;
        logger?: StructuredLogger;
    });
    /**
     * Start watching for configuration changes.
     *
     * Combines subscription-based push notifications (when the store supports them)
     * with a periodic poll to guarantee we never miss a change.
     *
     * Requirement 7.4: Reload affected keys within 30 s without full restart.
     */
    start(): void;
    /**
     * Stop watching for configuration changes.
     */
    stop(): void;
    /**
     * Get the current (last successfully validated) config.
     */
    getCurrentConfig(): SystemConfig;
    /**
     * Manually trigger a reload. Useful for tests or forced refreshes.
     */
    reload(): Promise<void>;
    private _reload;
}
//# sourceMappingURL=configReload.d.ts.map