/**
 * RunbookLibrary interface — a pluggable registry of runbooks keyed by service name.
 *
 * Key behaviors:
 * - getLatest() returns the runbook with the highest semver for the given service name,
 *   or undefined if none is registered.
 * - Runbooks are versioned and identified by a unique (serviceName, version) pair.
 * - The Incident_Agent always executes the latest registered version.
 */

import type { Runbook } from "../types/models";

export interface RunbookLibrary {
  /**
   * Returns the runbook with the highest semantic version for the given service name.
   * Returns undefined if no runbook is registered for the service.
   */
  getLatest(serviceName: string): Runbook | undefined;

  /**
   * Register a runbook in the library.
   * If a runbook with the same (serviceName, version) already exists, it is replaced.
   */
  register(runbook: Runbook): void;

  /**
   * Returns all registered service names.
   */
  listServices(): string[];

  /**
   * Returns all registered runbook versions for a given service name.
   */
  listVersions(serviceName: string): Runbook[];
}
