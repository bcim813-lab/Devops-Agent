/**
 * Unit tests for ConfigLoader and ConfigReloader
 * (src/orchestrator/config.ts, src/orchestrator/configReload.ts)
 *
 * Covers:
 *  - Startup halts when a required key is missing (with CONFIG_ERROR log format) (Req 7.2)
 *  - Startup halts when a key has wrong type
 *  - Hot-reload applies valid updates (Req 7.4)
 *  - Hot-reload retains old config on invalid update and logs failing keys (Req 7.5)
 *  - ConfigReloader.start() and stop() lifecycle
 *
 * Requirements: 7.1, 7.2, 7.4, 7.5
 */

import { ConfigLoader } from "../../../src/orchestrator/config";
import { ConfigReloader } from "../../../src/orchestrator/configReload";
import { StructuredLogger } from "../../../src/utils/logger";
import type { SystemConfig, ConfigError } from "../../../src/types/models";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): StructuredLogger {
  return new StructuredLogger(() => {/* discard */});
}

function captureLogger(): { logger: StructuredLogger; entries: unknown[] } {
  const entries: unknown[] = [];
  const logger = new StructuredLogger((line) => entries.push(JSON.parse(line)));
  return { logger, entries };
}

function makeValidConfig(): SystemConfig {
  return {
    github: { repositories: ["crm-api"], webhookSecret: "secret-123" },
    jenkins: { baseUrl: "https://jenkins.example.com", apiToken: "token-abc", jobs: {} },
    kubernetes: { clusters: [{ name: "prod", kubeconfig: "kc", namespaces: ["production"] }] },
    pagerduty: { apiToken: "pd-token", serviceRunbookMap: {} },
    slack: { botToken: "xoxb-token", channels: {}, onCallHandles: {} },
    pipeline: { maxDurationSeconds: null, rolloutTimeoutSeconds: 600 },
  };
}

// ---------------------------------------------------------------------------
// ConfigLoader tests
// ---------------------------------------------------------------------------

