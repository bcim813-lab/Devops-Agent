/**
 * CRM DevOps Agents — Full-stack server with Auth, GUI, and all API endpoints
 * Requirements: 7.1, 9.1, 9.5, 13.1
 */
/// <reference types="node" />
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { StructuredLogger } from "./utils/logger";
import { ConfigLoader } from "./orchestrator/config";
import { EventIngester } from "./orchestrator/ingest";
import { CommandDispatcher } from "./orchestrator/dispatch";
import { HealthMonitor } from "./orchestrator/health";
import { PrometheusMetricsCollector } from "./orchestrator/metrics";
import { PipelineRecordStore } from "./agents/pipeline/records";
import { ManifestApplier } from "./agents/deployment/apply";
import { DeploymentHaltRegistry } from "./agents/deployment/haltState";
import { RunbookLibrary } from "./agents/incident/runbookLibrary";
import { IncidentHandler } from "./agents/incident/execution";
import { MessageDeliverer } from "./agents/notification/delivery";
import { PipelineTrigger } from "./agents/pipeline/trigger";
import { authStore, extractToken, requireAuth, requireRole } from "./auth";
import type { SystemConfig } from "./types/models";

const logger = new StructuredLogger();

// ── HTML serving ───────────────────────────────────────────────────────────
function readHtml(file: string): string | null {
  const candidates = [
    path.join(__dirname, "dashboard", file),
    path.join(__dirname, "..", "src", "dashboard", file),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  }
  return null;
}

// ── JSON body reader ───────────────────────────────────────────────────────
function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", c => { raw += c; if (raw.length > 1_000_000) reject(new Error("Body too large")); });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch { reject(new Error("Invalid JSON")); } });
    req.on("error", reject);
  });
}

