import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync, chownSync, cpSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_DIR = process.env.HARBOR_APP_DIR || "/app";
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REWARD_DIR = process.env.HARBOR_REWARD_DIR || "/logs/verifier";
const REWARD_FILE = process.env.HARBOR_REWARD_FILE || `${REWARD_DIR}/reward.json`;
const SERVICE_FILE = `${APP_DIR}/src/capability-service.mjs`;
const PROTECTED_FILES = new Map([
  [`${APP_DIR}/package.json`, "1a76f5c0976a74266c195e0cbad84d819e85633115ab748ee351d1357ef84884"],
  [`${APP_DIR}/src/capability-service.test.mjs`, "356dec8e6d2dd41d100a0937a9e75dd5c9b51a87e3bcac55d3d3d4f249611476"],
  [`${APP_DIR}/src/document-store.test.mjs`, "0653ef3ed48c18b59ac8b8341c254f13e481b0e4550227cd33f04870ac152cf6"],
  [`${APP_DIR}/src/http-app.test.mjs`, "b49a2418feabbb5380c5e5fc473ed766dc7db4dc5352963cdb591c86ad4a2444"],
]);
const VISIBLE_TEST_NAMES = new Set([
  "capability-service.test.mjs", "document-store.test.mjs", "http-app.test.mjs",
]);

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
  return { PATH: process.env.PATH, HOME: "/tmp", LANG: process.env.LANG || "C.UTF-8", HARBOR_APP_DIR: APP_DIR, ...extra };
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
  if (ownership && typeof process.getuid === "function" && process.getuid() === 0) chownSync(target, 0, 0);
  if (info.isDirectory()) {
    chmodSync(target, modes.directory);
    for (const entry of readdirSync(target)) visit(join(target, entry), modes, ownership);
  } else if (info.isFile()) chmodSync(target, modes.file);
  else throw new Error("Unsupported application entry");
}

function makeOwnerWritable(target) { visit(target, { directory: 0o755, file: 0o644 }); }
function secureReadOnlyTree(target) { visit(target, { directory: 0o555, file: 0o444 }, true); }

function lockVerifierBoundary() {
  mkdirSync(REWARD_DIR, { recursive: true });
  chmodSync(REWARD_DIR, 0o700);
  try { chmodSync("/tests", 0o700); } catch {}
  makeOwnerWritable(APP_DIR);
  secureReadOnlyTree(APP_DIR);
}

function takeTrustedSnapshot() {
  const directory = mkdtempSync(join(tmpdir(), "harbor-signed-downloads-snapshot-"));
  chmodSync(directory, 0o700);
  const snapshot = join(directory, "app");
  cpSync(APP_DIR, snapshot, { recursive: true, verbatimSymlinks: true });
  secureReadOnlyTree(snapshot);
  return { directory, snapshot };
}

function restoreSnapshot(snapshot) {
  makeOwnerWritable(APP_DIR);
  for (const entry of readdirSync(APP_DIR)) rmSync(join(APP_DIR, entry), { recursive: true, force: true });
  for (const entry of readdirSync(snapshot)) cpSync(join(snapshot, entry), join(APP_DIR, entry), { recursive: true, verbatimSymlinks: true });
  assertRegularTree(APP_DIR);
  secureReadOnlyTree(APP_DIR);
}

function protectedContractMatches() {
  for (const [file, hash] of PROTECTED_FILES) {
    try {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink()) return false;
      if (createHash("sha256").update(readFileSync(file)).digest("hex") !== hash) return false;
    } catch { return false; }
  }
  return true;
}

function addedTestFiles() {
  try {
    return readdirSync(`${APP_DIR}/src`)
      .filter((name) => name.endsWith(".test.mjs") && !VISIBLE_TEST_NAMES.has(name))
      .filter((name) => { const info = lstatSync(`${APP_DIR}/src/${name}`); return info.isFile() && !info.isSymbolicLink(); })
      .map((name) => `${APP_DIR}/src/${name}`);
  } catch { return []; }
}

function runVisibleSuite() {
  const result = spawnSync("npm", ["test"], {
    cwd: APP_DIR, encoding: "utf8", timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"], env: untrustedEnvironment(), ...configuredIdentity(),
  });
  return !result.error && result.status === 0;
}

