import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const APP_DIR = process.env.HARBOR_APP_DIR || "/app";
const TEST_FILE = `${APP_DIR}/src/server.test.mjs`;
const PACKAGE_FILE = `${APP_DIR}/package.json`;
const EXPECTED_PACKAGE_SHA256 = "bef81188230deeb88a62cbac2e73ea00140a53d3286cb5f4aa5a45aa41f6c136";
const REWARD_DIR = process.env.HARBOR_REWARD_DIR || "/logs/verifier";
const REWARD_FILE = process.env.HARBOR_REWARD_FILE || `${REWARD_DIR}/reward.json`;
const EXPECTED_VISIBLE_TEST_SHA256 = "af40190a9f5a3732a10fdb40a7d0f65216a8db83fcdcdfdd86cb44f5aed94cb3";

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

function visibleTestIsUnchanged() {
  try {
    const source = readFileSync(TEST_FILE);
    return createHash("sha256").update(source).digest("hex") === EXPECTED_VISIBLE_TEST_SHA256;
  } catch {
    return false;
  }
}

function packageContractIsUnchanged() {
  try {
    return createHash("sha256").update(readFileSync(PACKAGE_FILE)).digest("hex") === EXPECTED_PACKAGE_SHA256;
  } catch {
    return false;
  }
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
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

function hasAddedTest() {
  try {
    return readdirSync(`${APP_DIR}/src`)
      .filter((name) => name.endsWith(".test.mjs") && name !== "server.test.mjs")
      .some((name) => addedTestSourceLooksRelevant(readFileSync(`${APP_DIR}/src/${name}`, "utf8")));
  } catch {
    return false;
  }
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

function addedTestSourceLooksRelevant(source) {
  source = stripComments(source);
  return source.includes("/export.csv")
    && ["=", "+", "-", "@"].every((marker) => source.includes(marker))
    && /\b(?:assert|test)\b/.test(source);
}

const SAFE_CSV = [
  "name,email,note",
  "Ada,ada@example.test,\"Quarterly, reviewer\"",
  "Equals,equals@example.test,'=2+3",
  "Plus,plus@example.test,\"'+SUM(1,1)\"",
  "Minus,minus@example.test,'-10+20",
  "At,at@example.test,'@SUM(1:2)",
  "Safe,safe@example.test,reference=2+3",
  ""
].join("\n");

async function checkFunctional(baseURL) {
  const result = await fetchText(`${baseURL}/export.csv`);
  return Boolean(result
    && result.response.status === 200
    && result.response.headers.get("content-type") === "text/csv; charset=utf-8"
    && result.body === SAFE_CSV);
}

async function checkRegression(baseURL) {
  const result = await fetchText(`${baseURL}/export.csv`);
  const missing = await fetchText(`${baseURL}/missing`);
  return Boolean(result
    && result.response.status === 200
    && result.response.headers.get("content-type") === "text/csv; charset=utf-8"
    && result.body.startsWith("name,email,note\nAda,ada@example.test,\"Quarterly, reviewer\"\n")
    && result.body.endsWith("Safe,safe@example.test,reference=2+3\n")
    && missing
    && missing.response.status === 404
    && missing.response.headers.get("content-type") === "text/plain; charset=utf-8"
    && missing.body === "Not found\n");
}

async function grade() {
  lockVerifierBoundary();
  // This snapshot is deliberately taken before any agent-controlled test or app executes.
  const testsUnchanged = visibleTestIsUnchanged() && packageContractIsUnchanged() ? 1 : 0;
  const visibleSuitePassed = runVisibleSuite();
  const addedTest = hasAddedTest();
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
