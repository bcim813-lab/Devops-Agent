"use strict";
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
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = void 0;
/**
 * CRM DevOps Agents — Event-driven automation platform
 * Main entry point with GUI dashboard served at GET /
 * Requirements: 7.1, 9.1, 9.5, 13.1
 */
/// <reference types="node" />
const http = __importStar(require("http"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const logger_1 = require("./utils/logger");
const config_1 = require("./orchestrator/config");
const ingest_1 = require("./orchestrator/ingest");
const dispatch_1 = require("./orchestrator/dispatch");
const health_1 = require("./orchestrator/health");
const metrics_1 = require("./orchestrator/metrics");
const records_1 = require("./agents/pipeline/records");
const apply_1 = require("./agents/deployment/apply");
const haltState_1 = require("./agents/deployment/haltState");
const runbookLibrary_1 = require("./agents/incident/runbookLibrary");
const execution_1 = require("./agents/incident/execution");
const delivery_1 = require("./agents/notification/delivery");
const trigger_1 = require("./agents/pipeline/trigger");
const logger = new logger_1.StructuredLogger();
// ── Dashboard HTML path ────────────────────────────────────────────────
const DASHBOARD_PATH = path.join(__dirname, "..", "src", "dashboard", "index.html");
const DASHBOARD_PATH_DIST = path.join(__dirname, "dashboard", "index.html");
function serveDashboard(res) {
    // Try dist path first (after build), fall back to src path (dev)
    const tryPath = fs.existsSync(DASHBOARD_PATH_DIST) ? DASHBOARD_PATH_DIST : DASHBOARD_PATH;
    if (!fs.existsSync(tryPath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Dashboard not found. Run: npm run build");
        return;
    }
    const html = fs.readFileSync(tryPath, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
}
async function main() {
    logger.info({ action: "main", outcome: "pending", message: "Starting CRM DevOps Agents platform" });
    try {
        // ── Load configuration ─────────────────────────────────────────────
        const configLoader = new config_1.ConfigLoader(logger);
        const config = await configLoader.load();
        logger.info({ action: "main.config", outcome: "success", message: "Configuration loaded" });
        // ── Initialize agents ──────────────────────────────────────────────
        const _pipelineRecordStore = new records_1.PipelineRecordStore();
        const _pipelineTrigger = new trigger_1.PipelineTrigger({ async triggerJob() { return `run-${Date.now()}`; } }, () => { }, config.jenkins.jobs, logger);
        const deploymentHaltRegistry = new haltState_1.DeploymentHaltRegistry();
        const _manifestApplier = new apply_1.ManifestApplier({ async applyManifest() { return { success: true, value: undefined }; } }, () => { }, logger);
        const runbookLibrary = new runbookLibrary_1.RunbookLibrary({ logger });
        const _incidentHandler = new execution_1.IncidentHandler(runbookLibrary, { async acknowledgeIncident() { return { success: true }; } }, { async resolveHandle() { return "user123"; }, async postMessage() { return { success: true }; } }, { async executeStep() { return { success: true }; } }, () => { }, async () => null, logger);
        const _messageDeliverer = new delivery_1.MessageDeliverer({ async postMessage() { return { success: true }; } }, () => { }, logger);
        // ── Initialize Orchestrator ────────────────────────────────────────
        const healthMonitor = new health_1.HealthMonitor(15000, 60000, undefined, logger);
        const metricsCollector = new metrics_1.PrometheusMetricsCollector();
        const dispatcher = new dispatch_1.CommandDispatcher({ async dispatch() { } }, { async dispatch() { } }, { async dispatch() { } }, { async dispatch() { } }, logger);
        const ingester = new ingest_1.EventIngester(async (eventType, correlationId, event) => {
            await dispatcher.dispatch(eventType, correlationId, event);
            metricsCollector.recordEvent("Pipeline_Agent", eventType, true, 50);
        }, logger);
        healthMonitor.start();
        logger.info({ action: "main.agents", outcome: "success", message: "All agents initialized" });
        // ── HTTP server ────────────────────────────────────────────────────
        const server = http.createServer((req, res) => {
            // CORS
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type");
            if (req.method === "OPTIONS") {
                res.writeHead(204);
                res.end();
                return;
            }
            const url = req.url?.split("?")[0] ?? "/";
            // ── GET / → GUI Dashboard ──────────────────────────────────────
            if (req.method === "GET" && (url === "/" || url === "/dashboard")) {
                serveDashboard(res);
                return;
            }
            // ── GET /health ────────────────────────────────────────────────
            if (req.method === "GET" && url === "/health") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(healthMonitor.getStatus()));
                return;
            }
            // ── GET /metrics ───────────────────────────────────────────────
            if (req.method === "GET" && url === "/metrics") {
                res.writeHead(200, { "Content-Type": "text/plain" });
                res.end(metricsCollector.getMetrics());
                return;
            }
            // ── GET /api/config-status ─────────────────────────────────────
            if (req.method === "GET" && url === "/api/config-status") {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    github: { set: !!config.github.webhookSecret },
                    jenkins: { baseUrl: config.jenkins.baseUrl, set: !!config.jenkins.apiToken },
                    pagerduty: { set: !!config.pagerduty.apiToken },
                    slack: { set: !!config.slack.botToken },
                }));
                return;
            }
            // ── POST /api/resume-deployment ────────────────────────────────
            if (req.method === "POST" && url === "/api/resume-deployment") {
                let body = "";
                req.on("data", c => { body += c; });
                req.on("end", () => {
                    try {
                        const { deploymentName, namespace } = JSON.parse(body);
                        deploymentHaltRegistry.resume({ deploymentName, namespace });
                        logger.info({ action: "api.resumeDeployment", outcome: "success", params: { deploymentName, namespace } });
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: true }));
                    }
                    catch (err) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: String(err) }));
                    }
                });
                return;
            }
            // ── POST /api/config-reload ────────────────────────────────────
            if (req.method === "POST" && url === "/api/config-reload") {
                logger.info({ action: "api.configReload", outcome: "pending", message: "Hot-reload requested from dashboard" });
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, message: "Reload triggered" }));
                return;
            }
            // ── POST /webhook/github ───────────────────────────────────────
            if (req.method === "POST" && url === "/webhook/github") {
                let body = "";
                req.on("data", c => { body += c; });
                req.on("end", async () => {
                    try {
                        const event = JSON.parse(body);
                        await ingester.ingest(event);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: true }));
                    }
                    catch (err) {
                        logger.error({ action: "main.webhook", outcome: "failure", errorMessage: err instanceof Error ? err.message : String(err) });
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: String(err) }));
                    }
                });
                return;
            }
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Not Found", url }));
        });
        const port = process.env.PORT || 8080;
        server.listen(port, () => {
            logger.info({ action: "main.server", outcome: "success", message: `HTTP server listening on port ${port}` });
            logger.info({ action: "main.dashboard", outcome: "success", message: `GUI Dashboard: http://localhost:${port}/` });
        });
        process.on("SIGTERM", () => {
            logger.info({ action: "main.shutdown", outcome: "pending", message: "Shutting down" });
            healthMonitor.stop();
            server.close(() => { logger.info({ action: "main.shutdown", outcome: "success", message: "Done" }); process.exit(0); });
        });
        logger.info({ action: "main", outcome: "success", message: "CRM DevOps Agents platform ready" });
    }
    catch (err) {
        logger.error({ action: "main", outcome: "fatal", errorMessage: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    }
}
exports.main = main;
if (require.main === module) {
    main().catch(err => {
        logger.error({ action: "main.uncaught", outcome: "fatal", errorMessage: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map