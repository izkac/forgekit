import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const task = path.join(here, "tasks", "forgekit-hard-v2", "reservation-confirmation-race");
const temporaryDirectories = new Set();
const dockerImage = `forgekit-reservation-review-${process.pid}`;
let dockerImageBuilt = false;
const untouchedReward = { functional: 0, regression: 1, tests_unchanged: 1, shippable: 0 };
const passingReward = { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 };

after(() => {
  if (dockerImageBuilt) spawnSync("docker", ["image", "rm", "-f", dockerImage], { encoding: "utf8" });
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
  assert.match(readFileSync(path.join(task, "task.toml"), "utf8"), /\[agent\]\ntimeout_sec = 1200\.0/);
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


test("candidate-controlled hidden-result markers cannot forge the trusted harness result", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  cpSync(
    path.join(task, "tests", "adversarial", "marker-forger.mjs"),
    path.join(fixture.app, "src", "confirmation-service.mjs")
  );
  assert.deepEqual(grade(fixture), {
    functional: 0, regression: 1, tests_unchanged: 1, shippable: 0
  });
});

test("decoy pass plus a top-level assertion is not a registered test-body mutant kill", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  writeFileSync(path.join(fixture.app, "src", "confirmation-concurrency.test.mjs"), `import assert from "node:assert/strict";
import { test } from "node:test";
import { ManualClock } from "./clock.mjs";
import { ConfirmationService } from "./confirmation-service.mjs";
import { MemoryReservationStore } from "./reservation-store.mjs";
test("decoy registered pass", () => assert.equal(2 + 2, 4));
let calls = 0;
const reservationStore = new MemoryReservationStore([{ id: "top", amount: 1, expiresAt: 2 }]);
const service = new ConfirmationService({
  reservationStore,
  clock: new ManualClock(1),
  paymentGateway: { async charge() { calls += 1; return { paymentId: "p" }; } }
});
const first = service.confirm("top", "key");
const second = service.confirm("top", "key");
assert.equal(calls, 1, "this assertion is module bootstrap, not a test callback");
await Promise.all([first, second]);
`);
  assert.deepEqual(grade(fixture), {
    functional: 0, regression: 1, tests_unchanged: 1, shippable: 0
  });
});

test("trusted snapshot restores submitted production after an untrusted classifier rewrite", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  const added = path.join(fixture.app, "src", "confirmation-concurrency.test.mjs");
  writeFileSync(added, `${readFileSync(added, "utf8")}
import { chmodSync, writeFileSync } from "node:fs";
test("attempt classifier-only production rewrite", () => {
  if (process.env.HARBOR_TEST_FILES) {
    const serviceFile = new URL("./confirmation-service.mjs", import.meta.url);
    chmodSync(serviceFile, 0o644);
    writeFileSync(serviceFile, "export class ConfirmationService {");
  }
});
`);
  assert.deepEqual(grade(fixture), passingReward);
});

test("a recursive application symlink is rejected before candidate execution", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  symlinkSync("errors.mjs", path.join(fixture.app, "src", "candidate-link.mjs"));
  assert.deepEqual(grade(fixture), {
    functional: 0, regression: 0, tests_unchanged: 0, shippable: 0
  });
});

test("syntax-broken HTTP composition is rejected by visible and hidden verification", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  writeFileSync(path.join(fixture.app, "src", "http-app.mjs"), "export function createHttpServer( {");
  assert.deepEqual(grade(fixture), {
    functional: 0, regression: 0, tests_unchanged: 1, shippable: 0
  });
});

test("Docker verifier root-owns a candidate-owned tree before rewrite attempts", { timeout: 180_000 }, (t) => {
  const available = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 15_000 });
  if (available.status !== 0) {
    t.skip("Docker daemon unavailable");
    return;
  }
  if (!dockerImageBuilt) {
    const built = spawnSync("docker", ["build", "-q", "-t", dockerImage, path.join(task, "tests")], {
      encoding: "utf8", timeout: 120_000
    });
    assert.equal(built.status, 0, built.stderr);
    dockerImageBuilt = true;
  }

  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  const added = path.join(fixture.app, "src", "confirmation-concurrency.test.mjs");
  writeFileSync(added, `${readFileSync(added, "utf8")}
import { appendFileSync, chmodSync } from "node:fs";
test("candidate cannot reclaim protected files", () => {
  for (const relative of ["../package.json", "./confirmation-service.test.mjs"]) {
    const target = new URL(relative, import.meta.url);
    try { chmodSync(target, 0o644); appendFileSync(target, "\\n// forged\\n"); } catch {}
  }
});
`);
  const rewardDirectory = path.join(fixture.directory, "docker-reward");
  mkdirSync(rewardDirectory);
  const mountApp = `${fixture.app}:/app`;
  const mountReward = `${rewardDirectory}:/logs/verifier`;
  const poisonOwnership = spawnSync("docker", ["run", "--rm", "-v", mountApp, dockerImage,
    "sh", "-c", "chown -R 65534:65534 /app && chmod -R u+rwX /app"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(poisonOwnership.status, 0, poisonOwnership.stderr);
  try {
    const checked = spawnSync("docker", ["run", "--rm", "-v", mountApp, "-v", mountReward,
      "-e", "HARBOR_APP_DIR=/app", dockerImage, "node", "/tests/grader.mjs"], {
      encoding: "utf8", timeout: 90_000
    });
    assert.equal(checked.status, 0, checked.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path.join(rewardDirectory, "reward.json"), "utf8")), passingReward);
  } finally {
    spawnSync("docker", ["run", "--rm", "-v", `${fixture.directory}:/cleanup`, dockerImage,
      "chown", "-R", `${process.getuid()}:${process.getgid()}`, "/cleanup"], { encoding: "utf8", timeout: 30_000 });
  }
});