function assertionLoaderSource(markerKey, runnerParent) {
  const stateSpecifier = `node:harbor-state-${markerKey}`;
  const stateSource = [
    "import { AssertionError } from \"node:assert?harbor-real\";",
    "const markedErrors = new WeakSet();",
    "export function markAssertion(error) {",
    "  if (error instanceof AssertionError) markedErrors.add(error);",
    "}",
    "const failures = new Map();",
    "export function recordFailure(name, error) { if (markedErrors.has(error)) failures.set(name, (failures.get(name) || 0) + 1); }",
    "export function consumeFailure(name) { const count = failures.get(name) || 0; if (count <= 1) failures.delete(name); else failures.set(name, count - 1); return count > 0; }",
  ].join("\n");
  const assertSource = (actualSpecifier) => [
    `import * as actualNamespace from ${JSON.stringify(actualSpecifier)};`,
    `import { markAssertion } from ${JSON.stringify(stateSpecifier)};`,
    "const actual = actualNamespace.default;",
    "const wrappedFunctions = new WeakMap();",
    "function wrap(value) {",
    "  if (typeof value !== \"function\") return value;",
    "  if (wrappedFunctions.has(value)) return wrappedFunctions.get(value);",
    "  const wrapped = function (...args) {",
    "    try {",
    "      const result = Reflect.apply(value, this, args);",
    "      if (result && typeof result.then === \"function\") return result.catch((error) => { markAssertion(error); throw error; });",
    "      return result;",
    "    } catch (error) { markAssertion(error); throw error; }",
    "  };",
    "  wrappedFunctions.set(value, wrapped);",
    "  return wrapped;",
    "}",
    "const wrapped = new Proxy(actual, {",
    "  apply(target, thisArg, args) { try { return Reflect.apply(target, thisArg, args); } catch (error) { markAssertion(error); throw error; } },",
    "  get(target, property, receiver) { return wrap(Reflect.get(target, property, receiver)); },",
    "});",
    "export default wrapped;",
    "export const AssertionError = actualNamespace.AssertionError;",
    "export const deepEqual = wrapped.deepEqual;",
    "export const deepStrictEqual = wrapped.deepStrictEqual;",
    "export const doesNotMatch = wrapped.doesNotMatch;",
    "export const doesNotReject = wrapped.doesNotReject;",
    "export const doesNotThrow = wrapped.doesNotThrow;",
    "export const equal = wrapped.equal;",
    "export const fail = wrapped.fail;",
    "export const ifError = wrapped.ifError;",
    "export const match = wrapped.match;",
    "export const notDeepEqual = wrapped.notDeepEqual;",
    "export const notDeepStrictEqual = wrapped.notDeepStrictEqual;",
    "export const notEqual = wrapped.notEqual;",
    "export const notStrictEqual = wrapped.notStrictEqual;",
    "export const ok = wrapped.ok;",
    "export const rejects = wrapped.rejects;",
    "export const strict = wrapped.strict;",
    "export const strictEqual = wrapped.strictEqual;",
    "export const throws = wrapped.throws;",
  ].join("\n");
  const testSource = [
    `import * as actualNamespace from "node:test?harbor-real";`,
    `import { recordFailure } from ${JSON.stringify(stateSpecifier)};`,
    "const actual = actualNamespace.default;",
    "function wrapTest(callback, name) {",
    "  return (...args) => {",
    "    try {",
    "      const result = callback(...args);",
    "      if (result && typeof result.then === \"function\") return result.catch((error) => { recordFailure(name, error); throw error; });",
    "      return result;",
    "    } catch (error) { recordFailure(name, error); throw error; }",
    "  };",
    "}",
    "const wrapped = new Proxy(actual, {",
    "  apply(target, thisArg, args) {",
    "    const callback = args.findLast((value) => typeof value === \"function\");",
    "    if (!callback) return Reflect.apply(target, thisArg, args);",
    "    const name = typeof args[0] === \"string\" ? args[0] : callback.name || \"anonymous\";",
    "    const replaced = [...args];",
    "    replaced[replaced.lastIndexOf(callback)] = wrapTest(callback, name);",
    "    return Reflect.apply(target, thisArg, replaced);",
    "  },",
    "  get(target, property, receiver) { return Reflect.get(target, property, receiver); },",
    "});",
    "export default wrapped;",
    "export const test = wrapped;",
  ].join("\n");
  const normalAssertSource = JSON.stringify(assertSource("node:assert?harbor-real"));
  const strictAssertSource = JSON.stringify(assertSource("node:assert/strict?harbor-real"));
  const normalAssertUrl = `data:text/javascript,${encodeURIComponent(assertSource("node:assert?harbor-real"))}`;
  const strictAssertUrl = `data:text/javascript,${encodeURIComponent(assertSource("node:assert/strict?harbor-real"))}`;
  const testUrl = `data:text/javascript,${encodeURIComponent(testSource)}`;
  return [
    "export async function resolve(specifier, context, nextResolve) {",
    `    const trustedParents = new Set([${JSON.stringify(normalAssertUrl)}, ${JSON.stringify(strictAssertUrl)}, ${JSON.stringify(testUrl)}, ${JSON.stringify(runnerParent)}, ${JSON.stringify(runnerParent.replace("%5Bstdin%5D", "[stdin]"))}]);`,
    `  if (specifier === ${JSON.stringify(stateSpecifier)}) {`,
    "    if (context.parentURL !== undefined && !trustedParents.has(context.parentURL)) throw new Error(\"untrusted state import\");",
    `    return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(stateSource)}), shortCircuit: true };`,
    "  }",
    "  if (specifier === \"node:assert\" || specifier === \"node:assert/strict\") {",
    `    const source = specifier === "node:assert/strict" ? ${strictAssertSource} : ${normalAssertSource};`,
    "    return { url: \"data:text/javascript,\" + encodeURIComponent(source), shortCircuit: true };",
    "  }",
    "  if (specifier === \"node:test\") {",
    `    const source = ${JSON.stringify(testSource)};`,
    "    return { url: \"data:text/javascript,\" + encodeURIComponent(source), shortCircuit: true };",
    "  }",
    "  if (specifier.endsWith(\"?harbor-real\")) return nextResolve(specifier.slice(0, -12), context, nextResolve);",
    "  return nextResolve(specifier, context, nextResolve);",
    "}",
  ].join("\n");
}

