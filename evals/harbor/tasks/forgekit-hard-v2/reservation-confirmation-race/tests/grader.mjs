import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync
} from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = process.env.HARBOR_APP_DIR || "/app";
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REWARD_DIR = process.env.HARBOR_REWARD_DIR || "/logs/verifier";
const REWARD_FILE = process.env.HARBOR_REWARD_FILE || `${REWARD_DIR}/reward.json`;
const PACKAGE_FILE = `${APP_DIR}/package.json`;
const VISIBLE_TEST_FILE = `${APP_DIR}/src/confirmation-service.test.mjs`;
const SERVICE_FILE = `${APP_DIR}/src/confirmation-service.mjs`;
const EXPECTED_PACKAGE_SHA256 = "96957c9e859f8e911f12d3bc1db904e8e11005becf940f4091b1615f9e990638";
const EXPECTED_VISIBLE_SHA256 = "2eebf61f946075075cdb1016793284bc55a38e8c87ecd584802035612e724fc0";

function configuredIdentity() {
  const uidText = process.env.HARBOR_UNTRUSTED_UID;
  const gidText = process.env.HARBOR_UNTRUSTED_GID;
  if (uidText === undefined && gidText === undefined) return {};
  if (!/^[0-9]+$/.test(uidText || "") || !/^[0-9]+$/.test(gidText || "")) {
    throw new Error("Invalid untrusted uid/gid configuration");
  }
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("Configured verifier privilege drop requires a root grader");
  }
  return { uid: Number(uidText), gid: Number(gidText) };
}

function untrustedEnvironment(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: "/tmp",
    LANG: process.env.LANG || "C.UTF-8",
    HARBOR_APP_DIR: APP_DIR,
    ...extra
  };
}

function visit(target, mode) {
  const info = lstatSync(target);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    chmodSync(target, mode.directory);
    for (const entry of readdirSync(target)) visit(`${target}/${entry}`, mode);
  } else {
    chmodSync(target, mode.file);
  }
}

function makeReadOnly(target) {
  visit(target, { directory: 0o555, file: 0o444 });
}

function makeOwnerWritable(target) {
  visit(target, { directory: 0o755, file: 0o644 });
}

function lockVerifierBoundary() {
  mkdirSync(REWARD_DIR, { recursive: true });
  chmodSync(REWARD_DIR, 0o700);
  try { chmodSync("/tests", 0o700); } catch {
    // Host-side qualification uses the checked-out task directory.
  }
  makeReadOnly(APP_DIR);
}

function protectedFileMatches(file, hash) {
  try {
    const info = lstatSync(file);
    return info.isFile() && !info.isSymbolicLink()
      && createHash("sha256").update(readFileSync(file)).digest("hex") === hash;
  } catch {
    return false;
  }
}

function addedTestFiles() {
  try {
    return readdirSync(`${APP_DIR}/src`)
      .filter((name) => name.endsWith(".test.mjs") && name !== "confirmation-service.test.mjs")
      .filter((name) => {
        const info = lstatSync(`${APP_DIR}/src/${name}`);
        return info.isFile() && !info.isSymbolicLink();
      })
      .map((name) => `${APP_DIR}/src/${name}`);
  } catch {
    return [];
  }
}

function runVisibleSuite() {
  const result = spawnSync("npm", ["test"], {
    cwd: APP_DIR,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: untrustedEnvironment(),
    ...configuredIdentity()
  });
  return !result.error && result.status === 0;
}

const ASSERTION_RUNNER = `import { run } from "node:test";
const files = JSON.parse(process.env.HARBOR_TEST_FILES);
const stream = run({ files, concurrency: false, isolation: "none" });
let passed = 0;
let assertionFailures = 0;
let otherFailures = 0;
function isAssertion(error) {
  for (let value = error; value && typeof value === "object"; value = value.cause) {
    if (value.code === "ERR_ASSERTION") return true;
  }
  return false;
}
for await (const event of stream) {
  if (event.type === "test:pass") passed += 1;
  if (event.type === "test:fail") {
    if (isAssertion(event.data?.details?.error)) assertionFailures += 1;
    else otherFailures += 1;
  }
}
console.log("HARBOR_ASSERTION_RESULT " + JSON.stringify({ passed, assertionFailures, otherFailures }));
`;

