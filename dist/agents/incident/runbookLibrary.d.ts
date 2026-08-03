/**
 * Incident_Agent — runbook library.
 *
 * Manages a versioned registry of runbooks, indexed by service name.
 * Supports semantic versioning; getLatest() returns the highest version.
 *
 * Requirements: 5.5
 */
import { StructuredLogger } from "../../utils/logger";
import type { Runbook } from "../../types/models";
/**
 * Configuration for the RunbookLibrary.
 */
export interface RunbookLibraryOptions {
    /** Logger instance. Defaults to the module logger. */
    logger?: StructuredLogger;
}
/**
 * Registry of versioned runbooks.
 *
 * Each service may have multiple runbook versions. The library provides
 * registration, lookup by exact version, and retrieval of the latest version.
 *
 * Requirement: 5.5
 */
export declare class RunbookLibrary {
    /** Maps service name → array of registered runbooks (kept sorted by version DESC) */
    private readonly runbooks;
    private readonly logger;
    constructor(options?: RunbookLibraryOptions);
    /**
     * Register a new runbook version.
     *
     * If a runbook with the same serviceName and version already exists,
     * it is replaced (idempotent upsert).
     *
     * Requirement: 5.5
     */
    register(runbook: Runbook): void;
    /**
     * Retrieve a runbook by exact service name and version.
     *
     * Requirement: 5.5
     */
    get(serviceName: string, version: string): Runbook | undefined;
    /**
     * Retrieve the highest-version runbook for a service.
     *
     * Requirement: 5.5
     */
    getLatest(serviceName: string): Runbook | undefined;
    /**
     * List all registered runbook versions for a service.
     */
    listVersions(serviceName: string): Runbook[];
    /**
     * List all service names that have registered runbooks.
     */
    listServices(): string[];
}
//# sourceMappingURL=runbookLibrary.d.ts.map