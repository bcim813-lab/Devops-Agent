"use strict";
/**
 * Deployment_Agent — halt state registry.
 *
 * Maintains an in-memory and persisted registry of (deploymentName, namespace)
 * pairs that are halted. All commands targeting a halted pair return HaltedError
 * without executing.
 *
 * Requirements: 4.3, 4.4
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeploymentHaltRegistry = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("../../utils/logger");
const models_1 = require("../../types/models");
/**
 * In-memory and persisted registry of halted deployments.
 *
 * A deployment is identified by the pair (deploymentName, namespace).
 * Once halted, all commands targeting that pair throw HaltedError immediately.
 *
 * Requirements: 4.3, 4.4
 */
class DeploymentHaltRegistry {
    constructor(options = {}) {
        this.halts = new Map();
        this.persistPath =
            options.persistPath || path.resolve(".data", "deployment-halts.json");
        this.logger = options.logger ?? logger_1.logger;
        this._load();
    }
    /**
     * Check if a deployment pair is halted. If so, throw HaltedError.
     * Otherwise, return normally.
     *
     * Requirement 4.4: All commands targeting a halted pair return HaltedError immediately.
     */
    checkAndThrowIfHalted(deployment) {
        const key = this._makeKey(deployment);
        const haltState = this.halts.get(key);
        if (haltState) {
            this.logger.warn({
                action: "DeploymentHaltRegistry.checkAndThrowIfHalted",
                outcome: "blocked",
                params: {
                    deploymentName: deployment.deploymentName,
                    namespace: deployment.namespace,
                },
                haltReason: haltState.reason,
                haltedAt: haltState.haltedAt,
            });
            throw new models_1.HaltedError(deployment.deploymentName, deployment.namespace, haltState.haltedAt, haltState.reason);
        }
    }
    /**
     * Record a deployment as halted.
     * Requirement 4.4: Record the (deploymentName, namespace) pair in the halt registry.
     */
    halt(deployment, reason, haltedAt = new Date().toISOString()) {
        const key = this._makeKey(deployment);
        const state = {
            deploymentName: deployment.deploymentName,
            namespace: deployment.namespace,
            haltedAt,
            reason,
            haltedUntilManualResume: true,
        };
        this.halts.set(key, state);
        this._persist();
        this.logger.info({
            action: "DeploymentHaltRegistry.halt",
            outcome: "recorded",
            params: {
                deploymentName: deployment.deploymentName,
                namespace: deployment.namespace,
            },
            reason,
            haltedAt,
        });
    }
    /**
     * Clear a halt (resume deployment). DevOps_Engineer-gated operation.
     * Requirement 4.4: Implement `resumeDeployment(deploymentRef)` to clear a halt.
     */
    resume(deployment) {
        const key = this._makeKey(deployment);
        const wasHalted = this.halts.has(key);
        if (wasHalted) {
            this.halts.delete(key);
            this._persist();
            this.logger.info({
                action: "DeploymentHaltRegistry.resume",
                outcome: "cleared",
                params: {
                    deploymentName: deployment.deploymentName,
                    namespace: deployment.namespace,
                },
            });
        }
    }
    /**
     * List all currently halted deployments.
     */
    listHalted() {
        return Array.from(this.halts.values());
    }
    /**
     * Check if a deployment is currently halted (without throwing).
     */
    isHalted(deployment) {
        const key = this._makeKey(deployment);
        return this.halts.has(key);
    }
    /**
     * Get the halt state for a deployment (if any).
     */
    getHaltState(deployment) {
        const key = this._makeKey(deployment);
        return this.halts.get(key);
    }
    // ─────────────────────────────────────────────────────────────────────────
    // Private helpers
    // ─────────────────────────────────────────────────────────────────────────
    _makeKey(deployment) {
        return `${deployment.deploymentName}:${deployment.namespace}`;
    }
    _load() {
        if (!fs.existsSync(this.persistPath)) {
            return;
        }
        try {
            const data = fs.readFileSync(this.persistPath, "utf8");
            const states = JSON.parse(data);
            for (const state of states) {
                const key = `${state.deploymentName}:${state.namespace}`;
                this.halts.set(key, state);
            }
            this.logger.debug({
                action: "DeploymentHaltRegistry._load",
                outcome: "success",
                loadedCount: states.length,
            });
        }
        catch (err) {
            this.logger.warn({
                action: "DeploymentHaltRegistry._load",
                outcome: "failure",
                errorMessage: err instanceof Error ? err.message : String(err),
            });
        }
    }
    _persist() {
        try {
            const dir = path.dirname(this.persistPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const states = Array.from(this.halts.values());
            fs.writeFileSync(this.persistPath, JSON.stringify(states, null, 2));
        }
        catch (err) {
            this.logger.error({
                action: "DeploymentHaltRegistry._persist",
                outcome: "failure",
                errorMessage: err instanceof Error ? err.message : String(err),
            });
        }
    }
}
exports.DeploymentHaltRegistry = DeploymentHaltRegistry;
//# sourceMappingURL=haltState.js.map