function runClassifiedTests(testFiles) {
  if (testFiles.length === 0) return { completed: true, passed: 0, assertionFailures: 0, otherFailures: 0 };
  const runner = `/tmp/harbor-assertion-runner-${randomUUID()}.mjs`;
  writeFileSync(runner, ASSERTION_RUNNER, { mode: 0o444 });
  try {
    const result = spawnSync(process.execPath, [runner], {
      cwd: APP_DIR,
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: untrustedEnvironment({ HARBOR_TEST_FILES: JSON.stringify(testFiles) }),
      ...configuredIdentity()
    });
    if (result.error || result.status !== 0) return { completed: false, passed: 0, assertionFailures: 0, otherFailures: 0 };
    const line = result.stdout.split("\n").findLast((value) => value.startsWith("HARBOR_ASSERTION_RESULT "));
    if (!line) return { completed: false, passed: 0, assertionFailures: 0, otherFailures: 0 };
    return { completed: true, ...JSON.parse(line.slice("HARBOR_ASSERTION_RESULT ".length)) };
  } catch {
    return { completed: false, passed: 0, assertionFailures: 0, otherFailures: 0 };
  } finally {
    rmSync(runner, { force: true });
  }
}

function addedTestsKillConcurrencyMutant(testFiles) {
  if (testFiles.length === 0) return false;
  const normal = runClassifiedTests(testFiles);
  if (!normal.completed || normal.passed < 1 || normal.assertionFailures !== 0 || normal.otherFailures !== 0) {
    return false;
  }

  const submittedService = readFileSync(SERVICE_FILE);
  try {
    chmodSync(SERVICE_FILE, 0o644);
    writeFileSync(SERVICE_FILE, readFileSync(`${TESTS_DIR}/mutants/confirmation-service.mjs`));
    chmodSync(SERVICE_FILE, 0o444);
    const mutated = runClassifiedTests(testFiles);
    return mutated.completed
      && mutated.assertionFailures > 0
      && mutated.otherFailures === 0;
  } finally {
    chmodSync(SERVICE_FILE, 0o644);
    writeFileSync(SERVICE_FILE, submittedService);
    chmodSync(SERVICE_FILE, 0o444);
  }
}

function hiddenProbe() {
  const source = readFileSync(`${TESTS_DIR}/hidden-probe.mjs`, "utf8");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module"], {
      cwd: APP_DIR,
      env: untrustedEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      ...configuredIdentity()
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.split("\n").findLast((value) => value.startsWith("HARBOR_RESERVATION_PROBE "));
      if (code !== 0 || !line) return resolve(false);
      try { resolve(JSON.parse(line.slice("HARBOR_RESERVATION_PROBE ".length)).functional === true); }
      catch { resolve(false); }
    });
    child.stdin.end(source);
  });
}

function writeReward(reward) {
  mkdirSync(dirname(REWARD_FILE), { recursive: true });
  writeFileSync(REWARD_FILE, `${JSON.stringify(reward)}
`, "utf8");
}

async function grade() {
  lockVerifierBoundary();
  const testsUnchanged = protectedFileMatches(PACKAGE_FILE, EXPECTED_PACKAGE_SHA256)
    && protectedFileMatches(VISIBLE_TEST_FILE, EXPECTED_VISIBLE_SHA256) ? 1 : 0;
  const regression = runVisibleSuite() ? 1 : 0;
  const testFiles = addedTestFiles();
  const meaningfulTest = addedTestsKillConcurrencyMutant(testFiles);
  const behavior = await hiddenProbe();
  makeOwnerWritable(APP_DIR);
  const functional = meaningfulTest && behavior ? 1 : 0;
  return {
    functional,
    regression,
    tests_unchanged: testsUnchanged,
    shippable: functional && regression && testsUnchanged ? 1 : 0
  };
}

try {
  writeReward(await grade());
} catch (error) {
  try { makeOwnerWritable(APP_DIR); } catch {
    // Best effort after verifier infrastructure failure.
  }
  try { writeReward({ functional: 0, regression: 0, tests_unchanged: 0, shippable: 0 }); } catch {
    // The outer stderr and non-zero exit remain the fail-closed signal.
  }
  console.error("Verifier infrastructure error:", error);
  process.exitCode = 1;
}
