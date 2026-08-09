import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, chownSync, cpSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = process.env.HARBOR_APP_DIR || "/app";
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REWARD_DIR = process.env.HARBOR_REWARD_DIR || "/logs/verifier";
const REWARD_FILE = process.env.HARBOR_REWARD_FILE || `${REWARD_DIR}/reward.json`;
const PACKAGE_FILE = `${APP_DIR}/package.json`;
const VISIBLE_TEST_FILE = `${APP_DIR}/src/confirmation-service.test.mjs`;
const SERVICE_FILE = `${APP_DIR}/src/confirmation-service.mjs`;
const EXPECTED_PACKAGE_SHA256 = "96957c9e859f8e911f12d3bc1db904e8e11005becf940f4091b1615f9e990638";
const EXPECTED_VISIBLE_SHA256 = "e4821b3fb2d184cbd2f024926c80f6a6f7cc252849244e75b9be17477c421f48";

function emptyReward() {
  return { functional: 0, regression: 0, tests_unchanged: 0, shippable: 0 };
}

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

function assertRegularTree(target) {
  const info = lstatSync(target);
  if (info.isSymbolicLink()) throw new Error("Application symlinks are forbidden");
  if (info.isDirectory()) {
    for (const entry of readdirSync(target)) assertRegularTree(join(target, entry));
    return;
  }
  if (!info.isFile()) throw new Error("Application entries must be regular files or directories");
}

function visit(target, modes, ownership = false) {
  const info = lstatSync(target);
  if (info.isSymbolicLink()) throw new Error("Refusing to normalize a symlink");
  if (ownership && typeof process.getuid === "function" && process.getuid() === 0) {
    chownSync(target, 0, 0);
  }
  if (info.isDirectory()) {
    chmodSync(target, modes.directory);
    for (const entry of readdirSync(target)) visit(join(target, entry), modes, ownership);
  } else if (info.isFile()) {
    chmodSync(target, modes.file);
  } else throw new Error("Unsupported application entry");
}

function makeOwnerWritable(target) {
  visit(target, { directory: 0o755, file: 0o644 });
}

function secureReadOnlyTree(target) {
  visit(target, { directory: 0o555, file: 0o444 }, true);
}

function lockVerifierBoundary() {
  mkdirSync(REWARD_DIR, { recursive: true });
  chmodSync(REWARD_DIR, 0o700);
  try { chmodSync("/tests", 0o700); } catch {
    // Host-side verification has no container /tests mount.
  }
  makeOwnerWritable(APP_DIR);
  secureReadOnlyTree(APP_DIR);
}

function takeTrustedSnapshot() {
  const directory = mkdtempSync(join(tmpdir(), "harbor-reservation-snapshot-"));
  chmodSync(directory, 0o700);
  const snapshot = join(directory, "app");
  cpSync(APP_DIR, snapshot, { recursive: true, verbatimSymlinks: true });
  secureReadOnlyTree(snapshot);
  return { directory, snapshot };
}

function restoreSnapshot(snapshot) {
  makeOwnerWritable(APP_DIR);
  for (const entry of readdirSync(APP_DIR)) rmSync(join(APP_DIR, entry), { recursive: true, force: true });
  for (const entry of readdirSync(snapshot)) {
    cpSync(join(snapshot, entry), join(APP_DIR, entry), { recursive: true, verbatimSymlinks: true });
  }
  assertRegularTree(APP_DIR);
  secureReadOnlyTree(APP_DIR);
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

function protectedContractMatches() {
  return protectedFileMatches(PACKAGE_FILE, EXPECTED_PACKAGE_SHA256)
    && protectedFileMatches(VISIBLE_TEST_FILE, EXPECTED_VISIBLE_SHA256);
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

function classifiedRunnerSource(testFiles, nonce) {
  return `const { writeSync } = require("node:fs");
const { run } = require("node:test");
const files = ${JSON.stringify(testFiles)};
const nonce = ${JSON.stringify(nonce)};
const safeWrite = writeSync.bind(null);
const safeStringify = JSON.stringify.bind(JSON);
const fileSet = new Set(files);
const hasFile = Set.prototype.has.bind(fileSet);
let passed = 0;
let bodyAssertionFailures = 0;
let bodyOtherFailures = 0;
let bootstrapFailures = 0;
function isAssertion(error) {
  for (let value = error; value && typeof value === "object"; value = value.cause) {
    if (value.code === "ERR_ASSERTION") return true;
  }
  return false;
}
function isRegisteredBody(event) {
  const data = event.data || {};
  return typeof data.file === "string"
    && typeof data.line === "number"
    && typeof data.name === "string"
    && !hasFile(data.name);
}
(async () => {
  const stream = run({ files, concurrency: false, isolation: "none" });
  for await (const event of stream) {
    if (event.type === "test:pass" && isRegisteredBody(event)) passed += 1;
    if (event.type === "test:fail") {
      if (!isRegisteredBody(event)) bootstrapFailures += 1;
      else if (isAssertion(event.data?.details?.error)) bodyAssertionFailures += 1;
      else bodyOtherFailures += 1;
    }
  }
  const result = { passed, bodyAssertionFailures, bodyOtherFailures, bootstrapFailures };
  safeWrite(3, "HARBOR_ASSERTION_" + nonce + " " + safeStringify(result) + "\\n");
})().catch(() => { process.exitCode = 1; });
`;
}

function emptyClassifiedResult() {
  return {
    completed: false,
    passed: 0,
    bodyAssertionFailures: 0,
    bodyOtherFailures: 0,
    bootstrapFailures: 0,
  };
}

function validClassifiedShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "bodyAssertionFailures,bodyOtherFailures,bootstrapFailures,passed") return false;
  return [
    value.passed,
    value.bodyAssertionFailures,
    value.bodyOtherFailures,
    value.bootstrapFailures,
  ]
    .every((item) => Number.isSafeInteger(item) && item >= 0);
}

