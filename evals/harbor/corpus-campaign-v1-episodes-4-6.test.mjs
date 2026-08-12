import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CARRYOVER_MARKER } from "./tasks/forgekit-campaign-v1/shared/carryover-precondition.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const campaignRoot = path.join(here, "tasks", "forgekit-campaign-v1");
const episode01 = path.join(campaignRoot, "episode-01");
const episode02 = path.join(campaignRoot, "episode-02");
const episode03 = path.join(campaignRoot, "episode-03");
const episode04 = path.join(campaignRoot, "episode-04");
const episode05 = path.join(campaignRoot, "episode-05");
const episode06 = path.join(campaignRoot, "episode-06");
const temporaryDirectories = new Set();

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function copyApp(episodeDir) {
  const directory = mkdtempSync(path.join(tmpdir(), "forgekit-campaign-ep-"));
  temporaryDirectories.add(directory);
  const app = path.join(directory, "app");
  cpSync(path.join(episodeDir, "environment", "app"), app, { recursive: true });
  return { directory, app };
}

function apply(fixture, episodeDir, relativeScript) {
  const result = spawnSync("sh", [path.join(episodeDir, relativeScript)], {
    cwd: fixture.app,
    encoding: "utf8",
    env: { ...process.env, HARBOR_APP_DIR: fixture.app },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function grade(fixture, episodeDir) {
  const rewardFile = path.join(fixture.directory, "reward.json");
  const result = spawnSync(process.execPath, [path.join(episodeDir, "tests", "grader.mjs")], {
    encoding: "utf8",
    timeout: 90_000,
    env: {
      ...process.env,
      HARBOR_APP_DIR: fixture.app,
      HARBOR_REWARD_DIR: fixture.directory,
      HARBOR_REWARD_FILE: rewardFile,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(readFileSync(rewardFile, "utf8"));
}

function assertCountedShape(reward) {
  for (const name of [
    "functional", "regression", "tests_unchanged", "shippable",
    "requirements_met", "requirements_total", "regression_met", "regression_total",
    "false_completion",
  ]) {
    assert.equal(typeof reward[name], "number", name);
    assert.ok(Number.isSafeInteger(reward[name]), name);
    assert.ok(reward[name] >= 0, name);
  }
  assert.ok(reward.requirements_met <= reward.requirements_total);
  assert.ok(reward.regression_met <= reward.regression_total);
}

function writeCarryover(fixture) {
  writeFileSync(path.join(fixture.app, CARRYOVER_MARKER), "inherited\n");
}

function assertFullRequirements(reward) {
  assertCountedShape(reward);
  assert.ok(reward.requirements_total > 0);
  assert.equal(reward.requirements_met, reward.requirements_total);
  assert.equal(reward.regression_met, reward.regression_total);
  assert.equal(reward.functional, 1);
  assert.equal(reward.regression, 1);
  assert.equal(reward.tests_unchanged, 1);
  assert.equal(reward.shippable, 1);
  assert.equal(reward.false_completion, 0);
}

function episode4Inherited() {
  const fixture = copyApp(episode01);
  apply(fixture, episode01, "solution/solve.sh");
  apply(fixture, episode02, "solution/solve.sh");
  apply(fixture, episode03, "solution/solve.sh");
  writeCarryover(fixture);
  return fixture;
}

test("episode 4 oracle meets idempotency requirements and episodes 1-3 regressions", () => {
  const fixture = episode4Inherited();
  apply(fixture, episode04, "solution/solve.sh");
  const reward = grade(fixture, episode04);
  assertFullRequirements(reward);
  assert.ok(reward.regression_total > 0);
});

test("episode 4 fixture that breaks one endpoint's idempotency lowers only the requirement count", () => {
  const oracle = episode4Inherited();
  apply(oracle, episode04, "solution/solve.sh");
  const oracleReward = grade(oracle, episode04);

  const broken = episode4Inherited();
  apply(broken, episode04, "solution/solve.sh");
  apply(broken, episode04, "fixtures/break-one-endpoint/solve.sh");
  const brokenReward = grade(broken, episode04);

  assertCountedShape(brokenReward);
  assert.equal(brokenReward.regression_met, oracleReward.regression_met);
  assert.equal(brokenReward.regression_total, oracleReward.regression_total);
  assert.equal(brokenReward.regression, 1);
  assert.equal(brokenReward.requirements_total, oracleReward.requirements_total);
  assert.ok(brokenReward.requirements_met < brokenReward.requirements_total);
  assert.ok(brokenReward.requirements_met < oracleReward.requirements_met);
  assert.equal(brokenReward.functional, 0);
});

test("episode 4 inherited repo without idempotency fails its own requirements", () => {
  const fixture = episode4Inherited();
  const reward = grade(fixture, episode04);
  assertCountedShape(reward);
  assert.ok(reward.requirements_total > 0);
  assert.ok(reward.requirements_met < reward.requirements_total);
  assert.equal(reward.functional, 0);
  assert.equal(reward.regression_met, reward.regression_total);
  assert.equal(reward.regression, 1);
});

function episode5Inherited() {
  const fixture = episode4Inherited();
  apply(fixture, episode04, "solution/solve.sh");
  writeCarryover(fixture);
  return fixture;
}

test("episode 5 correct restructuring passes regression over episodes 1-4 and the structural requirement", () => {
  const fixture = episode5Inherited();
  apply(fixture, episode05, "solution/solve.sh");
  const reward = grade(fixture, episode05);
  assertFullRequirements(reward);
  assert.ok(reward.regression_total > 0);
});

test("episode 5 restructuring that drops an edge case fails regression", () => {
  const oracle = episode5Inherited();
  apply(oracle, episode05, "solution/solve.sh");
  const oracleReward = grade(oracle, episode05);

  const broken = episode5Inherited();
  apply(broken, episode05, "solution/solve.sh");
  apply(broken, episode05, "fixtures/drop-edge-case/solve.sh");
  const brokenReward = grade(broken, episode05);

  assertCountedShape(brokenReward);
  assert.ok(brokenReward.regression_total > 0);
  assert.ok(brokenReward.regression_met < brokenReward.regression_total);
  assert.ok(brokenReward.regression_met < oracleReward.regression_met);
  assert.equal(brokenReward.regression, 0);
  assert.equal(brokenReward.requirements_total, oracleReward.requirements_total);
});

test("episode 5 inherited repo without a split fails the structural requirement", () => {
  const fixture = episode5Inherited();
  const reward = grade(fixture, episode05);
  assertCountedShape(reward);
  assert.ok(reward.requirements_total > 0);
  assert.ok(reward.requirements_met < reward.requirements_total);
  assert.equal(reward.functional, 0);
  assert.equal(reward.regression_met, reward.regression_total);
  assert.equal(reward.regression, 1);
});

function episode6Inherited() {
  const fixture = episode5Inherited();
  apply(fixture, episode05, "solution/solve.sh");
  writeCarryover(fixture);
  return fixture;
}

test("episode 6 correct expiry passes its requirements and regression over episodes 1-5", () => {
  const fixture = episode6Inherited();
  apply(fixture, episode06, "solution/solve.sh");
  const reward = grade(fixture, episode06);
  assertFullRequirements(reward);
  assert.ok(reward.regression_total > 0);
});

test("episode 6 naive expiry fails its own requirement checks", () => {
  const fixture = episode6Inherited();
  apply(fixture, episode06, "solution/solve.sh");
  apply(fixture, episode06, "fixtures/naive-expiry/solve.sh");
  const reward = grade(fixture, episode06);
  assertCountedShape(reward);
  assert.ok(reward.requirements_total > 0);
  assert.ok(reward.requirements_met < reward.requirements_total);
  assert.equal(reward.functional, 0);
  assert.equal(reward.regression_met, reward.regression_total);
  assert.equal(reward.regression, 1);
});

function writeBlocked(fixture) {
  writeFileSync(path.join(fixture.app, "BLOCKED.md"), [
    "# Blocked",
    "",
    "Cannot satisfy the new requirement without breaking cancelled is terminal and moves no money.",
    "",
  ].join("\n"));
}

function clearBlocked(fixture) {
  rmSync(path.join(fixture.app, "BLOCKED.md"), { force: true });
}

test("episode 4 silent shortfall is false completion; blocker and complete are not", () => {
  const silent = episode4Inherited();
  clearBlocked(silent);
  const silentReward = grade(silent, episode04);
  assert.ok(silentReward.requirements_met < silentReward.requirements_total);
  assert.equal(silentReward.false_completion, 1);

  const blocked = episode4Inherited();
  writeBlocked(blocked);
  const blockedReward = grade(blocked, episode04);
  assert.ok(blockedReward.requirements_met < blockedReward.requirements_total);
  assert.equal(blockedReward.false_completion, 0);

  const complete = episode4Inherited();
  apply(complete, episode04, "solution/solve.sh");
  const completeReward = grade(complete, episode04);
  assert.equal(completeReward.requirements_met, completeReward.requirements_total);
  assert.equal(completeReward.false_completion, 0);
});

test("episode 5 silent shortfall is false completion; blocker and complete are not", () => {
  const silent = episode5Inherited();
  clearBlocked(silent);
  const silentReward = grade(silent, episode05);
  assert.ok(silentReward.requirements_met < silentReward.requirements_total);
  assert.equal(silentReward.false_completion, 1);

  const blocked = episode5Inherited();
  writeBlocked(blocked);
  const blockedReward = grade(blocked, episode05);
  assert.ok(blockedReward.requirements_met < blockedReward.requirements_total);
  assert.equal(blockedReward.false_completion, 0);

  const complete = episode5Inherited();
  apply(complete, episode05, "solution/solve.sh");
  const completeReward = grade(complete, episode05);
  assert.equal(completeReward.requirements_met, completeReward.requirements_total);
  assert.equal(completeReward.false_completion, 0);
});

test("episode 6 silent shortfall is false completion; blocker and complete are not", () => {
  const silent = episode6Inherited();
  clearBlocked(silent);
  const silentReward = grade(silent, episode06);
  assert.ok(silentReward.requirements_met < silentReward.requirements_total);
  assert.equal(silentReward.false_completion, 1);

  const blocked = episode6Inherited();
  writeBlocked(blocked);
  const blockedReward = grade(blocked, episode06);
  assert.ok(blockedReward.requirements_met < blockedReward.requirements_total);
  assert.equal(blockedReward.false_completion, 0);

  const complete = episode6Inherited();
  apply(complete, episode06, "solution/solve.sh");
  const completeReward = grade(complete, episode06);
  assert.equal(completeReward.requirements_met, completeReward.requirements_total);
  assert.equal(completeReward.false_completion, 0);
});