function classifiedRunnerSource(testFiles, nonce) {
  const stateSpecifier = `node:harbor-state-HARBOR_ASSERTION_MARKER_${nonce}`;
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
function isRegisteredBody(event) {
  const data = event.data || {};
  return typeof data.file === "string" && typeof data.line === "number" && typeof data.name === "string" && !hasFile(data.name);
}
(async () => {
  const { consumeFailure } = await import(${JSON.stringify(stateSpecifier)});
  const stream = run({ files, concurrency: false, isolation: "none" });
  for await (const event of stream) {
    if (event.type === "test:pass" && isRegisteredBody(event)) passed += 1;
    if (event.type === "test:fail") {
      const data = event.data || {};
      if (!isRegisteredBody(event)) bootstrapFailures += 1;
      else if (consumeFailure(data.name)) bodyAssertionFailures += 1;
      else bodyOtherFailures += 1;
    }
  }
  safeWrite(3, "HARBOR_ASSERTION_" + nonce + " " + safeStringify({ passed, bodyAssertionFailures, bodyOtherFailures, bootstrapFailures }) + "\\n");
})().catch(() => { process.exitCode = 1; });
`;
}

function emptyClassifiedResult() {
  return { completed: false, passed: 0, bodyAssertionFailures: 0, bodyOtherFailures: 0, bootstrapFailures: 0 };
}

function validClassifiedShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== "bodyAssertionFailures,bodyOtherFailures,bootstrapFailures,passed") return false;
  return [value.passed, value.bodyAssertionFailures, value.bodyOtherFailures, value.bootstrapFailures]
    .every((item) => Number.isSafeInteger(item) && item >= 0);
}

function runClassifiedTests(testFiles) {
  if (testFiles.length === 0) return emptyClassifiedResult();
  const nonce = randomBytes(32).toString("hex");
  const prefix = `HARBOR_ASSERTION_${nonce} `;
  const runnerParent = pathToFileURL(join(APP_DIR, "[stdin]")).href;
  const markerKey = `HARBOR_ASSERTION_MARKER_${nonce}`;
  try {
    const result = spawnSync(process.execPath, ["--loader", `data:text/javascript,${encodeURIComponent(assertionLoaderSource(markerKey, runnerParent))}`], {
      cwd: APP_DIR, encoding: "utf8", input: classifiedRunnerSource(testFiles, nonce), timeout: 30_000,
      stdio: ["pipe", "ignore", "ignore", "pipe"],
      env: untrustedEnvironment({ HARBOR_CLASSIFIER_RUN: "1" }), ...configuredIdentity(),
    });
    if (result.error || result.status !== 0 || typeof result.output[3] !== "string") return emptyClassifiedResult();
    const authenticated = result.output[3].split("\n").filter((line) => line.startsWith(prefix));
    if (authenticated.length !== 1) return emptyClassifiedResult();
    const value = JSON.parse(authenticated[0].slice(prefix.length));
    return validClassifiedShape(value) ? { completed: true, ...value } : emptyClassifiedResult();
  } catch { return emptyClassifiedResult(); }
}

function addedTestsKillTenantMutant(testFiles) {
  if (testFiles.length === 0) return false;
  const submittedService = readFileSync(SERVICE_FILE);
  try {
    const normal = runClassifiedTests(testFiles);
    chmodSync(SERVICE_FILE, 0o644);
    writeFileSync(SERVICE_FILE, submittedService);
    chmodSync(SERVICE_FILE, 0o444);
    if (!normal.completed || normal.passed < 1 || normal.bodyAssertionFailures !== 0
        || normal.bodyOtherFailures !== 0 || normal.bootstrapFailures !== 0) return false;
    chmodSync(SERVICE_FILE, 0o644);
    writeFileSync(SERVICE_FILE, readFileSync(`${TESTS_DIR}/mutants/capability-service.mjs`));
    chmodSync(SERVICE_FILE, 0o444);
    const mutated = runClassifiedTests(testFiles);
    return mutated.completed && mutated.bodyAssertionFailures > 0 && mutated.bootstrapFailures === 0;
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
        PATH: process.env.PATH, HOME: "/tmp", LANG: process.env.LANG || "C.UTF-8", HARBOR_APP_DIR: APP_DIR,
        ...(process.env.HARBOR_UNTRUSTED_UID === undefined ? {} : {
          HARBOR_UNTRUSTED_UID: process.env.HARBOR_UNTRUSTED_UID,
          HARBOR_UNTRUSTED_GID: process.env.HARBOR_UNTRUSTED_GID,
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", () => { clearTimeout(timer); resolve(false); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.split("\n").findLast((value) => value.startsWith("HARBOR_TRUSTED_SIGNED_DOWNLOADS "));
      if (code !== 0 || !line) return resolve(false);
      try { resolve(JSON.parse(line.slice("HARBOR_TRUSTED_SIGNED_DOWNLOADS ".length)).functional === true); }
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
    assertRegularTree(APP_DIR);
    snapshot = takeTrustedSnapshot();
    lockVerifierBoundary();
    const initialProtected = protectedContractMatches();
    const regression = runVisibleSuite() ? 1 : 0;
    const postRegressionProtected = protectedContractMatches();
    let postRegressionTreeRegular = true;
    try { assertRegularTree(APP_DIR); } catch { postRegressionTreeRegular = false; }

    restoreSnapshot(snapshot.snapshot);
    const meaningfulTest = addedTestsKillTenantMutant(addedTestFiles());
    const postClassifierProtected = protectedContractMatches();
    let postClassifierTreeRegular = true;
    try { assertRegularTree(APP_DIR); } catch { postClassifierTreeRegular = false; }

    restoreSnapshot(snapshot.snapshot);
    const behavior = await hiddenProbe();
    const finalProtected = protectedContractMatches();
    assertRegularTree(APP_DIR);
    const testsUnchanged = initialProtected && postRegressionProtected && postRegressionTreeRegular
      && postClassifierProtected && postClassifierTreeRegular && finalProtected ? 1 : 0;
    const functional = meaningfulTest && behavior ? 1 : 0;
    return { functional, regression, tests_unchanged: testsUnchanged, shippable: functional && regression && testsUnchanged ? 1 : 0 };
  } catch { return emptyReward(); }
  finally {
    if (snapshot) {
      makeOwnerWritable(snapshot.directory);
      rmSync(snapshot.directory, { recursive: true, force: true });
    }
    try { makeOwnerWritable(APP_DIR); } catch {}
  }
}

try { writeReward(await grade()); }
catch (error) {
  try { writeReward(emptyReward()); } catch {}
  console.error("Verifier infrastructure error:", error);
  process.exitCode = 1;
}
