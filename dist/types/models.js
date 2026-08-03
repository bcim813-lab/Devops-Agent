"use strict";
/**
 * Data models for all domain objects in the CRM DevOps Agents system.
 * Organized by domain: Pipeline, Deployment, Incident, Notification, Health, Config.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.HaltedError = exports.none = exports.some = exports.err = exports.ok = void 0;
/** Convenience helpers */
function ok(value) {
    return { success: true, value };
}
exports.ok = ok;
function err(error) {
    return { success: false, error };
}
exports.err = err;
function some(value) {
    return { present: true, value };
}
exports.some = some;
exports.none = { present: false };
/** Error thrown when a command targets a halted (deploymentName, namespace) pair */
class HaltedError extends Error {
    constructor(deploymentName, namespace, haltedAt, reason) {
        super(`Deployment '${deploymentName}' in namespace '${namespace}' is halted since ${haltedAt}: ${reason}`);
        this.deploymentName = deploymentName;
        this.namespace = namespace;
        this.haltedAt = haltedAt;
        this.reason = reason;
        this.name = "HaltedError";
    }
}
exports.HaltedError = HaltedError;
//# sourceMappingURL=models.js.map