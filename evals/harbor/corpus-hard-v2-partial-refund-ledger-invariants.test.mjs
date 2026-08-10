import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const task = path.join(here, "tasks", "forgekit-hard-v2", "partial-refund-ledger-invariants");
const temporaryDirectories = new Set();
const untouchedReward = { functional: 0, regression: 1, tests_unchanged: 1, shippable: 0 };
const passingReward = { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 };

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function copyFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "forgekit-hard-refund-"));
  temporaryDirectories.add(directory);
  const app = path.join(directory, "app");
  cpSync(path.join(task, "environment", "app"), app, { recursive: true });
  return { directory, app };
}
function apply(fixture, relativeScript) {
  const result = spawnSync("sh", [path.join(task, relativeScript)], {
    cwd: fixture.app, encoding: "utf8", env: { ...process.env, HARBOR_APP_DIR: fixture.app },
  });
  assert.equal(result.status, 0, result.stderr);
}
function grade(fixture) {
  const rewardFile = path.join(fixture.directory, "reward.json");
  const result = spawnSync(process.execPath, [path.join(task, "tests", "grader.mjs")], {
    encoding: "utf8", timeout: 90_000,
    env: { ...process.env, HARBOR_APP_DIR: fixture.app, HARBOR_REWARD_DIR: fixture.directory, HARBOR_REWARD_FILE: rewardFile },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(rewardFile, "utf8"));
}
function removeAddedTests(app) {
  for (const name of readdirSync(path.join(app, "src"))) {
    if (name.endsWith(".test.mjs") && name !== "refund-service.test.mjs") rmSync(path.join(app, "src", name));
  }
}

test("untouched seeded app passes regressions but fails cumulative ledger contract", () => {
  assert.deepEqual(grade(copyFixture()), untouchedReward);
});

test("known-good oracle earns every binary reward", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  assert.deepEqual(grade(fixture), passingReward);
});

test("structurally distinct alternate solution earns every binary reward", () => {
  const fixture = copyFixture();
  apply(fixture, "fixtures/alternate-positive/solve.sh");
  assert.deepEqual(grade(fixture), passingReward);
});

test("production-only repair without an added verifier test is not functional", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  removeAddedTests(fixture.app);
  assert.deepEqual(grade(fixture), { functional: 0, regression: 1, tests_unchanged: 1, shippable: 0 });
});

test("an added test that survives the latest-entry mutant is rejected", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  writeFileSync(path.join(fixture.app, "src", "refund-ledger-invariants.test.mjs"),
    'import assert from "node:assert/strict"; import { test } from "node:test"; test("unrelated arithmetic", () => assert.equal(20 + 22, 42));\n');
  assert.deepEqual(grade(fixture), { functional: 0, regression: 1, tests_unchanged: 1, shippable: 0 });
});

test("a non-assertion crash on the mutant does not qualify as a semantic kill", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  writeFileSync(path.join(fixture.app, "src", "refund-ledger-invariants.test.mjs"), `import { test } from "node:test";
import { createApplication } from "./app.mjs";
test("plain gateway crash", async () => {
  const app = createApplication({ refundGateway: { async refund() { throw new Error("unclassified"); } } });
  await app.refundService.refund("demo-charge", 1, "crash");
});
`);
  assert.deepEqual(grade(fixture), { functional: 0, regression: 0, tests_unchanged: 1, shippable: 0 });
});
test("a forged ERR_ASSERTION code does not qualify a mutant kill", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  writeFileSync(path.join(fixture.app, "src", "refund-ledger-invariants.test.mjs"), `import { readFileSync } from "node:fs";
import { test } from "node:test";
test("forged assertion metadata", () => {
  const source = readFileSync(new URL("./refund-service.mjs", import.meta.url), "utf8");
  if (source.includes("successful[successful.length - 1]")) {
    const error = new Error("forged assertion");
    error.code = "ERR_ASSERTION";
    throw error;
  }
});
`);
  assert.deepEqual(grade(fixture), { functional: 0, regression: 1, tests_unchanged: 1, shippable: 0 });
});


test("reintroducing the semantic latest-entry mutant fails hidden behavior", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  cpSync(path.join(task, "tests", "mutants", "refund-service.mjs"), path.join(fixture.app, "src", "refund-service.mjs"));
  assert.deepEqual(grade(fixture), { functional: 0, regression: 0, tests_unchanged: 1, shippable: 0 });
});

