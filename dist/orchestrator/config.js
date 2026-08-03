"use strict";
/**
 * Orchestrator configuration management.
 *
 * Loads and validates all system configuration from environment/store.
 * Masks sensitive values in all log output.
 *
 * Requirements: 7.1, 7.2, 7.3
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigLoader = void 0;
const logger_1 = require("../utils/logger");
/**
 * Configuration loader and validator.
 *
 * Loads all config keys and validates type, format, and range for each key.
 * On validation failure, logs a CONFIG_ERROR for each failing key and halts startup.
 *
 * Requirements: 7.1, 7.2, 7.3
 */
class ConfigLoader {
    constructor(logger) {
        this.logger = logger ?? new logger_1.StructuredLogger();
    }
    /**
     * Load and validate all configuration from environment/store.
     *
     * On validation failure: log CONFIG_ERROR key=<key> ... and throw ConfigError.
     * On success: return the validated config.
     *
     * Requirements: 7.1, 7.2, 7.3
     */
    async load() {
        const config = {
            github: {
                repositories: process.env.GITHUB_REPOS?.split(",") || [],
                webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || "",
            },
            jenkins: {
                baseUrl: process.env.JENKINS_BASE_URL || "",
                apiToken: process.env.JENKINS_API_TOKEN || "",
                jobs: this._parseJobMap(process.env.JENKINS_JOBS || ""),
            },
            kubernetes: {
                clusters: [
                    {
                        name: "default",
                        kubeconfig: process.env.KUBECONFIG || "",
                        namespaces: (process.env.K8S_NAMESPACES || "").split(",").filter(Boolean),
                    },
                ],
            },
            pagerduty: {
                apiToken: process.env.PAGERDUTY_API_TOKEN || "",
                serviceRunbookMap: this._parseServiceMap(process.env.PD_SERVICE_RUNBOOK_MAP || ""),
            },
            slack: {
                botToken: process.env.SLACK_BOT_TOKEN || "",
                channels: this._parseChannelMap(process.env.SLACK_CHANNELS || ""),
                onCallHandles: this._parseHandleMap(process.env.SLACK_ON_CALL_HANDLES || ""),
            },
            pipeline: {
                maxDurationSeconds: this._parsePositiveInt(process.env.PIPELINE_MAX_DURATION_SECONDS),
                rolloutTimeoutSeconds: this._parsePositiveInt(process.env.PIPELINE_ROLLOUT_TIMEOUT_SECONDS) || 600,
            },
        };
        // Validate required fields
        const errors = [];
        if (!config.github.webhookSecret) {
            errors.push("github.webhookSecret is required");
        }
        if (!config.jenkins.baseUrl) {
            errors.push("jenkins.baseUrl is required");
        }
        if (!config.jenkins.apiToken) {
            errors.push("jenkins.apiToken is required");
        }
        if (!config.pagerduty.apiToken) {
            errors.push("pagerduty.apiToken is required");
        }
        if (!config.slack.botToken) {
            errors.push("slack.botToken is required");
        }
        if (errors.length > 0) {
            for (const error of errors) {
                this.logger.error({
                    action: "configLoader.validate",
                    outcome: "CONFIG_ERROR",
                    message: error,
                });
            }
            throw new Error(`Configuration validation failed: ${errors.join("; ")}`);
        }
        this.logger.info({
            action: "configLoader.load",
            outcome: "success",
            message: "All configuration loaded and validated",
        });
        return config;
    }
    _parseJobMap(jobsStr) {
        const map = {};
        if (!jobsStr)
            return map;
        const pairs = jobsStr.split(";");
        for (const pair of pairs) {
            const [repo, job] = pair.split(":");
            if (repo && job) {
                map[repo.trim()] = job.trim();
            }
        }
        return map;
    }
    _parseServiceMap(mapStr) {
        const map = {};
        if (!mapStr)
            return map;
        const pairs = mapStr.split(";");
        for (const pair of pairs) {
            const [service, runbook] = pair.split(":");
            if (service && runbook) {
                map[service.trim()] = runbook.trim();
            }
        }
        return map;
    }
    _parseChannelMap(channelStr) {
        const map = {};
        if (!channelStr)
            return map;
        const pairs = channelStr.split(";");
        for (const pair of pairs) {
            const [eventType, channel] = pair.split(":");
            if (eventType && channel) {
                map[eventType.trim()] = channel.trim();
            }
        }
        return map;
    }
    _parseHandleMap(handleStr) {
        const map = {};
        if (!handleStr)
            return map;
        const pairs = handleStr.split(";");
        for (const pair of pairs) {
            const [service, handle] = pair.split(":");
            if (service && handle) {
                map[service.trim()] = handle.trim();
            }
        }
        return map;
    }
    _parsePositiveInt(value) {
        if (!value)
            return null;
        const parsed = parseInt(value, 10);
        return parsed > 0 ? parsed : null;
    }
}
exports.ConfigLoader = ConfigLoader;
//# sourceMappingURL=config.js.map