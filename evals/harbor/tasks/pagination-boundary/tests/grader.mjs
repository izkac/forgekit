import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const APP_DIR = process.env.HARBOR_APP_DIR || "/app";
const ORIGINAL_SOURCE_DIR = fileURLToPath(new URL("./original-src/", import.meta.url));
const TEST_FILE = `${APP_DIR}/src/server.test.mjs`;
const PACKAGE_FILE = `${APP_DIR}/package.json`;
const EXPECTED_PACKAGE_SHA256 = "87ab28760778241863154c3df21b21e4f686e2207d01651a4b278e2bae3e9726";
const REWARD_DIR = process.env.HARBOR_REWARD_DIR || "/logs/verifier";
const REWARD_FILE = process.env.HARBOR_REWARD_FILE || `${REWARD_DIR}/reward.json`;
const EXPECTED_VISIBLE_TEST_SHA256 = "5c4a297bea47ed4d4b6de065c2dcc2ee8448c496222e47987c835f33ca871123";

function configuredIdentity() {
  const uidText = process.env.HARBOR_UNTRUSTED_UID;
  const gidText = process.env.HARBOR_UNTRUSTED_GID;
  if (uidText === undefined && gidText === undefined) return {};
  if (!/^[0-9]+$/.test(uidText || "") || !/^[0-9]+$/.test(gidText || "")) {
    throw new Error("Invalid untrusted uid/gid configuration");
  }
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    throw new Error("The hidden verifier must remain root to drop application privileges");
  }
  return { uid: Number(uidText), gid: Number(gidText) };
}

function untrustedEnvironment(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: "/tmp",
    LANG: process.env.LANG || "C.UTF-8",
    ...extra
  };
}

function makeReadOnly(target) {
  const info = lstatSync(target);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const entry of readdirSync(target)) makeReadOnly(`${target}/${entry}`);
    chmodSync(target, 0o555);
  } else {
    chmodSync(target, 0o444);
  }
}

function makeOwnerWritable(target) {
  const info = lstatSync(target);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    chmodSync(target, 0o755);
    for (const entry of readdirSync(target)) makeOwnerWritable(`${target}/${entry}`);
  } else {
    chmodSync(target, 0o644);
  }
}

function lockVerifierBoundary() {
  configuredIdentity();
  mkdirSync(REWARD_DIR, { recursive: true });
  chmodSync(REWARD_DIR, 0o700);
  try { chmodSync("/tests", 0o700); } catch { /* local verifier run */ }
  makeReadOnly(APP_DIR);
}

function emptyReward() {
  return { functional: 0, regression: 0, tests_unchanged: 0, shippable: 0 };
}

function writeReward(reward) {
  mkdirSync(dirname(REWARD_FILE), { recursive: true });
  writeFileSync(REWARD_FILE, `${JSON.stringify(reward)}
`, "utf8");
}

function protectedFileMatches(file, expectedHash) {
  try {
    const info = lstatSync(file);
    return info.isFile()
      && !info.isSymbolicLink()
      && createHash("sha256").update(readFileSync(file)).digest("hex") === expectedHash;
  } catch {
    return false;
  }
}

function visibleTestIsUnchanged() {
  return protectedFileMatches(TEST_FILE, EXPECTED_VISIBLE_TEST_SHA256);
}

function packageContractIsUnchanged() {
  return protectedFileMatches(PACKAGE_FILE, EXPECTED_PACKAGE_SHA256);
}

function addedTestFiles() {
  try {
    return readdirSync(`${APP_DIR}/src`)
      .filter((name) => name.endsWith(".test.mjs") && name !== "server.test.mjs")
      .filter((name) => {
        const info = lstatSync(`${APP_DIR}/src/${name}`);
        return info.isFile() && !info.isSymbolicLink();
      });
  } catch {
    return [];
  }
}

function runAddedTests(testFiles) {
  const result = spawnSync(process.execPath, [
    "--test",
    ...testFiles.map((name) => `${APP_DIR}/src/${name}`)
  ], {
    cwd: APP_DIR,
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: untrustedEnvironment(),
    ...configuredIdentity()
  });
  return !result.error && result.status === 0;
}