function runClassifiedTests(testFiles) {
  if (testFiles.length === 0) return emptyClassifiedResult();
  const nonce = randomBytes(32).toString("hex");
  const prefix = `HARBOR_ASSERTION_${nonce} `;
  try {
    const result = spawnSync(process.execPath, [], {
      cwd: APP_DIR,
      encoding: "utf8",
      input: classifiedRunnerSource(testFiles, nonce),
      timeout: 30_000,
      stdio: ["pipe", "ignore", "ignore", "pipe"],
      env: untrustedEnvironment(),
      ...configuredIdentity()
    });
    if (result.error || result.status !== 0 || typeof result.output[3] !== "string") {
      return emptyClassifiedResult();
    }
    const authenticated = result.output[3].split("\n")
      .filter((line) => line.startsWith(prefix));
    if (authenticated.length !== 1) return emptyClassifiedResult();
    const value = JSON.parse(authenticated[0].slice(prefix.length));
    if (!validClassifiedShape(value)) return emptyClassifiedResult();
    return { completed: true, ...value };
  } catch {
    return emptyClassifiedResult();
  }
}

function addedTestsKillConcurrencyMutant(testFiles) {
  if (testFiles.length === 0) return false;
  const normal = runClassifiedTests(testFiles);
  if (!normal.completed || normal.passed < 1
      || normal.bodyAssertionFailures !== 0
      || normal.bodyOtherFailures !== 0
      || normal.bootstrapFailures !== 0) return false;

  const submittedService = readFileSync(SERVICE_FILE);
  try {
    chmodSync(SERVICE_FILE, 0o644);
    writeFileSync(SERVICE_FILE, readFileSync(`${TESTS_DIR}/mutants/confirmation-service.mjs`));
    chmodSync(SERVICE_FILE, 0o444);
    // Normal and mutant executions use the identical trusted runner protocol.
    // Only a registered test-body assertion may qualify the semantic kill.
    const mutated = runClassifiedTests(testFiles);
    return mutated.completed
      && mutated.bodyAssertionFailures > 0
      && mutated.bootstrapFailures === 0;
  } finally {
    chmodSync(SERVICE_FILE, 0o644);
    writeFileSync(SERVICE_FILE, submittedService);
    chmodSync(SERVICE_FILE, 0o444);
  }
}

function hiddenProbe() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`${TESTS_DIR}/hidden-probe.mjs`], {
      cwd: APP_DIR,
      env: {
        PATH: process.env.PATH,
        HOME: "/tmp",
        LANG: process.env.LANG || "C.UTF-8",
        HARBOR_APP_DIR: APP_DIR,
        ...(process.env.HARBOR_UNTRUSTED_UID === undefined ? {} : {
          HARBOR_UNTRUSTED_UID: process.env.HARBOR_UNTRUSTED_UID,
          HARBOR_UNTRUSTED_GID: process.env.HARBOR_UNTRUSTED_GID
        })
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.split("\n")
        .findLast((value) => value.startsWith("HARBOR_TRUSTED_RESERVATION "));
      if (code !== 0 || !line) return resolve(false);
      try { resolve(JSON.parse(line.slice("HARBOR_TRUSTED_RESERVATION ".length)).functional === true); }
      catch { resolve(false); }
    });
  });
}

function writeReward(reward) {
  mkdirSync(dirname(REWARD_FILE), { recursive: true });
  writeFileSync(REWARD_FILE, `${JSON.stringify(reward)}\n`, "utf8");
}

async function grade() {
  let snapshot;
  try {
    // Reject special entries and capture the submitted tree before any
    // candidate-controlled module or test can execute.
    assertRegularTree(APP_DIR);
    snapshot = takeTrustedSnapshot();
    lockVerifierBoundary();
    const initialProtected = protectedContractMatches();
    const regression = runVisibleSuite() ? 1 : 0;
    const meaningfulTest = addedTestsKillConcurrencyMutant(addedTestFiles());
    const postTestProtected = protectedContractMatches();
    let postTestTreeRegular = true;
    try { assertRegularTree(APP_DIR); } catch { postTestTreeRegular = false; }

    // Candidate tests ran in separate processes. Restore the byte-for-byte
    // submitted tree before the trusted hidden harness starts its worker.
    restoreSnapshot(snapshot.snapshot);
    const behavior = await hiddenProbe();
    const finalProtected = protectedContractMatches();
    assertRegularTree(APP_DIR);
    const testsUnchanged = initialProtected && postTestProtected
      && postTestTreeRegular && finalProtected ? 1 : 0;
    const functional = meaningfulTest && behavior ? 1 : 0;
    return {
      functional,
      regression,
      tests_unchanged: testsUnchanged,
      shippable: functional && regression && testsUnchanged ? 1 : 0
    };
  } catch {
    return emptyReward();
  } finally {
    if (snapshot) {
      makeOwnerWritable(snapshot.directory);
      rmSync(snapshot.directory, { recursive: true, force: true });
    }
    try { makeOwnerWritable(APP_DIR); } catch {
      // A malformed tree is already graded fail-closed.
    }
  }
}

try {
  writeReward(await grade());
} catch (error) {
  try { writeReward(emptyReward()); } catch {
    // There is no further recovery if the trusted reward location is unavailable.
  }
  console.error("Verifier infrastructure error:", error);
  process.exitCode = 1;
}
