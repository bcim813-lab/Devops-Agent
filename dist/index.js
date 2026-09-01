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
exports.main = main;
/**
 * CRM DevOps Agents — Full-stack server with Auth, GUI, and all API endpoints
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
const auth_1 = require("./auth");
const logger = new logger_1.StructuredLogger();
// ── HTML serving ───────────────────────────────────────────────────────────
function readHtml(file) {
    const candidates = [
        path.join(__dirname, "dashboard", file),
        path.join(__dirname, "..", "src", "dashboard", file),
    ];
    for (const p of candidates) {
        if (fs.existsSync(p))
            return fs.readFileSync(p, "utf8");
    }
    return null;
}
// ── JSON body reader ───────────────────────────────────────────────────────
function readBody(req) {
    return new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", c => { raw += c; if (raw.length > 1000000)
            reject(new Error("Body too large")); });
        req.on("end", () => { try {
            resolve(JSON.parse(raw || "{}"));
        }
        catch {
            reject(new Error("Invalid JSON"));
        } });
        req.on("error", reject);
    });
}
// ── Response helpers ───────────────────────────────────────────────────────
function json(res, code, data) {
    const body = JSON.stringify(data);
    res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
}
function apiError(res, err) {
    const e = err;
    json(res, e.status ?? 500, { error: e.message ?? "Internal server error" });
}
async function main() {
    logger.info({ action: "main", outcome: "pending", message: "Starting CRM DevOps Agents" });
    try {
        // ── Config ─────────────────────────────────────────────────────────
        const configLoader = new config_1.ConfigLoader(logger);
        const config = await configLoader.load();
        // ── Agents ─────────────────────────────────────────────────────────
        const _pipelineRecordStore = new records_1.PipelineRecordStore();
        const _pipelineTrigger = new trigger_1.PipelineTrigger({ async triggerJob() { return `run-${Date.now()}`; } }, () => { }, config.jenkins.jobs, logger);
        const deploymentHaltRegistry = new haltState_1.DeploymentHaltRegistry();
        const _manifestApplier = new apply_1.ManifestApplier({ async applyManifest() { return { success: true, value: undefined }; } }, () => { }, logger);
        const runbookLibrary = new runbookLibrary_1.RunbookLibrary({ logger });
        const _incidentHandler = new execution_1.IncidentHandler(runbookLibrary, { async acknowledgeIncident() { return { success: true }; } }, { async resolveHandle() { return "user123"; }, async postMessage() { return { success: true }; } }, { async executeStep() { return { success: true }; } }, () => { }, async () => null, logger);
        const _messageDeliverer = new delivery_1.MessageDeliverer({ async postMessage() { return { success: true }; } }, () => { }, logger);
        // ── Orchestrator ───────────────────────────────────────────────────
        const healthMonitor = new health_1.HealthMonitor(15000, 60000, undefined, logger);
        const metricsCollector = new metrics_1.PrometheusMetricsCollector();
        const dispatcher = new dispatch_1.CommandDispatcher({ async dispatch() { } }, { async dispatch() { } }, { async dispatch() { } }, { async dispatch() { } }, logger);
        const ingester = new ingest_1.EventIngester(async (eventType, correlationId, event) => {
            await dispatcher.dispatch(eventType, correlationId, event);
            metricsCollector.recordEvent("Pipeline_Agent", eventType, true, 50);
        }, logger);
        healthMonitor.start();
        // In-memory settings store
        const appSettings = {
            siteName: "CRM DevOps Agent",
            sessionTTLHours: 8,
            allowSelfRegister: false,
            maxLoginAttempts: 5,
            requireEmailVerification: false,
            maintenanceMode: false,
            logLevel: "info",
            notificationChannel: "#deployments",
            rolloutTimeoutSeconds: 600,
            maxPipelineDurationSeconds: 3600,
        };
        // ── HTTP server ────────────────────────────────────────────────────
        const server = http.createServer(async (req, res) => {
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,PATCH,OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
            if (req.method === "OPTIONS") {
                res.writeHead(204);
                res.end();
                return;
            }
            const url = req.url?.split("?")[0] ?? "/";
            const token = (0, auth_1.extractToken)(req.headers["authorization"], req.headers["cookie"]);
            try {
                // ── GUI pages ────────────────────────────────────────────────
                if (req.method === "GET" && (url === "/" || url === "/login")) {
                    const html = readHtml("index.html");
                    if (html) {
                        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                        res.end(html);
                    }
                    else {
                        res.writeHead(503);
                        res.end("GUI not built. Run: npm run build");
                    }
                    return;
                }
                // ══════════════════ AUTH API ══════════════════════════════════
                // POST /api/auth/login
                if (req.method === "POST" && url === "/api/auth/login") {
                    const body = await readBody(req);
                    const ip = req.socket.remoteAddress ?? "unknown";
                    const result = auth_1.authStore.login(body.username, body.password, ip);
                    if (!result) {
                        json(res, 401, { error: "Invalid username or password" });
                        return;
                    }
                    res.setHeader("Set-Cookie", `devops_token=${result.token}; Path=/; HttpOnly; Max-Age=28800`);
                    json(res, 200, { token: result.token, user: result.user });
                    logger.info({ action: "auth.login", outcome: "success", params: { username: body.username } });
                    return;
                }
                // POST /api/auth/logout
                if (req.method === "POST" && url === "/api/auth/logout") {
                    if (token) {
                        auth_1.authStore.destroySession(token);
                        res.setHeader("Set-Cookie", "devops_token=; Path=/; Max-Age=0");
                    }
                    json(res, 200, { ok: true });
                    return;
                }
                // GET /api/auth/me
                if (req.method === "GET" && url === "/api/auth/me") {
                    const user = (0, auth_1.requireAuth)(token);
                    json(res, 200, user);
                    return;
                }
                // POST /api/auth/change-password
                if (req.method === "POST" && url === "/api/auth/change-password") {
                    const user = (0, auth_1.requireAuth)(token);
                    const body = await readBody(req);
                    if (!body.newPassword || body.newPassword.length < 6) {
                        json(res, 400, { error: "New password must be at least 6 characters" });
                        return;
                    }
                    auth_1.authStore.changePassword(user.id, body.oldPassword, body.newPassword);
                    json(res, 200, { ok: true, message: "Password changed successfully" });
                    return;
                }
                // PUT /api/auth/profile
                if (req.method === "PUT" && url === "/api/auth/profile") {
                    const user = (0, auth_1.requireAuth)(token);
                    const body = await readBody(req);
                    const updated = auth_1.authStore.updateUser(user.id, { displayName: body.displayName, email: body.email });
                    json(res, 200, updated);
                    return;
                }
                // ══════════════════ USERS API (Admin only) ════════════════════
                // GET /api/users
                if (req.method === "GET" && url === "/api/users") {
                    const user = (0, auth_1.requireAuth)(token);
                    (0, auth_1.requireRole)(user, "admin");
                    json(res, 200, auth_1.authStore.listUsers());
                    return;
                }
                // POST /api/users
                if (req.method === "POST" && url === "/api/users") {
                    const user = (0, auth_1.requireAuth)(token);
                    (0, auth_1.requireRole)(user, "admin");
                    const body = await readBody(req);
                    if (!body.username || !body.email || !body.password) {
                        json(res, 400, { error: "username, email and password are required" });
                        return;
                    }
                    if (body.password.length < 6) {
                        json(res, 400, { error: "Password must be at least 6 characters" });
                        return;
                    }
                    const created = auth_1.authStore.createUser(body, user.username);
                    json(res, 201, created);
                    logger.info({ action: "admin.createUser", outcome: "success", params: { username: body.username, role: body.role, createdBy: user.username } });
                    return;
                }
                // PUT /api/users/:id
                const userEditMatch = url.match(/^\/api\/users\/([^/]+)$/);
                if (req.method === "PUT" && userEditMatch) {
                    const user = (0, auth_1.requireAuth)(token);
                    (0, auth_1.requireRole)(user, "admin");
                    const body = await readBody(req);
                    const updated = auth_1.authStore.updateUser(userEditMatch[1], body);
                    json(res, 200, updated);
                    return;
                }
                // POST /api/users/:id/reset-password
                const resetPwMatch = url.match(/^\/api\/users\/([^/]+)\/reset-password$/);
                if (req.method === "POST" && resetPwMatch) {
                    const user = (0, auth_1.requireAuth)(token);
                    (0, auth_1.requireRole)(user, "admin");
                    const body = await readBody(req);
                    if (!body.newPassword || body.newPassword.length < 6) {
                        json(res, 400, { error: "Password must be at least 6 characters" });
                        return;
                    }
                    auth_1.authStore.adminResetPassword(resetPwMatch[1], body.newPassword);
                    json(res, 200, { ok: true });
                    logger.info({ action: "admin.resetPassword", outcome: "success", params: { targetUserId: resetPwMatch[1], by: user.username } });
                    return;
                }
                // DELETE /api/users/:id
                const deleteUserMatch = url.match(/^\/api\/users\/([^/]+)$/);
                if (req.method === "DELETE" && deleteUserMatch) {
                    const user = (0, auth_1.requireAuth)(token);
                    (0, auth_1.requireRole)(user, "admin");
                    if (deleteUserMatch[1] === user.id) {
                        json(res, 400, { error: "Cannot delete your own account" });
                        return;
                    }
                    auth_1.authStore.deleteUser(deleteUserMatch[1]);
                    json(res, 200, { ok: true });
                    return;
                }
                // ══════════════════ SETTINGS API (Admin only) ═════════════════
                // GET /api/settings
                if (req.method === "GET" && url === "/api/settings") {
                    const user = (0, auth_1.requireAuth)(token);
                    (0, auth_1.requireRole)(user, "admin");
                    json(res, 200, appSettings);
                    return;
                }
                // PUT /api/settings
                if (req.method === "PUT" && url === "/api/settings") {
                    const user = (0, auth_1.requireAuth)(token);
                    (0, auth_1.requireRole)(user, "admin");
                    const body = await readBody(req);
                    Object.assign(appSettings, body);
                    json(res, 200, appSettings);
                    logger.info({ action: "admin.settings", outcome: "success", params: { updatedBy: user.username } });
                    return;
                }
                // ══════════════════ HEALTH, METRICS, EVENTS ═══════════════════
                // GET /health
                if (req.method === "GET" && url === "/health") {
                    json(res, 200, healthMonitor.getStatus());
                    return;
                }
                // GET /metrics
                if (req.method === "GET" && url === "/metrics") {
                    res.writeHead(200, { "Content-Type": "text/plain" });
                    res.end(metricsCollector.getMetrics());
                    return;
                }
                // GET /api/stats
                if (req.method === "GET" && url === "/api/stats") {
                    (0, auth_1.requireAuth)(token);
                    const health = healthMonitor.getStatus();
                    json(res, 200, {
                        agents: health.agents,
                        timestamp: health.timestamp,
                        users: auth_1.authStore.getUserCount(),
                        activeSessions: auth_1.authStore.getActiveSessionCount(),
                    });
                    return;
                }
                // GET /api/config-status
                if (req.method === "GET" && url === "/api/config-status") {
                    (0, auth_1.requireAuth)(token);
                    json(res, 200, { jenkins: { baseUrl: config.jenkins.baseUrl }, github: !!config.github.webhookSecret, pagerduty: !!config.pagerduty.apiToken, slack: !!config.slack.botToken });
                    return;
                }
                // POST /api/resume-deployment
                if (req.method === "POST" && url === "/api/resume-deployment") {
                    const user = (0, auth_1.requireAuth)(token);
                    (0, auth_1.requireRole)(user, "operator");
                    const body = await readBody(req);
                    deploymentHaltRegistry.resume({ deploymentName: body.deploymentName, namespace: body.namespace });
                    json(res, 200, { ok: true });
                    return;
                }
                // POST /webhook/github (events)
                if (req.method === "POST" && url === "/webhook/github") {
                    const body = await readBody(req);
                    await ingester.ingest(body);
                    json(res, 200, { ok: true });
                    return;
                }
                json(res, 404, { error: "Not found", url });
            }
            catch (err) {
                apiError(res, err);
            }
        });
        const port = process.env.PORT || 8080;
        server.listen(port, () => {
            logger.info({ action: "main.server", outcome: "success", message: `Server on http://localhost:${port}` });
            logger.info({ action: "main.dashboard", outcome: "success", message: `GUI: http://localhost:${port}/` });
            logger.info({ action: "main.auth", outcome: "success", message: "Default login: admin / admin123" });
        });
        process.on("SIGTERM", () => { healthMonitor.stop(); server.close(() => process.exit(0)); });
        logger.info({ action: "main", outcome: "success", message: "Platform ready" });
    }
    catch (err) {
        logger.error({ action: "main", outcome: "fatal", errorMessage: err instanceof Error ? err.message : String(err) });
        process.exit(1);
    }
}
if (require.main === module) {
    main().catch(err => { console.error(err); process.exit(1); });
}
//# sourceMappingURL=index.js.map