function addedTestsAreMeaningful(testFiles) {
  if (testFiles.length === 0 || !runAddedTests(testFiles)) return false;

  const sourceDir = `${APP_DIR}/src`;
  const backupDir = `${APP_DIR}/.harbor-source-${randomUUID()}`;
  const originalNames = new Set(readdirSync(ORIGINAL_SOURCE_DIR));
  const retainedFiles = readdirSync(sourceDir).filter((name) => !originalNames.has(name));
  if (retainedFiles.some((name) => {
    const info = lstatSync(`${sourceDir}/${name}`);
    return !info.isFile() || info.isSymbolicLink();
  })) return false;

  const appMode = lstatSync(APP_DIR).mode & 0o777;
  const sourceMode = lstatSync(sourceDir).mode & 0o777;
  let sourceMoved = false;
  try {
    chmodSync(APP_DIR, 0o755);
    renameSync(sourceDir, backupDir);
    sourceMoved = true;
    chmodSync(backupDir, 0o700);
    cpSync(ORIGINAL_SOURCE_DIR, sourceDir, { recursive: true });
    for (const name of retainedFiles) {
      cpSync(`${backupDir}/${name}`, `${sourceDir}/${name}`);
    }
    makeReadOnly(sourceDir);
    chmodSync(APP_DIR, appMode);
    return !runAddedTests(testFiles);
  } finally {
    if (sourceMoved) {
      chmodSync(APP_DIR, 0o755);
      makeOwnerWritable(sourceDir);
      rmSync(sourceDir, { recursive: true, force: true });
      renameSync(backupDir, sourceDir);
      chmodSync(sourceDir, sourceMode);
    }
    chmodSync(APP_DIR, appMode);
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

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Could not determine a free verifier port"));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function startApp(port) {
  const child = spawn(process.execPath, ["src/server.mjs"], {
    cwd: APP_DIR,
    env: untrustedEnvironment({ PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
    ...configuredIdentity()
  });
  let spawnError = null;
  child.once("error", (error) => { spawnError = error; });
  return { child, get spawnError() { return spawnError; } };
}

async function waitForApp(app, port) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (app.spawnError || app.child.exitCode !== null) return false;
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
      return true;
    } catch {
      await delay(100);
    }
  }
  return false;
}

function stopApp(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        clearTimeout(killTimer);
        resolve();
      }
    };
    const killTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
      finish();
    }, 1_000);
    child.once("exit", finish);
    try { child.kill("SIGTERM"); } catch { finish(); }
  });
}

async function fetchText(url, options = {}) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(2_000) });
    return { response, body: await response.text() };
  } catch {
    return null;
  }
}

async function checkFunctional(baseURL) {
  const last = await fetchText(`${baseURL}/items?page=2`);
  const beyond = await fetchText(`${baseURL}/items?page=3`);
  if (!last || !beyond || last.response.status !== 200 || beyond.response.status !== 400) return false;
  try {
    const payload = JSON.parse(last.body);
    const error = JSON.parse(beyond.body);
    return last.response.headers.get("content-type") === "application/json; charset=utf-8"
      && JSON.stringify(payload.items.map(({ id }) => id)) === "[4,5,6]"
      && payload.page === 2
      && payload.pageSize === 3
      && payload.totalPages === 2
      && payload.totalItems === 6
      && Object.keys(payload).length === 5
      && beyond.response.headers.get("content-type") === "application/json; charset=utf-8"
      && error.error === "page must identify an available positive page"
      && Object.keys(error).length === 1;
  } catch {
    return false;
  }
}

async function checkRegression(baseURL) {
  const root = await fetchText(`${baseURL}/`);
  const first = await fetchText(`${baseURL}/items?page=1`);
  const invalid = await fetchText(`${baseURL}/items?page=0`);
  const missing = await fetchText(`${baseURL}/missing`);
  if (!root || !first || !invalid || !missing) return false;
  try {
    const payload = JSON.parse(first.body);
    return root.response.status === 200
      && root.response.headers.get("content-type") === "text/plain; charset=utf-8"
      && root.body === "pagination-fixture\n"
      && first.response.status === 200
      && JSON.stringify(payload.items.map(({ id }) => id)) === "[1,2,3]"
      && payload.page === 1 && payload.pageSize === 3 && payload.totalItems === 6
      && invalid.response.status === 400
      && missing.response.status === 404
      && missing.body === "Not found\n";
  } catch {
    return false;
  }
}

async function grade() {
  lockVerifierBoundary();
  // This snapshot is deliberately taken before any agent-controlled test or app executes.
  const testsUnchanged = visibleTestIsUnchanged() && packageContractIsUnchanged() ? 1 : 0;
  const visibleSuitePassed = runVisibleSuite();
  const addedTest = addedTestsAreMeaningful(addedTestFiles());
  let functional = 0;
  let regression = 0;
  let app = null;

  try {
    const port = await getFreePort();
    app = startApp(port);
    if (await waitForApp(app, port)) {
      const baseURL = `http://127.0.0.1:${port}`;
      functional = addedTest && await checkFunctional(baseURL) ? 1 : 0;
      regression = visibleSuitePassed && await checkRegression(baseURL) ? 1 : 0;
    }
  } finally {
    if (app) await stopApp(app.child);
    makeOwnerWritable(APP_DIR);
  }

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
  try { writeReward(emptyReward()); } catch { /* test.sh supplies the fallback */ }
  console.error("Verifier infrastructure error:", error);
  process.exitCode = 1;
}
