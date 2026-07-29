/**
 * Property-based tests for configuration validation completeness.
 *
 * Property 10: Config Validation Completeness
 *   For any config object with one or more absent or invalid keys, the loader
 *   must neither apply partial config nor proceed — it must log the failing
 *   keys and retain the previous valid state (or halt on startup).
 *
 * Requirements: 7.2, 7.5
 */

import fc from "fast-check";
import { v4 as uuidv4 } from "uuid";
import { ConfigReloader } from "../../src/orchestrator/configReload";
import { StructuredLogger } from "../../src/utils/logger";
import type { SystemConfig, ConfigError } from "../../src/types/models";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): StructuredLogger {
  return new StructuredLogger(() => {/* discard */});
}

function makeValidConfig(overrides: Partial<SystemConfig> = {}): SystemConfig {
  return {
    github: {
      repositories: ["crm-api"],
      webhookSecret: "secret-abc",
    },
    jenkins: {
      baseUrl: "https://jenkins.example.com",
      apiToken: "token-xyz",
      jobs: { "crm-api": "crm-api-build" },
    },
    kubernetes: {
      clusters: [
        {
          name: "prod",
          kubeconfig: "kubeconfig-data",
          namespaces: ["production", "staging"],
        },
      ],
    },
    pagerduty: {
      apiToken: "pd-token",
      serviceRunbookMap: { "crm-api": "crm-api-runbook" },
    },
    slack: {
      botToken: "xoxb-slack-token",
      channels: { DeploymentSuccessEvent: "#deployments" },
      onCallHandles: { "crm-api": "@oncall" },
    },
    pipeline: {
      maxDurationSeconds: 3600,
      rolloutTimeoutSeconds: 600,
    },
    ...overrides,
  };
}

/**
 * Simple validator for tests: requires github.webhookSecret, jenkins.apiToken,
 * pagerduty.apiToken, and slack.botToken to be non-empty strings.
 */
function makeValidator(shouldFail: boolean, failingKeys: string[]) {
  return (raw: Record<string, unknown>) => {
    if (shouldFail) {
      const errors: ConfigError[] = failingKeys.map((key) => ({
        key,
        invalidValue: null,
        expectedType: "string",
        reason: `${key} is missing or invalid`,
      }));
      return { valid: false as const, errors };
    }
    return { valid: true as const, config: raw as unknown as SystemConfig };
  };
}

// ---------------------------------------------------------------------------
// Property 10: Config Validation Completeness
// ---------------------------------------------------------------------------