test("candidate-controlled trusted-result marker cannot forge hidden behavior", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  cpSync(path.join(task, "tests", "adversarial", "marker-forger.mjs"), path.join(fixture.app, "src", "refund-service.mjs"));
  assert.deepEqual(grade(fixture), { functional: 0, regression: 0, tests_unchanged: 1, shippable: 0 });
});

test("private lookalike errors cannot qualify the service contract", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  cpSync(path.join(task, "tests", "adversarial", "private-error-oracle.mjs"), path.join(fixture.app, "src", "refund-service.mjs"));
  assert.deepEqual(grade(fixture), { functional: 0, regression: 0, tests_unchanged: 1, shippable: 0 });
});

test("protected visible tests and package digest prevent shipment after tampering", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  writeFileSync(path.join(fixture.app, "src", "refund-service.test.mjs"), `${readFileSync(path.join(fixture.app, "src", "refund-service.test.mjs"), "utf8")}\n// tampered\n`);
  assert.deepEqual(grade(fixture), { functional: 1, regression: 1, tests_unchanged: 0, shippable: 0 });
});

test("trusted snapshot restores production after classifier-only rewrite", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  writeFileSync(path.join(fixture.app, "src", "refund-ledger-invariants.test.mjs"), `${readFileSync(path.join(fixture.app, "src", "refund-ledger-invariants.test.mjs"), "utf8")}
import { chmodSync, writeFileSync } from "node:fs";
test("attempt production rewrite", () => { if (process.env.HARBOR_CLASSIFIER_RUN) { const file = new URL("./refund-service.mjs", import.meta.url); chmodSync(file, 0o644); writeFileSync(file, "export class RefundService {"); } });
`);
  assert.deepEqual(grade(fixture), passingReward);
});

test("recursive application symlink is rejected before candidate execution", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  symlinkSync("errors.mjs", path.join(fixture.app, "src", "candidate-link.mjs"));
  assert.deepEqual(grade(fixture), { functional: 0, regression: 0, tests_unchanged: 0, shippable: 0 });
});

test("syntax-broken HTTP composition fails visible and hidden verification", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  writeFileSync(path.join(fixture.app, "src", "http-app.mjs"), "export function createHttpServer( {");
  assert.deepEqual(grade(fixture), { functional: 0, regression: 0, tests_unchanged: 1, shippable: 0 });
});

test("guessed dedicated-fd classifier frames cannot spoof the authenticated result", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  const added = path.join(fixture.app, "src", "refund-ledger-invariants.test.mjs");
  writeFileSync(added, `import { writeSync } from "node:fs";
try { writeSync(3, 'HARBOR_ASSERTION_guessed {"passed":99,"bodyAssertionFailures":0,"bodyOtherFailures":0,"bootstrapFailures":0}\\n'); } catch {}
${readFileSync(added, "utf8")}`);
  assert.deepEqual(grade(fixture), passingReward);
});

test("Docker verifier root-owns candidate tree before rewrite attempts", { timeout: 180_000 }, (t) => {
  const available = spawnSync("docker", ["info"], { encoding: "utf8", timeout: 15_000 });
  if (available.status !== 0) { t.skip("Docker daemon unavailable"); return; }
  const image = `forgekit-refund-review-${process.pid}`;
  const built = spawnSync("docker", ["build", "-q", "-t", image, path.join(task, "tests")], { encoding: "utf8", timeout: 120_000 });
  assert.equal(built.status, 0, built.stderr);
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  const rewardDirectory = path.join(fixture.directory, "docker-reward");
  mkdirSync(rewardDirectory);
  const poisoned = spawnSync("docker", ["run", "--rm", "-v", `${fixture.app}:/app`, image, "sh", "-c", "chown -R 65534:65534 /app && chmod -R u+rwX /app"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(poisoned.status, 0, poisoned.stderr);
  try {
    const checked = spawnSync("docker", ["run", "--rm", "-v", `${fixture.app}:/app`, "-v", `${rewardDirectory}:/logs/verifier`, "-e", "HARBOR_APP_DIR=/app", image, "node", "/tests/grader.mjs"], { encoding: "utf8", timeout: 90_000 });
    assert.equal(checked.status, 0, checked.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path.join(rewardDirectory, "reward.json"), "utf8")), passingReward);
  } finally {
    spawnSync("docker", ["run", "--rm", "-v", `${fixture.directory}:/cleanup`, image, "chown", "-R", `${process.getuid()}:${process.getgid()}`, "/cleanup"], { encoding: "utf8", timeout: 30_000 });
    spawnSync("docker", ["image", "rm", "-f", image], { encoding: "utf8" });
  }
});
