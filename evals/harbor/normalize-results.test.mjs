import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CLI = fileURLToPath(new URL("./normalize-results.mjs", import.meta.url));

function runNormalizer({ reward, forgeSummary, forgeSummaryRaw, harborResult, harborJobResult, arm = "baseline", task = "node-health-endpoint", trial = "1" }) {
  const directory = mkdtempSync(join(tmpdir(), "forge-normalizer-"));
  const rewardPath = join(directory, "reward.json");
  writeFileSync(rewardPath, JSON.stringify(reward));
  const args = [CLI, "--reward", rewardPath, "--arm", arm, "--task", task, "--trial", trial];

  if (forgeSummary !== undefined || forgeSummaryRaw !== undefined) {
    const summaryPath = join(directory, "forge-summary.json");
    writeFileSync(summaryPath, forgeSummaryRaw ?? JSON.stringify(forgeSummary));
    args.push("--forge-summary", summaryPath);
  }
  if (harborResult !== undefined) {
    const resultPath = join(directory, "harbor-result.json");
    writeFileSync(resultPath, JSON.stringify(harborResult));
    args.push("--harbor-result", resultPath);
  }
  if (harborJobResult !== undefined) {
    const jobResultPath = join(directory, "harbor-job-result.json");
    writeFileSync(jobResultPath, JSON.stringify(harborJobResult));
    args.push("--harbor-job-result", jobResultPath);
  }

  return spawnSync(process.execPath, args, { encoding: "utf8" });
}

test("preserves verifier outcomes when Forge telemetry is absent", () => {
  const result = runNormalizer({
    reward: { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schema_version: 1,
    arm: "baseline",
    task: "node-health-endpoint",
    trial: 1,
    outcome: {
      functional: 1,
      regression: 1,
      tests_unchanged: 1,
      shippable: 1
    },
    instrumentation: {
      available: false,
      reason: "Forge artifact summary was not provided",
      forge: null,
      harbor: {
        available: false,
        reason: "Harbor trial result was not provided",
        wall_clock_seconds: null,
        input_tokens: null,
        cache_tokens: null,
        output_tokens: null,
        cost_usd: null,
        retries: null
      }
    }
  });
});

test("includes an optional Forge artifact summary as secondary instrumentation", () => {
  const forgeSummary = {
    session: "20260809T134013Z-agentic-evals-79d810",
    scorecard: { tests: "fail" },
    telemetry: { hooks: 3 }
  };
  const result = runNormalizer({
    arm: "forge",
    trial: "2",
    reward: { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 },
    forgeSummary
  });

  assert.equal(result.status, 0, result.stderr);
  const normalized = JSON.parse(result.stdout);
  assert.equal(normalized.trial, 2);
  assert.deepEqual(normalized.instrumentation, {
    available: true,
    reason: null,
    forge: forgeSummary,
    harbor: {
      available: false,
      reason: "Harbor trial result was not provided",
      wall_clock_seconds: null,
      input_tokens: null,
      cache_tokens: null,
      output_tokens: null,
      cost_usd: null,
      retries: null
    }
  });
  assert.equal(normalized.outcome.shippable, 1);
});

test("computes shippable conservatively from every required verifier metric", () => {
  const result = runNormalizer({
    reward: { functional: 1, regression: 0, tests_unchanged: 1, shippable: 1 }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).outcome, {
    functional: 1,
    regression: 0,
    tests_unchanged: 1,
    shippable: 0
  });
});

test("does not upgrade an external verifier's shippable failure", () => {
  const result = runNormalizer({
    reward: { functional: 1, regression: 1, tests_unchanged: 1, shippable: 0 }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome.shippable, 0);
});

test("rejects a missing required outcome metric instead of treating it as passing", () => {
  const result = runNormalizer({
    reward: { functional: 1, regression: 1, shippable: 1 }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required numeric reward metric "tests_unchanged"/);
  assert.equal(result.stdout, "");
});

test("rejects non-numeric and non-finite verifier metrics", () => {
  for (const functional of ["1", null]) {
    const result = runNormalizer({
      reward: { functional, regression: 1, tests_unchanged: 1, shippable: 1 }
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required numeric reward metric "functional"/);
  }
});

test("requires valid arm and identity arguments", () => {
  const result = runNormalizer({
    arm: "treatment",
    reward: { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--arm must be baseline or forge/);
});


test("unreadable or malformed optional Forge telemetry remains explicitly unavailable", () => {
  const result = runNormalizer({
    reward: { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 },
    forgeSummaryRaw: "not json"
  });

  assert.equal(result.status, 0, result.stderr);
  const normalized = JSON.parse(result.stdout);
  assert.equal(normalized.outcome.shippable, 1);
  assert.equal(normalized.instrumentation.available, false);
  assert.match(normalized.instrumentation.reason, /Invalid JSON in Forge artifact summary/);
  assert.equal(normalized.instrumentation.forge, null);
});

test("rejects trial identifiers that are not safe integers", () => {
  const result = runNormalizer({
    trial: "9007199254740992",
    reward: { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /safe positive integer/);
});

test("normalizes available Harbor cost, token, retry, and timing instrumentation", () => {
  const result = runNormalizer({
    reward: { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 },
    harborResult: {
      started_at: "2026-08-09T00:00:00.000Z",
      finished_at: "2026-08-09T00:00:12.500Z",
      agent_result: { n_input_tokens: 100, n_cache_tokens: 20, n_output_tokens: 30, cost_usd: 0.25 },
      retry_count: 99
    },
    harborJobResult: { stats: { n_retries: 2 } }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).instrumentation.harbor, {
    available: true,
    reason: null,
    wall_clock_seconds: 12.5,
    input_tokens: 100,
    cache_tokens: 20,
    output_tokens: 30,
    cost_usd: 0.25,
    retries: 2
  });
});
