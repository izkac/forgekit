import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const APP_DIR = process.env.HARBOR_APP_DIR || "/app";
const TEST_FILE = `${APP_DIR}/src/server.test.mjs`;
const REWARD_DIR = process.env.HARBOR_REWARD_DIR || "/logs/verifier";
const REWARD_FILE = process.env.HARBOR_REWARD_FILE || `${REWARD_DIR}/reward.json`;
const EXPECTED_VISIBLE_TEST_SHA256 = "aab7b43d330f14760f3daedfa8ada13431d0069fbaf8b4cefbd0c34014b6ece8";

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
  return { PATH: process.env.PATH, HOME: "/tmp", LANG: process.env.LANG || "C.UTF-8", ...extra };
}

function makeReadOnly(target) {
  const info = lstatSync(target);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const entry of readdirSync(target)) makeReadOnly(`${target}/${entry}`);
    chmodSync(target, 0o555);
  } else chmodSync(target, 0o444);
}

function makeOwnerWritable(target) {
  const info = lstatSync(target);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    chmodSync(target, 0o755);
    for (const entry of readdirSync(target)) makeOwnerWritable(`${target}/${entry}`);
  } else chmodSync(target, 0o644);
}

function lockVerifierBoundary() {
  mkdirSync(REWARD_DIR, { recursive: true });
  chmodSync(REWARD_DIR, 0o700);
  try { chmodSync("/tests", 0o700); } catch {
    // Local no-container verification does not have /tests.
  }
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
    const source = readFileSync(TEST_FILE, "utf8");
    return createHash("sha256").update(source, "utf8").digest("hex") === EXPECTED_VISIBLE_TEST_SHA256;
  } catch {
    return false;
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

function hasAddedRouterTest() {
  try {
    return readdirSync(`${APP_DIR}/src`)
      .filter((name) => name.endsWith(".test.mjs") && name !== "server.test.mjs")
      .some((name) => {
        const source = readFileSync(`${APP_DIR}/src/${name}`, "utf8");
        return source.includes("/items/") && /\b(?:assert|test)\b/.test(source);
      });
  } catch {
    return false;
  }
}

function hasExtractedRouter() {
  try {
    const routerPath = `${APP_DIR}/src/router.mjs`;
    const info = lstatSync(routerPath);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const router = readFileSync(routerPath, "utf8");
    const server = readFileSync(`${APP_DIR}/src/server.mjs`, "utf8");
    return /export\s+(?:function|const)\s+createRouter\b/.test(router)
      && /from\s+["']\.\/router\.mjs["']/.test(server)
      && /createRouter\s*\(/.test(server)
      && !server.includes("router-fixture")
      && !server.includes('request.url === "/status"');
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
        reject(new Error("Could not determine verifier port"));
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
      if (!finished) { finished = true; clearTimeout(timer); resolve(); }
    };
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {
      // The child may exit between the timeout and signal.
    }
    finish(); }, 1_000);
    child.once("exit", finish);
    try { child.kill("SIGTERM"); } catch { finish(); }
  });
}

async function request(base, pathname, options = {}) {
  try {
    const response = await fetch(base + pathname, { ...options, signal: AbortSignal.timeout(2_000) });
    return { response, body: await response.text() };
  } catch { return null; }
}

async function checkItems(base) {
  const plain = await request(base, "/items/widget-42");
  const encoded = await request(base, "/items/blue%20widget");
  const rejected = await Promise.all([
    request(base, "/items"),
    request(base, "/items/"),
    request(base, "/items/a/b"),
    request(base, "/items/widget-42", { method: "POST" })
  ]);
  return plain?.response.status === 200
    && plain.response.headers.get("content-type") === "application/json; charset=utf-8"
    && plain.body === JSON.stringify({ itemId: "widget-42" })
    && encoded?.response.status === 200
    && encoded.body === JSON.stringify({ itemId: "blue widget" })
    && rejected.every((entry) => entry?.response.status === 404 && entry.body === "Not found\n");
}

async function checkExisting(base) {
  const root = await request(base, "/");
  const status = await request(base, "/status");
  const missing = await request(base, "/missing");
  const queriedStatus = await request(base, "/status?probe=1");
  return root?.response.status === 200
    && root.response.headers.get("content-type") === "text/plain; charset=utf-8"
    && root.body === "router-fixture\n"
    && status?.response.status === 200
    && status.response.headers.get("content-type") === "application/json; charset=utf-8"
    && status.body === JSON.stringify({ status: "ready" })
    && missing?.response.status === 404 && missing.body === "Not found\n"
    && queriedStatus?.response.status === 404 && queriedStatus.body === "Not found\n";
}

async function grade() {
  lockVerifierBoundary();
  // Hash the complete visible regression file before agent-controlled execution.
  const testsUnchanged = visibleTestIsUnchanged() ? 1 : 0;
  const visibleSuitePassed = runVisibleSuite();
  const addedTest = hasAddedRouterTest();
  const structure = hasExtractedRouter();
  let app = null;
  let functional = 0;
  let regression = 0;
  try {
    const port = await getFreePort();
    app = startApp(port);
    if (await waitForApp(app, port)) {
      const base = `http://127.0.0.1:${port}`;
      functional = addedTest && structure && await checkItems(base) ? 1 : 0;
      regression = visibleSuitePassed && await checkExisting(base) ? 1 : 0;
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
