import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const task = path.join(here, "tasks", "forgekit-hard-v2", "tenant-signed-downloads");
const temporaryDirectories = new Set();
const untouchedReward = { functional: 0, regression: 1, tests_unchanged: 1, shippable: 0 };
const passingReward = { functional: 1, regression: 1, tests_unchanged: 1, shippable: 1 };
const visibleTests = new Set([
  "capability-service.test.mjs",
  "document-store.test.mjs",
  "http-app.test.mjs",
]);

after(() => {
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
});

function copyFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "forgekit-hard-signed-downloads-"));
  temporaryDirectories.add(directory);
  const app = path.join(directory, "app");
  cpSync(path.join(task, "environment", "app"), app, { recursive: true });
  return { directory, app };
}

function apply(fixture, relativeScript) {
  const result = spawnSync("sh", [path.join(task, relativeScript)], {
    cwd: fixture.app,
    encoding: "utf8",
    env: { ...process.env, HARBOR_APP_DIR: fixture.app },
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
      HARBOR_REWARD_FILE: rewardFile,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(rewardFile, "utf8"));
}

function removeAddedTests(fixture) {
  for (const name of readdirSync(path.join(fixture.app, "src"))) {
    if (name.endsWith(".test.mjs") && !visibleTests.has(name)) rmSync(path.join(fixture.app, "src", name));
  }
}

test("verifier metadata declares the actual tenant-omission mutant and separate no-network boundary", () => {
  const metadata = readFileSync(path.join(task, "task.toml"), "utf8");
  assert.match(metadata, /environment_mode = "separate"/);
  assert.match(metadata, /semantic_mutants = \["tests\/mutants\/capability-service\.mjs"\]/);
  assert.match(metadata, /\[verifier\.environment\][\s\S]*network_mode = "no-network"/);
  const dockerfile = readFileSync(path.join(task, "tests", "Dockerfile"), "utf8");
  assert.match(dockerfile, /HARBOR_UNTRUSTED_UID=65534/);
  assert.match(dockerfile, /HARBOR_UNTRUSTED_GID=65534/);
  assert.match(dockerfile, /chmod -R 700 \/tests/);
});

test("untouched seeded app preserves regressions and protected files but is not functional", () => {
  assert.deepEqual(grade(copyFixture()), untouchedReward);
});

test("known-good oracle earns every binary reward", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  assert.deepEqual(grade(fixture), passingReward);
});

test("structurally distinct alternate positive earns every binary reward", () => {
  const fixture = copyFixture();
  apply(fixture, "fixtures/alternate-positive/solve.sh");
  assert.deepEqual(grade(fixture), passingReward);
});

test("editing a protected visible test prevents shipment", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  const visible = path.join(fixture.app, "src", "http-app.test.mjs");
  writeFileSync(visible, `${readFileSync(visible, "utf8")}\n// candidate tamper\n`);
  assert.deepEqual(grade(fixture), {
    functional: 1, regression: 1, tests_unchanged: 0, shippable: 0,
  });
});

test("editing protected package metadata prevents shipment", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  const packageFile = path.join(fixture.app, "package.json");
  const value = JSON.parse(readFileSync(packageFile, "utf8"));
  value.description = "candidate tamper";
  writeFileSync(packageFile, `${JSON.stringify(value)}\n`);
  assert.deepEqual(grade(fixture), {
    functional: 1, regression: 1, tests_unchanged: 0, shippable: 0,
  });
});

test("a production-only repair without an added tenant regression test is not functional", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  removeAddedTests(fixture);
  assert.deepEqual(grade(fixture), untouchedReward);
});

test("an added test that survives the tenant-omission mutant is rejected", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  removeAddedTests(fixture);
  writeFileSync(path.join(fixture.app, "src", "tenant-isolation.test.mjs"), `import assert from "node:assert/strict";
import { test } from "node:test";
import { ManualClock } from "./clock.mjs";
test("unrelated manual clock check", () => assert.equal(new ManualClock(41).now() + 1, 42));
`);
  assert.deepEqual(grade(fixture), untouchedReward);
});

