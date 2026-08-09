import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const task = path.join(here, "tasks", "forgekit-hard-v2", "reservation-confirmation-race");
const temporaryDirectories = new Set();
const untouchedReward = { functional: 0, regression: 1, tests_unchanged: 1, shippable: 0 };
const passingReward = { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 };

after(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function copyFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "forgekit-hard-reservation-"));
  temporaryDirectories.add(directory);
  const app = path.join(directory, "app");
  cpSync(path.join(task, "environment", "app"), app, { recursive: true });
  return { directory, app };
}

function apply(fixture, relativeScript) {
  const result = spawnSync("sh", [path.join(task, relativeScript)], {
    cwd: fixture.app,
    encoding: "utf8",
    env: { ...process.env, HARBOR_APP_DIR: fixture.app }
  });
  assert.equal(result.status, 0, result.stderr);
}

function grade(fixture) {
  const rewardFile = path.join(fixture.directory, "reward.json");
  const result = spawnSync(process.execPath, [path.join(task, "tests", "grader.mjs")], {
    encoding: "utf8",
    timeout: 90_000,
    env: {
      ...process.env,
      HARBOR_APP_DIR: fixture.app,
      HARBOR_REWARD_DIR: fixture.directory,
      HARBOR_REWARD_FILE: rewardFile
    }
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(rewardFile, "utf8"));
}

test("hard-v2 reservation manifest binds the versioned hard bug task and its visible entrypoint", () => {
  const manifest = JSON.parse(readFileSync(path.join(here, "corpora", "forgekit-hard-v2.json"), "utf8"));
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.corpus_id, "forgekit-hard-v2");
  assert.deepEqual(manifest.tasks, [{
    id: "reservation-confirmation-race",
    version: "1.0.0",
    category: "bug",
    difficulty: "hard",
    task_path: "tasks/forgekit-hard-v2/reservation-confirmation-race",
    entrypoint: "src/server.mjs",
    visible_tests: ["src/confirmation-service.test.mjs"]
  }]);
  const productionModules = readdirSync(path.join(task, "environment", "app", "src"))
    .filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs"));
  assert.ok(productionModules.length >= 5 && productionModules.length <= 9);
});

test("untouched seeded app passes regressions but fails the race contract", () => {
  assert.deepEqual(grade(copyFixture()), untouchedReward);
});

test("known-good oracle earns every binary reward", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  assert.deepEqual(grade(fixture), passingReward);
});

test("structurally different alternate solution also earns every binary reward", () => {
  const fixture = copyFixture();
  apply(fixture, "fixtures/alternate-positive/solve.sh");
  assert.deepEqual(grade(fixture), passingReward);
});

test("editing the protected visible test prevents shipment", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  const visible = path.join(fixture.app, "src", "confirmation-service.test.mjs");
  writeFileSync(visible, `${readFileSync(visible, "utf8")}
// modified by candidate
`);
  assert.deepEqual(grade(fixture), {
    functional: 1, regression: 1, tests_unchanged: 0, shippable: 0
  });
});

test("a production-only repair without an added concurrency test is not functional", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  for (const name of readdirSync(path.join(fixture.app, "src"))) {
    if (name.endsWith(".test.mjs") && name !== "confirmation-service.test.mjs") {
      rmSync(path.join(fixture.app, "src", name));
    }
  }
  assert.deepEqual(grade(fixture), {
    functional: 0, regression: 1, tests_unchanged: 1, shippable: 0
  });
});

test("an added test that survives the semantic concurrency mutant is rejected", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  const added = path.join(fixture.app, "src", "confirmation-concurrency.test.mjs");
  writeFileSync(added, `import assert from "node:assert/strict";
import { test } from "node:test";
import { ManualClock } from "./clock.mjs";
test("unrelated clock arithmetic", () => assert.equal(new ManualClock(41).now() + 1, 42));
`);
  assert.deepEqual(grade(fixture), {
    functional: 0, regression: 1, tests_unchanged: 1, shippable: 0
  });
});

test("a non-assertion crash on the mutant does not qualify as a killed mutant", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  const added = path.join(fixture.app, "src", "confirmation-concurrency.test.mjs");
  writeFileSync(added, `import { test } from "node:test";
import { ManualClock } from "./clock.mjs";
import { ConfirmationService } from "./confirmation-service.mjs";
import { MemoryReservationStore } from "./reservation-store.mjs";
test("second gateway entry crashes instead of asserting the contract", async () => {
  let calls = 0;
  const paymentGateway = { async charge() {
    calls += 1;
    if (calls > 1) throw new Error("unclassified gateway crash");
    return { paymentId: "one" };
  } };
  const reservationStore = new MemoryReservationStore([{ id: "r", amount: 1, expiresAt: 2 }]);
  const service = new ConfirmationService({ reservationStore, paymentGateway, clock: new ManualClock(1) });
  await Promise.all([service.confirm("r", "key"), service.confirm("r", "key")]);
});
`);
  assert.deepEqual(grade(fixture), {
    functional: 0, regression: 1, tests_unchanged: 1, shippable: 0
  });
});

test("reintroducing the semantic race mutant fails even with the oracle test present", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  cpSync(
    path.join(task, "tests", "mutants", "confirmation-service.mjs"),
    path.join(fixture.app, "src", "confirmation-service.mjs")
  );
  assert.deepEqual(grade(fixture), {
    functional: 0, regression: 0, tests_unchanged: 1, shippable: 0
  });
});
