"use strict";
/**
 * RunbookLibrary interface — a pluggable registry of runbooks keyed by service name.
 *
 * Key behaviors:
 * - getLatest() returns the runbook with the highest semver for the given service name,
 *   or undefined if none is registered.
 * - Runbooks are versioned and identified by a unique (serviceName, version) pair.
 * - The Incident_Agent always executes the latest registered version.
 */
Object.defineProperty(exports, "__esModule", { value: true });
//# sourceMappingURL=RunbookLibrary.js.map