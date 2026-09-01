/**
 * Incident_Agent — runbook library.
 *
 * Manages a versioned registry of runbooks, indexed by service name.
 * Supports semantic versioning; getLatest() returns the highest version.
 *
 * Requirements: 5.5
 */

import { StructuredLogger, logger as defaultLogger } from "../../utils/logger";
import type { Runbook } from "../../types/models";

/**
 * Parses a semantic version string (e.g. "1.2.3") into [major, minor, patch].
 * Returns [0, 0, 0] if parsing fails.
 */
function parseVersion(versionStr: string): [number, number, number] {
  const parts = versionStr.split(".");
  if (parts.length !== 3) return [0, 0, 0];

  const [maj, min, pat] = parts.map((p) => parseInt(p, 10));
  return [isNaN(maj) ? 0 : maj, isNaN(min) ? 0 : min, isNaN(pat) ? 0 : pat];
}

/**
 * Compare two semantic versions. Returns:
 * - negative if v1 < v2
 * - 0 if v1 == v2
 * - positive if v1 > v2
 */
function compareVersions(v1: string, v2: string): number {
  const [maj1, min1, pat1] = parseVersion(v1);
  const [maj2, min2, pat2] = parseVersion(v2);

  if (maj1 !== maj2) return maj1 - maj2;
  if (min1 !== min2) return min1 - min2;
  return pat1 - pat2;
}

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
export class RunbookLibrary {
  /** Maps service name → array of registered runbooks (kept sorted by version DESC) */
  private readonly runbooks: Map<string, Runbook[]> = new Map();
  private readonly logger: StructuredLogger;

  constructor(options: RunbookLibraryOptions = {}) {
    this.logger = options.logger ?? defaultLogger;
  }

  /**
   * Register a new runbook version.
   *
   * If a runbook with the same serviceName and version already exists,
   * it is replaced (idempotent upsert).
   *
   * Requirement: 5.5
   */
  register(runbook: Runbook): void {
    const { serviceName, version } = runbook;

    // Validate timeoutSeconds
    if (runbook.timeoutSeconds > 300) {
      this.logger.warn({
        action: "RunbookLibrary.register",
        outcome: "skipped",
        reason: "timeoutSeconds exceeds 300",
        params: { serviceName, version, timeoutSeconds: runbook.timeoutSeconds },
      });
      return;
    }

    let versions = this.runbooks.get(serviceName);
    if (!versions) {
      versions = [];
      this.runbooks.set(serviceName, versions);
    }

    // Remove existing version if present
    const existing = versions.findIndex((r) => r.version === version);
    if (existing >= 0) {
      versions.splice(existing, 1);
    }

    // Add new runbook and keep sorted by version (descending)
    versions.push(runbook);
    versions.sort((a, b) => compareVersions(b.version, a.version));

    this.logger.info({
      action: "RunbookLibrary.register",
      outcome: "success",
      params: { serviceName, version, steps: runbook.steps.length },
    });
  }

  /**
   * Retrieve a runbook by exact service name and version.
   *
   * Requirement: 5.5
   */
  get(serviceName: string, version: string): Runbook | undefined {
    const versions = this.runbooks.get(serviceName);
    if (!versions) return undefined;

    return versions.find((r) => r.version === version);
  }

  /**
   * Retrieve the highest-version runbook for a service.
   *
   * Requirement: 5.5
   */
  getLatest(serviceName: string): Runbook | undefined {
    const versions = this.runbooks.get(serviceName);
    if (!versions || versions.length === 0) return undefined;

    // Already sorted descending, so [0] is the latest
    return versions[0];
  }

  /**
   * List all registered runbook versions for a service.
   */
  listVersions(serviceName: string): Runbook[] {
    const versions = this.runbooks.get(serviceName);
    return versions ? [...versions] : [];
  }

  /**
   * List all service names that have registered runbooks.
   */
  listServices(): string[] {
    return Array.from(this.runbooks.keys());
  }
}
