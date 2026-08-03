/**
 * Orchestrator configuration management.
 *
 * Loads and validates all system configuration from environment/store.
 * Masks sensitive values in all log output.
 *
 * Requirements: 7.1, 7.2, 7.3
 */
import { StructuredLogger } from "../utils/logger";
import type { SystemConfig } from "../types/models";
/**
 * Configuration loader and validator.
 *
 * Loads all config keys and validates type, format, and range for each key.
 * On validation failure, logs a CONFIG_ERROR for each failing key and halts startup.
 *
 * Requirements: 7.1, 7.2, 7.3
 */
export declare class ConfigLoader {
    private readonly logger;
    constructor(logger?: StructuredLogger);
    /**
     * Load and validate all configuration from environment/store.
     *
     * On validation failure: log CONFIG_ERROR key=<key> ... and throw ConfigError.
     * On success: return the validated config.
     *
     * Requirements: 7.1, 7.2, 7.3
     */
    load(): Promise<SystemConfig>;
    private _parseJobMap;
    private _parseServiceMap;
    private _parseChannelMap;
    private _parseHandleMap;
    private _parsePositiveInt;
}
//# sourceMappingURL=config.d.ts.map