// ── Response helpers ───────────────────────────────────────────────────────
function json(res: http.ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function apiError(res: http.ServerResponse, err: unknown): void {
  const e = err as { status?: number; message?: string };
  json(res, e.status ?? 500, { error: e.message ?? "Internal server error" });
}

async function main(): Promise<void> {
  logger.info({ action: "main", outcome: "pending", message: "Starting CRM DevOps Agents" });

  try {
    // ── Config ─────────────────────────────────────────────────────────
    const configLoader = new ConfigLoader(logger);
    const config: SystemConfig = await configLoader.load();

    // ── Agents ─────────────────────────────────────────────────────────
    const _pipelineRecordStore = new PipelineRecordStore();
    const _pipelineTrigger = new PipelineTrigger(
      { async triggerJob() { return `run-${Date.now()}`; } } as any,
      () => {}, config.jenkins.jobs, logger
    );
    const deploymentHaltRegistry = new DeploymentHaltRegistry();
    const _manifestApplier = new ManifestApplier(
      { async applyManifest() { return { success: true, value: undefined }; } } as any,
      () => {}, logger
    );
    const runbookLibrary = new RunbookLibrary({ logger });
    const _incidentHandler = new IncidentHandler(
      runbookLibrary,
      { async acknowledgeIncident() { return { success: true }; } } as any,
      { async resolveHandle() { return "user123"; }, async postMessage() { return { success: true }; } } as any,
      { async executeStep() { return { success: true }; } } as any,
      () => {}, async () => null, logger
    );
    const _messageDeliverer = new MessageDeliverer(
      { async postMessage() { return { success: true }; } } as any, () => {}, logger
    );

    // ── Orchestrator ───────────────────────────────────────────────────
    const healthMonitor = new HealthMonitor(15_000, 60_000, undefined, logger);
    const metricsCollector = new PrometheusMetricsCollector();
    const dispatcher = new CommandDispatcher(
      { async dispatch() {} } as any, { async dispatch() {} } as any,
      { async dispatch() {} } as any, { async dispatch() {} } as any, logger
    );
    const ingester = new EventIngester(async (eventType, correlationId, event) => {
      await dispatcher.dispatch(eventType, correlationId, event);
      metricsCollector.recordEvent("Pipeline_Agent", eventType, true, 50);
    }, logger);
    healthMonitor.start();

    // In-memory settings store
    const appSettings: Record<string, unknown> = {
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
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      const url = req.url?.split("?")[0] ?? "/";
      const token = extractToken(req.headers["authorization"], req.headers["cookie"]);

      try {
        // ── GUI pages ────────────────────────────────────────────────
        if (req.method === "GET" && (url === "/" || url === "/login")) {
          const html = readHtml("index.html");
          if (html) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html); }
          else { res.writeHead(503); res.end("GUI not built. Run: npm run build"); }
          return;
        }

        // ══════════════════ AUTH API ══════════════════════════════════

        // POST /api/auth/login
        if (req.method === "POST" && url === "/api/auth/login") {
          const body = await readBody(req) as { username: string; password: string };
          const ip = req.socket.remoteAddress ?? "unknown";
          const result = authStore.login(body.username, body.password, ip);
          if (!result) { json(res, 401, { error: "Invalid username or password" }); return; }
          res.setHeader("Set-Cookie", `devops_token=${result.token}; Path=/; HttpOnly; Max-Age=28800`);
          json(res, 200, { token: result.token, user: result.user });
          logger.info({ action: "auth.login", outcome: "success", params: { username: body.username } });
          return;
        }

        // POST /api/auth/logout
        if (req.method === "POST" && url === "/api/auth/logout") {
          if (token) { authStore.destroySession(token); res.setHeader("Set-Cookie", "devops_token=; Path=/; Max-Age=0"); }
          json(res, 200, { ok: true });
          return;
        }

        // GET /api/auth/me
        if (req.method === "GET" && url === "/api/auth/me") {
          const user = requireAuth(token);
          json(res, 200, user);
          return;
        }

        // POST /api/auth/change-password
        if (req.method === "POST" && url === "/api/auth/change-password") {
          const user = requireAuth(token);
          const body = await readBody(req) as { oldPassword: string; newPassword: string };
          if (!body.newPassword || body.newPassword.length < 6) { json(res, 400, { error: "New password must be at least 6 characters" }); return; }
          authStore.changePassword(user.id, body.oldPassword, body.newPassword);
          json(res, 200, { ok: true, message: "Password changed successfully" });
          return;
        }

        // PUT /api/auth/profile
        if (req.method === "PUT" && url === "/api/auth/profile") {
          const user = requireAuth(token);
          const body = await readBody(req) as { displayName?: string; email?: string };
          const updated = authStore.updateUser(user.id, { displayName: body.displayName, email: body.email });
          json(res, 200, updated);
          return;
        }

        // ══════════════════ USERS API (Admin only) ════════════════════

        // GET /api/users
        if (req.method === "GET" && url === "/api/users") {
          const user = requireAuth(token);
          requireRole(user, "admin");
          json(res, 200, authStore.listUsers());
          return;
        }

        // POST /api/users
        if (req.method === "POST" && url === "/api/users") {
          const user = requireAuth(token);
          requireRole(user, "admin");
          const body = await readBody(req) as { username: string; email: string; password: string; role: "admin" | "operator" | "viewer"; displayName: string };
          if (!body.username || !body.email || !body.password) { json(res, 400, { error: "username, email and password are required" }); return; }
          if (body.password.length < 6) { json(res, 400, { error: "Password must be at least 6 characters" }); return; }
          const created = authStore.createUser(body, user.username);
          json(res, 201, created);
          logger.info({ action: "admin.createUser", outcome: "success", params: { username: body.username, role: body.role, createdBy: user.username } });
          return;
        }

        // PUT /api/users/:id
        const userEditMatch = url.match(/^\/api\/users\/([^/]+)$/);
        if (req.method === "PUT" && userEditMatch) {
          const user = requireAuth(token);
          requireRole(user, "admin");
          const body = await readBody(req) as { email?: string; displayName?: string; role?: "admin" | "operator" | "viewer"; active?: boolean };
          const updated = authStore.updateUser(userEditMatch[1], body);
          json(res, 200, updated);
          return;
        }

        // POST /api/users/:id/reset-password
        const resetPwMatch = url.match(/^\/api\/users\/([^/]+)\/reset-password$/);
        if (req.method === "POST" && resetPwMatch) {
          const user = requireAuth(token);
          requireRole(user, "admin");
          const body = await readBody(req) as { newPassword: string };
          if (!body.newPassword || body.newPassword.length < 6) { json(res, 400, { error: "Password must be at least 6 characters" }); return; }
          authStore.adminResetPassword(resetPwMatch[1], body.newPassword);
          json(res, 200, { ok: true });
          logger.info({ action: "admin.resetPassword", outcome: "success", params: { targetUserId: resetPwMatch[1], by: user.username } });
          return;
        }

        // DELETE /api/users/:id
        const deleteUserMatch = url.match(/^\/api\/users\/([^/]+)$/);
        if (req.method === "DELETE" && deleteUserMatch) {
          const user = requireAuth(token);
          requireRole(user, "admin");
          if (deleteUserMatch[1] === user.id) { json(res, 400, { error: "Cannot delete your own account" }); return; }
          authStore.deleteUser(deleteUserMatch[1]);
          json(res, 200, { ok: true });
          return;
        }

        // ══════════════════ SETTINGS API (Admin only) ═════════════════

        // GET /api/settings
        if (req.method === "GET" && url === "/api/settings") {
          const user = requireAuth(token);
          requireRole(user, "admin");
          json(res, 200, appSettings);
          return;
        }

        // PUT /api/settings
        if (req.method === "PUT" && url === "/api/settings") {
          const user = requireAuth(token);
          requireRole(user, "admin");
          const body = await readBody(req) as Record<string, unknown>;
          Object.assign(appSettings, body);
          json(res, 200, appSettings);
          logger.info({ action: "admin.settings", outcome: "success", params: { updatedBy: user.username } });
          return;
        }

        // ══════════════════ HEALTH, METRICS, EVENTS ═══════════════════

        // GET /health
        if (req.method === "GET" && url === "/health") {
          json(res, 200, healthMonitor.getStatus()); return;
        }

        // GET /metrics
        if (req.method === "GET" && url === "/metrics") {
          res.writeHead(200, { "Content-Type": "text/plain" }); res.end(metricsCollector.getMetrics()); return;
        }

        // GET /api/stats
        if (req.method === "GET" && url === "/api/stats") {
          requireAuth(token);
          const health = healthMonitor.getStatus();
          json(res, 200, {
            agents: health.agents,
            timestamp: health.timestamp,
            users: authStore.getUserCount(),
            activeSessions: authStore.getActiveSessionCount(),
          });
          return;
        }

        // GET /api/config-status
        if (req.method === "GET" && url === "/api/config-status") {
          requireAuth(token);
          json(res, 200, { jenkins: { baseUrl: config.jenkins.baseUrl }, github: !!config.github.webhookSecret, pagerduty: !!config.pagerduty.apiToken, slack: !!config.slack.botToken });
          return;
        }

        // POST /api/resume-deployment
        if (req.method === "POST" && url === "/api/resume-deployment") {
          const user = requireAuth(token);
          requireRole(user, "operator");
          const body = await readBody(req) as { deploymentName: string; namespace: string };
          deploymentHaltRegistry.resume({ deploymentName: body.deploymentName, namespace: body.namespace });
          json(res, 200, { ok: true });
          return;
        }

        // POST /webhook/github (events)
        if (req.method === "POST" && url === "/webhook/github") {
          const body = await readBody(req) as Record<string, unknown>;
          await ingester.ingest(body as any);
          json(res, 200, { ok: true });
          return;
        }

        json(res, 404, { error: "Not found", url });
      } catch (err) {
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
  } catch (err) {
    logger.error({ action: "main", outcome: "fatal", errorMessage: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => { console.error(err); process.exit(1); });
}
export { main };
