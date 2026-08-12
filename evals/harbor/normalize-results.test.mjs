import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CLI = fileURLToPath(new URL("./normalize-results.mjs", import.meta.url));
const NORMALIZED_SCHEMA_VERSION = 2;

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
    schema_version: NORMALIZED_SCHEMA_VERSION,
    arm: "baseline",
    task: "node-health-endpoint",
    trial: 1,
    reward_shape: "binary",
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

function countedReward(overrides = {}) {
  return {
    functional: 1,
    regression: 1,
    tests_unchanged: 1,
    shippable: 1,
    requirements_met: 3,
    requirements_total: 5,
    regression_met: 4,
    regression_total: 6,
    false_completion: 0,
    ...overrides
  };
}

test("records requirement and regression counts from a counted reward", () => {
  const reward = countedReward();
  const result = runNormalizer({ reward });

  assert.equal(result.status, 0, result.stderr);
  const normalized = JSON.parse(result.stdout);
  assert.deepEqual(normalized.counts, {
    requirements_met: reward.requirements_met,
    requirements_total: reward.requirements_total,
    regression_met: reward.regression_met,
    regression_total: reward.regression_total
  });
  assert.deepEqual(normalized.outcome, {
    functional: reward.functional,
    regression: reward.regression,
    tests_unchanged: reward.tests_unchanged,
    shippable: 1
  });
  assert.equal(Object.hasOwn(normalized.outcome, "requirements_met"), false);
});

test("does not let a requirement shortfall change shippable", () => {
  const reward = countedReward({
    requirements_met: 2,
    requirements_total: 5,
    functional: 1,
    regression: 1,
    tests_unchanged: 1,
    shippable: 1
  });
  const result = runNormalizer({ reward });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).outcome.shippable, 1);
});

test("rejects negative, non-integer, and met-exceeds-total counted metrics", () => {
  const cases = [
    { requirements_met: -1 },
    { regression_total: -2 },
    { requirements_met: 1.5 },
    { regression_met: 2.25 },
    { requirements_met: 6, requirements_total: 5 },
    { regression_met: 7, regression_total: 6 }
  ];
  for (const overrides of cases) {
    const result = runNormalizer({ reward: countedReward(overrides) });
    assert.notEqual(result.status, 0, JSON.stringify(overrides));
    assert.equal(result.stdout, "");
  }
});

test("rejects a reward that carries only some counted metrics", () => {
  const result = runNormalizer({
    reward: countedReward({ regression_total: undefined })
  });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
});

test("records absent counts as missing, never zero, for a hard-v2-shaped reward", () => {
  const result = runNormalizer({
    reward: { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 }
  });

  assert.equal(result.status, 0, result.stderr);
  const normalized = JSON.parse(result.stdout);
  assert.deepEqual(normalized.outcome, {
    functional: 1,
    regression: 1,
    tests_unchanged: 1,
    shippable: 1
  });
  assert.ok(normalized.counts === undefined || normalized.counts === null);
  for (const name of ["requirements_met", "requirements_total", "regression_met", "regression_total"]) {
    const recorded = normalized.counts?.[name] ?? normalized[name];
    assert.ok(recorded === undefined || recorded === null, name);
    assert.notEqual(recorded, 0, name);
    assert.equal(Object.hasOwn(normalized.outcome, name), false, `outcome.${name}`);
  }
});

test("records false_completion 0 and 1 from a campaign reward", () => {
  for (const falseCompletion of [0, 1]) {
    const reward = countedReward({ false_completion: falseCompletion });
    const result = runNormalizer({ reward });
    assert.equal(result.status, 0, result.stderr);
    const normalized = JSON.parse(result.stdout);
    assert.equal(normalized.false_completion, falseCompletion);
    assert.equal(Object.hasOwn(normalized.outcome, "false_completion"), false);
  }
});

test("rejects a campaign reward that omits false_completion", () => {
  const result = runNormalizer({
    reward: countedReward({ false_completion: undefined })
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required numeric reward metric "false_completion"/);
  assert.equal(result.stdout, "");
});

test("accepts a single-shot reward that omits false_completion", () => {
  const result = runNormalizer({
    reward: { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 }
  });
  assert.equal(result.status, 0, result.stderr);
  const normalized = JSON.parse(result.stdout);
  assert.equal(Object.hasOwn(normalized, "false_completion"), false);
  assert.equal(Object.hasOwn(normalized.outcome, "false_completion"), false);
});

test("records schema version and reward shape for binary and counted rewards", () => {
  const binary = runNormalizer({
    reward: { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 }
  });
  assert.equal(binary.status, 0, binary.stderr);
  const binaryRecord = JSON.parse(binary.stdout);
  assert.equal(binaryRecord.schema_version, NORMALIZED_SCHEMA_VERSION);
  assert.equal(binaryRecord.reward_shape, "binary");

  const counted = runNormalizer({ reward: countedReward() });
  assert.equal(counted.status, 0, counted.stderr);
  const countedRecord = JSON.parse(counted.stdout);
  assert.equal(countedRecord.schema_version, NORMALIZED_SCHEMA_VERSION);
  assert.equal(countedRecord.reward_shape, "counted");
});