test("a non-assertion test-body crash on the mutant does not qualify", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  removeAddedTests(fixture);
  writeFileSync(path.join(fixture.app, "src", "tenant-isolation.test.mjs"), `import { test } from "node:test";
import { CapabilityService } from "./capability-service.mjs";
import { ManualClock } from "./clock.mjs";
const keys = new Map([["atlas", "shared"], ["boreal", "shared"]]);
test("plain crash is not an assertion", () => {
  const service = new CapabilityService({ clock: new ManualClock(1), signingKeys: keys });
  const atlas = service.issue({ tenantId: "atlas", documentId: "same", expiresAt: 2 });
  const boreal = service.issue({ tenantId: "boreal", documentId: "same", expiresAt: 2 });
  if (atlas.signature === boreal.signature) throw new Error("tenant omission observed without an assertion");
});
`);
  assert.deepEqual(grade(fixture), untouchedReward);
});
test("a source-gated forged assertion marker remains non-qualifying", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  removeAddedTests(fixture);
  writeFileSync(path.join(fixture.app, "src", "tenant-isolation.test.mjs"), `import { AssertionError } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const source = readFileSync(new URL("./capability-service.mjs", import.meta.url), "utf8");
test("source-gated no-op", async () => {
  if (!source.includes("tenantOmittingPayload")) return;
  let loader = process.execArgv.find((arg, index) => process.execArgv[index - 1] === "--loader") || "";
  for (let index = 0; index < 4; index += 1) loader = decodeURIComponent(loader);
  const stateSpecifier = loader.match(/node:harbor-state-HARBOR_ASSERTION_MARKER_[a-f0-9]+/)?.[0];
  if (stateSpecifier) {
    try { await import(stateSpecifier); } catch {}
  }
  const error = Object.setPrototypeOf(new Error("forged assertion marker"), AssertionError.prototype);
  error.code = "ERR_ASSERTION";
  error.cause = { code: "ERR_ASSERTION" };
  throw error;
});
`);
  assert.deepEqual(grade(fixture), untouchedReward);
});
test("direct default assertion failures qualify legitimate mutant kills", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  removeAddedTests(fixture);
  writeFileSync(path.join(fixture.app, "src", "tenant-isolation.test.mjs"), `import assert from "node:assert";
import { test } from "node:test";
import { ManualClock } from "./clock.mjs";
import { CapabilityService } from "./capability-service.mjs";
test("direct default assertion catches tenant omission", () => {
  const service = new CapabilityService({
    clock: new ManualClock(1),
    signingKeys: new Map([["atlas", "shared"], ["boreal", "shared"]]),
  });
  const atlas = service.issue({ tenantId: "atlas", documentId: "same", expiresAt: 2 });
  const boreal = service.issue({ tenantId: "boreal", documentId: "same", expiresAt: 2 });
  assert.notEqual(atlas.signature, boreal.signature);
});
`);
  assert.deepEqual(grade(fixture), passingReward);
});



test("reintroducing the complete semantic tenant-omission mutant is non-shippable", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  cpSync(path.join(task, "tests", "mutants", "capability-service.mjs"), path.join(fixture.app, "src", "capability-service.mjs"));
  assert.deepEqual(grade(fixture), {
    functional: 0, regression: 0, tests_unchanged: 1, shippable: 0,
  });
});

test("candidate-controlled hidden result markers cannot forge functional behavior", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  cpSync(path.join(task, "tests", "adversarial", "marker-forger.mjs"), path.join(fixture.app, "src", "capability-service.mjs"));
  assert.deepEqual(grade(fixture), untouchedReward);
});

test("a decoy pass plus top-level assertion is not an authenticated test-body mutant kill", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  removeAddedTests(fixture);
  writeFileSync(path.join(fixture.app, "src", "tenant-isolation.test.mjs"), `import assert from "node:assert/strict";
import { test } from "node:test";
import { CapabilityService } from "./capability-service.mjs";
import { ManualClock } from "./clock.mjs";
test("decoy registered pass", () => assert.equal(2 + 2, 4));
const service = new CapabilityService({ clock: new ManualClock(1), signingKeys: new Map([["a", "k"], ["b", "k"]]) });
const a = service.issue({ tenantId: "a", documentId: "same", expiresAt: 2 });
const b = service.issue({ tenantId: "b", documentId: "same", expiresAt: 2 });
assert.notEqual(a.signature, b.signature, "bootstrap assertions do not qualify");
`);
  assert.deepEqual(grade(fixture), untouchedReward);
});

test("trusted snapshot restores submitted production after classifier rewrite attempts", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  const added = path.join(fixture.app, "src", "tenant-isolation.test.mjs");
  writeFileSync(added, `${readFileSync(added, "utf8")}\nimport { chmodSync, writeFileSync } from "node:fs";\ntest("classifier rewrite attempt", () => {\n  if (!process.env.HARBOR_CLASSIFIER_RUN) return;\n  const target = new URL("./capability-service.mjs", import.meta.url);\n  try { chmodSync(target, 0o644); writeFileSync(target, "export class CapabilityService {}"); } catch {}\n});\n`);
  assert.deepEqual(grade(fixture), passingReward);
});

test("recursive application symlinks are rejected before candidate execution", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  symlinkSync("errors.mjs", path.join(fixture.app, "src", "candidate-link.mjs"));
  assert.deepEqual(grade(fixture), {
    functional: 0, regression: 0, tests_unchanged: 0, shippable: 0,
  });
});

test("guessed dedicated-fd classifier frames cannot spoof authenticated results", () => {
  const fixture = copyFixture();
  apply(fixture, "solution/solve.sh");
  const added = path.join(fixture.app, "src", "tenant-isolation.test.mjs");
  writeFileSync(added, `import { writeSync } from "node:fs";\ntry { writeSync(3, 'HARBOR_ASSERTION_guessed {"passed":99,"bodyAssertionFailures":0,"bodyOtherFailures":0,"bootstrapFailures":0}\\n'); } catch {}\n${readFileSync(added, "utf8")}`);
  assert.deepEqual(grade(fixture), passingReward);
});
