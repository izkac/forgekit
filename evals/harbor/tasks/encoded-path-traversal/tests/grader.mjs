import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer as createTcpServer } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const APP_DIR = process.env.HARBOR_APP_DIR || "/app";
const ORIGINAL_SOURCE_DIR = fileURLToPath(new URL("./original-src/", import.meta.url));
const TEST_FILE = `${APP_DIR}/src/server.test.mjs`;
const PACKAGE_FILE = `${APP_DIR}/package.json`;
const EXPECTED_PACKAGE_SHA256 = "47f0f53ad94b8c1c992b5bfa102fd4ae5189c934d5a10856f14663546d323612";
const SECRET_FILE = `${APP_DIR}/secret.txt`;
const REWARD_DIR = process.env.HARBOR_REWARD_DIR || "/logs/verifier";
const REWARD_FILE = process.env.HARBOR_REWARD_FILE || `${REWARD_DIR}/reward.json`;
const EXPECTED_VISIBLE_TEST_SHA256 = "0bf1639b4c3493baf8f670d70dfcbf3b9a81367a462865ac17ae3c8e98772c1c";
const EXPECTED_SECRET_SHA256 = "3e9bab45c3fd926851ddff8dbb6305765ab7671571c7d8d18373f1a0c2d63461";

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
  mkdirSync(REWARD_DIR, { recursive: true });
  chmodSync(REWARD_DIR, 0o700);
  try {
    chmodSync("/tests", 0o700);
  } catch {
    // Local fixture verification has no container-mounted /tests directory.
  }
  makeReadOnly(APP_DIR);
}

function emptyReward() {
  return { functional: 0, regression: 0, tests_unchanged: 0, shippable: 0 };
}

function writeReward(reward) {
  mkdirSync(dirname(REWARD_FILE), { recursive: true });
  writeFileSync(REWARD_FILE, `${JSON.stringify(reward)}\n`, "utf8");
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
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

function secretIsProtected() {
  try {
    return lstatSync(SECRET_FILE).isFile() && sha256File(SECRET_FILE) === EXPECTED_SECRET_SHA256;
  } catch {
    return false;
  }
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
      await fetch(`http://127.0.0.1:${port}/index.txt`, { signal: AbortSignal.timeout(500) });
      return true;
    } catch {
      await delay(100);
    }
  }
  return false;
}

function stopApp(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    let finished = false;
    let killTimer;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      resolve();
    };
    killTimer = setTimeout(() => {
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
    return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
  } catch {
    return null;
  }
}

function rawGet(port, target) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(2_000, () => finish(null));
    socket.on("error", () => finish(null));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      const message = Buffer.concat(chunks).toString("utf8");
      const boundary = message.indexOf("\r\n\r\n");
      const head = boundary >= 0 ? message.slice(0, boundary) : message;
      let body = boundary >= 0 ? message.slice(boundary + 4) : "";
      if (/^transfer-encoding:\s*chunked\s*$/im.test(head)) {
        let decoded = "";
        let remaining = body;
        while (remaining.length > 0) {
          const lineEnd = remaining.indexOf("\r\n");
          if (lineEnd < 0) break;
          const size = Number.parseInt(remaining.slice(0, lineEnd), 16);
          if (!Number.isFinite(size) || size === 0) break;
          const start = lineEnd + 2;
          decoded += remaining.slice(start, start + size);
          remaining = remaining.slice(start + size + 2);
        }
        body = decoded;
      }
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1]);
      const contentType = /^content-type:\s*(.+)$/im.exec(head)?.[1]?.trim() || null;
      finish({ status, contentType, body });
    });
    socket.on("connect", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
  });
}

function isMissing(result) {
  return Boolean(result
    && result.status === 404
    && result.contentType === "text/plain; charset=utf-8"
    && result.body === "Not found\n"
    && !result.body.includes("protected-verifier-secret"));
}

async function checkTraversal(port) {
  const attempts = [
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/%252e%252e%252fsecret.txt",
    "/%2fapp%2fsecret.txt",
    "/..%5csecret.txt"
  ];
  const results = await Promise.all(attempts.map((target) => rawGet(port, target)));
  return results.every(isMissing);
}

async function checkLegitimateFiles(baseURL) {
  const expectations = [
    ["/index.txt", "public index\n"],
    ["/quarterly%20report.txt", "quarterly public report\n"],
    ["/100%25%20real.txt", "percent public file\n"],
    ["/assets/readme.txt", "nested public asset\n"]
  ];
  const results = await Promise.all(expectations.map(async ([pathname, body]) => {
    const result = await fetchText(`${baseURL}${pathname}`);
    return Boolean(result
      && result.status === 200
      && result.contentType === "text/plain; charset=utf-8"
      && result.body === body);
  }));
  return results.every(Boolean);
}

async function checkMissingBehavior(baseURL) {
  const missing = await fetchText(`${baseURL}/missing.txt`);
  const post = await fetchText(`${baseURL}/index.txt`, { method: "POST" });
  return isMissing(missing) && isMissing(post);
}

async function grade() {
  lockVerifierBoundary();
  // Capture the immutable visible-test verdict before any agent-controlled test
  // module or application process can execute.
  const testsUnchanged = visibleTestIsUnchanged() && packageContractIsUnchanged() ? 1 : 0;
  const secretBefore = secretIsProtected();
  const visibleSuitePassed = runVisibleSuite();
  const addedSecurityTest = addedTestsAreMeaningful(addedTestFiles());
  let functional = 0;
  let regression = 0;
  let app = null;

  try {
    const port = await getFreePort();
    app = startApp(port);
    if (await waitForApp(app, port)) {
      const baseURL = `http://127.0.0.1:${port}`;
      const traversalBlocked = await checkTraversal(port);
      const legitimateFilesWork = await checkLegitimateFiles(baseURL);
      const missingBehaviorWorks = await checkMissingBehavior(baseURL);
      functional = addedSecurityTest && secretBefore && traversalBlocked && secretIsProtected() ? 1 : 0;
      regression = visibleSuitePassed && legitimateFilesWork && missingBehaviorWorks ? 1 : 0;
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

const main = async () => {
  try {
    writeReward(await grade());
    return 0;
  } catch (error) {
    try { writeReward(emptyReward()); } catch (writeError) {
      console.error("Failed to write verifier reward:", writeError);
    }
    console.error("Verifier infrastructure error:", error);
    return 1;
  }
};

process.exitCode = await main();