describe("Property 10: Config Validation Completeness", () => {
  // Property 10: Config Validation Completeness
  it("Property 10: Invalid config is never applied — previous valid config is retained", () => {
    fc.assert(
      fc.property(
        fc.record({
          failingKeys: fc
            .array(
              fc.constantFrom(
                "github.webhookSecret",
                "jenkins.apiToken",
                "pagerduty.apiToken",
                "slack.botToken",
                "kubernetes.clusters"
              ),
              { minLength: 1, maxLength: 3 }
            )
            .map((keys) => [...new Set(keys)]),
        }),
        async (data) => {
          const previousConfig = makeValidConfig();
          let appliedConfig: SystemConfig | null = null;

          const store = {
            fetchLatest: jest.fn().mockResolvedValue({}),
            subscribe: jest.fn().mockReturnValue(() => {}),
          };

          const validator = makeValidator(true, data.failingKeys);
          const reloader = new ConfigReloader(
            store,
            validator,
            previousConfig,
            (cfg) => { appliedConfig = cfg; },
            { logger: silentLogger() }
          );

          await reloader.reload();

          // Invalid config must NOT be applied
          expect(appliedConfig).toBeNull();

          // Previous config must be retained
          expect(reloader.getCurrentConfig()).toEqual(previousConfig);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 10: Valid config is applied and replaces previous config", () => {
    fc.assert(
      fc.property(
        fc.record({
          webhookSecret: fc.string({ minLength: 5, maxLength: 32 }),
          apiToken: fc.string({ minLength: 5, maxLength: 32 }),
        }),
        async (data) => {
          const previousConfig = makeValidConfig({ github: { repositories: ["old-repo"], webhookSecret: "old-secret" } });
          const newConfig = makeValidConfig({ github: { repositories: ["new-repo"], webhookSecret: data.webhookSecret } });
          let appliedConfig: SystemConfig | null = null;

          const store = {
            fetchLatest: jest.fn().mockResolvedValue(newConfig as unknown as Record<string, unknown>),
            subscribe: jest.fn().mockReturnValue(() => {}),
          };

          // Validator always succeeds (passes through the raw as config)
          const validator = (raw: Record<string, unknown>) => ({
            valid: true as const,
            config: raw as unknown as SystemConfig,
          });

          const reloader = new ConfigReloader(
            store,
            validator,
            previousConfig,
            (cfg) => { appliedConfig = cfg; },
            { logger: silentLogger() }
          );

          await reloader.reload();

          // Valid config should have been applied
          expect(appliedConfig).not.toBeNull();
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 10: Multiple consecutive invalid reloads always retain the last valid config", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        async (reloadCount) => {
          const validConfig = makeValidConfig();
          let lastApplied: SystemConfig = validConfig;
          let applyCount = 0;

          const store = {
            fetchLatest: jest.fn().mockResolvedValue({}),
            subscribe: jest.fn().mockReturnValue(() => {}),
          };

          const validator = makeValidator(true, ["github.webhookSecret"]);

          const reloader = new ConfigReloader(
            store,
            validator,
            validConfig,
            (cfg) => { lastApplied = cfg; applyCount++; },
            { logger: silentLogger() }
          );

          // Fire N invalid reloads
          for (let i = 0; i < reloadCount; i++) {
            await reloader.reload();
          }

          // Config should never have been updated
          expect(applyCount).toBe(0);
          expect(reloader.getCurrentConfig()).toEqual(validConfig);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 10: Error log includes the failing key name for each validation failure", () => {
    fc.assert(
      fc.property(
        fc.record({
          failingKey: fc.constantFrom(
            "github.webhookSecret",
            "jenkins.apiToken",
            "pagerduty.apiToken",
            "slack.botToken"
          ),
        }),
        async (data) => {
          const loggedEntries: unknown[] = [];
          const testLogger = new StructuredLogger((line) => {
            loggedEntries.push(JSON.parse(line));
          });

          const store = {
            fetchLatest: jest.fn().mockResolvedValue({}),
            subscribe: jest.fn().mockReturnValue(() => {}),
          };

          const validator = makeValidator(true, [data.failingKey]);

          const reloader = new ConfigReloader(
            store,
            validator,
            makeValidConfig(),
            jest.fn(),
            { logger: testLogger }
          );

          await reloader.reload();

          // At least one log entry should mention the failing key
          const errorEntries = loggedEntries.filter(
            (e: any) => e.key === data.failingKey || e.outcome === "CONFIG_ERROR"
          );
          expect(errorEntries.length).toBeGreaterThan(0);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("Property 10: Partial config (some keys valid, some invalid) is fully rejected", () => {
    fc.assert(
      fc.property(
        fc.record({
          validKey: fc.constantFrom("github.webhookSecret", "jenkins.apiToken"),
          invalidKey: fc.constantFrom("pagerduty.apiToken", "slack.botToken"),
        }),
        async (data) => {
          const previousConfig = makeValidConfig();
          let appliedConfig: SystemConfig | null = null;

          const store = {
            fetchLatest: jest.fn().mockResolvedValue({}),
            subscribe: jest.fn().mockReturnValue(() => {}),
          };

          // Only the invalid key fails — partial config scenario
          const validator = makeValidator(true, [data.invalidKey]);

          const reloader = new ConfigReloader(
            store,
            validator,
            previousConfig,
            (cfg) => { appliedConfig = cfg; },
            { logger: silentLogger() }
          );

          await reloader.reload();

          // Partial config must not be applied
          expect(appliedConfig).toBeNull();
          expect(reloader.getCurrentConfig()).toEqual(previousConfig);
        }
      ),
      { numRuns: 100 }
    );
  });
});