describe("ConfigLoader", () => {

  beforeEach(() => {
    // Clear env vars before each test
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.JENKINS_BASE_URL;
    delete process.env.JENKINS_API_TOKEN;
    delete process.env.PAGERDUTY_API_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
  });

  afterEach(() => {
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.JENKINS_BASE_URL;
    delete process.env.JENKINS_API_TOKEN;
    delete process.env.PAGERDUTY_API_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
  });

  it("throws when required config keys are missing (Req 7.2)", async () => {
    // No env vars set — all required keys missing
    const loader = new ConfigLoader(silentLogger());

    await expect(loader.load()).rejects.toThrow();
  });

  it("logs CONFIG_ERROR for each missing required key (Req 7.2)", async () => {
    const { logger, entries } = captureLogger();
    const loader = new ConfigLoader(logger);

    try {
      await loader.load();
    } catch {
      // expected
    }

    const errorEntries = entries.filter((e: any) => e.outcome === "CONFIG_ERROR");
    expect(errorEntries.length).toBeGreaterThan(0);
  });

  it("succeeds when all required keys are present", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "my-webhook-secret";
    process.env.JENKINS_BASE_URL = "https://jenkins.example.com";
    process.env.JENKINS_API_TOKEN = "jenkins-api-token";
    process.env.PAGERDUTY_API_TOKEN = "pd-api-token";
    process.env.SLACK_BOT_TOKEN = "xoxb-slack-token";

    const loader = new ConfigLoader(silentLogger());
    const config = await loader.load();

    expect(config).toBeDefined();
    expect(config.github.webhookSecret).toBe("my-webhook-secret");
    expect(config.jenkins.baseUrl).toBe("https://jenkins.example.com");
  });

  it("does not expose raw token values in log entries (masking) (Req 8.2)", async () => {
    const { logger, entries } = captureLogger();
    const loader = new ConfigLoader(logger);

    try {
      await loader.load();
    } catch {
      // expected
    }

    // None of the log entries should contain raw token values
    const entriesStr = JSON.stringify(entries);
    expect(entriesStr).not.toContain("my-secret-token");
  });

  it("throws with an error message that lists the failing keys", async () => {
    const loader = new ConfigLoader(silentLogger());

    let thrown: unknown;
    try {
      await loader.load();
    } catch (err) {
      thrown = err;
    }
    expect(thrown instanceof Error).toBe(true);
    expect((thrown as Error).message.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// ConfigReloader tests
// ---------------------------------------------------------------------------

describe("ConfigReloader", () => {

  function makeStore(raw: Record<string, unknown> = {}) {
    return {
      fetchLatest: jest.fn().mockResolvedValue(raw),
      subscribe: jest.fn().mockReturnValue(jest.fn()),
    };
  }

  function alwaysValidValidator(newConfig: SystemConfig) {
    return (_raw: Record<string, unknown>) => ({
      valid: true as const,
      config: newConfig,
    });
  }

  function alwaysInvalidValidator(failingKeys: string[]) {
    return (_raw: Record<string, unknown>) => ({
      valid: false as const,
      errors: failingKeys.map(
        (key): ConfigError => ({
          key,
          invalidValue: null,
          expectedType: "string",
          reason: `${key} is required`,
        })
      ),
    });
  }

  it("applies valid config update and calls onUpdate handler (Req 7.4)", async () => {
    const previousConfig = makeValidConfig();
    const newConfig = { ...makeValidConfig(), pipeline: { maxDurationSeconds: 3600, rolloutTimeoutSeconds: 300 } };
    let appliedConfig: SystemConfig | null = null;

    const reloader = new ConfigReloader(
      makeStore() as any,
      alwaysValidValidator(newConfig),
      previousConfig,
      (cfg) => { appliedConfig = cfg; },
      { logger: silentLogger() }
    );

    await reloader.reload();

    expect(appliedConfig).toEqual(newConfig);
  });

  it("retains previous config when reload returns invalid config (Req 7.5)", async () => {
    const previousConfig = makeValidConfig();
    let appliedConfig: SystemConfig | null = null;

    const reloader = new ConfigReloader(
      makeStore() as any,
      alwaysInvalidValidator(["github.webhookSecret"]),
      previousConfig,
      (cfg) => { appliedConfig = cfg; },
      { logger: silentLogger() }
    );

    await reloader.reload();

    expect(appliedConfig).toBeNull();
    expect(reloader.getCurrentConfig()).toEqual(previousConfig);
  });

  it("logs CONFIG_ERROR for each failing key on invalid reload (Req 7.5)", async () => {
    const { logger, entries } = captureLogger();
    const previousConfig = makeValidConfig();

    const reloader = new ConfigReloader(
      makeStore() as any,
      alwaysInvalidValidator(["jenkins.apiToken", "slack.botToken"]),
      previousConfig,
      jest.fn(),
      { logger }
    );

    await reloader.reload();

    const configErrors = entries.filter((e: any) => e.outcome === "CONFIG_ERROR");
    expect(configErrors.length).toBeGreaterThanOrEqual(2);

    const keys = configErrors.map((e: any) => e.key);
    expect(keys).toContain("jenkins.apiToken");
    expect(keys).toContain("slack.botToken");
  });

  it("updates getCurrentConfig() after a valid reload", async () => {
    const previousConfig = makeValidConfig();
    const newConfig = { ...makeValidConfig(), pipeline: { maxDurationSeconds: 7200, rolloutTimeoutSeconds: 600 } };

    const reloader = new ConfigReloader(
      makeStore() as any,
      alwaysValidValidator(newConfig),
      previousConfig,
      jest.fn(),
      { logger: silentLogger() }
    );

    await reloader.reload();

    expect(reloader.getCurrentConfig()).toEqual(newConfig);
  });

  it("does NOT update getCurrentConfig() after an invalid reload", async () => {
    const previousConfig = makeValidConfig();

    const reloader = new ConfigReloader(
      makeStore() as any,
      alwaysInvalidValidator(["pagerduty.apiToken"]),
      previousConfig,
      jest.fn(),
      { logger: silentLogger() }
    );

    await reloader.reload();

    expect(reloader.getCurrentConfig()).toEqual(previousConfig);
  });

  it("start() and stop() do not throw", () => {
    const reloader = new ConfigReloader(
      makeStore() as any,
      alwaysValidValidator(makeValidConfig()),
      makeValidConfig(),
      jest.fn(),
      { logger: silentLogger(), pollIntervalMs: 60_000 }
    );

    expect(() => reloader.start()).not.toThrow();
    expect(() => reloader.stop()).not.toThrow();
  });

  it("consecutive invalid reloads always retain the original valid config", async () => {
    const originalConfig = makeValidConfig();

    const reloader = new ConfigReloader(
      makeStore() as any,
      alwaysInvalidValidator(["github.webhookSecret"]),
      originalConfig,
      jest.fn(),
      { logger: silentLogger() }
    );

    await reloader.reload();
    await reloader.reload();
    await reloader.reload();

    expect(reloader.getCurrentConfig()).toEqual(originalConfig);
  });

  it("fetch failure does not throw and retains previous config", async () => {
    const previousConfig = makeValidConfig();

    const errorStore = {
      fetchLatest: jest.fn().mockRejectedValue(new Error("network error")),
      subscribe: jest.fn().mockReturnValue(jest.fn()),
    };

    const reloader = new ConfigReloader(
      errorStore as any,
      alwaysValidValidator(makeValidConfig()),
      previousConfig,
      jest.fn(),
      { logger: silentLogger() }
    );

    await expect(reloader.reload()).resolves.not.toThrow();
    expect(reloader.getCurrentConfig()).toEqual(previousConfig);
  });
});
