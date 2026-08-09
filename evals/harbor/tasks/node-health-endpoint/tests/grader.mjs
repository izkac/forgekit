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
// Hash the complete original visible regression file. Agents add new tests in
// separate files, so any edit or executable-context suffix is test tampering.
const EXPECTED_VISIBLE_TEST_SHA256 = "9d046775e5fbc9b414abfca6568d4c01f27b5ca91c4141b35ad5a0e0cf1620f2";

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
    // Local no-container verification does not have /tests.
  }
  makeReadOnly(APP_DIR);
}

function emptyReward() {
  return {
    functional: 0,
    regression: 0,
    tests_unchanged: 0,
    shippable: 0
  };
}

function writeReward(reward) {
  mkdirSync(dirname(REWARD_FILE), { recursive: true });
  writeFileSync(REWARD_FILE, `${JSON.stringify(reward)}\n`, "utf8");
}

function visibleTestIsUnchanged() {
  let source;
  try {
    source = readFileSync(TEST_FILE, "utf8");
  } catch {
    return false;
  }

  const actualHash = createHash("sha256").update(source, "utf8").digest("hex");
  return actualHash === EXPECTED_VISIBLE_TEST_SHA256;
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

  if (result.error) {
    return false;
  }
  return result.status === 0;
}

function hasAddedHealthTest() {
  try {
    return readdirSync(`${APP_DIR}/src`)
      .filter((name) => name.endsWith(".test.mjs") && name !== "server.test.mjs")
      .some((name) => {
        const source = readFileSync(`${APP_DIR}/src/${name}`, "utf8");
        return source.includes("/health") && /\b(?:assert|test)\b/.test(source);
      });
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

      probe.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(address.port);
        }
      });
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
  child.once("error", (error) => {
    spawnError = error;
  });

  return { child, get spawnError() { return spawnError; } };
}

async function waitForApp(app, port) {
  const url = `http://127.0.0.1:${port}/`;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (app.spawnError || app.child.exitCode !== null) {
      return false;
    }

    try {
      await fetch(url, { signal: AbortSignal.timeout(500) });
      return true;
    } catch {
      await delay(100);
    }
  }
  return false;
}

function stopApp(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }

    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        clearTimeout(killTimer);
        resolve();
      }
    };
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may have exited between the checks.
      }
      finish();
    }, 1_000);

    child.once("exit", finish);
    try {
      child.kill("SIGTERM");
    } catch {
      finish();
    }
  });
}

async function fetchText(url, options = {}) {
  try {
    const response = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(2_000)
    });
    return { response, body: await response.text() };
  } catch {
    return null;
  }
}

async function checkRoot(baseURL) {
  const result = await fetchText(`${baseURL}/`);
  return Boolean(
    result
    && result.response.status === 200
    && result.response.headers.get("content-type") === "text/plain; charset=utf-8"
    && result.body === "node-health-fixture\n"
  );
}

async function checkHealth(baseURL) {
  const result = await fetchText(`${baseURL}/health`);
  if (!result || result.response.status !== 200) {
    return false;
  }

  const contentType = result.response.headers.get("content-type") || "";
  if (contentType.split(";", 1)[0].trim() !== "application/json") {
    return false;
  }

  try {
    const payload = JSON.parse(result.body);
    return Boolean(
      payload
      && payload.ok === true
      && Object.keys(payload).length === 1
    );
  } catch {
    return false;
  }
}

async function checkOtherRoutes(baseURL) {
  const missing = await fetchText(`${baseURL}/missing`);
  const postHealth = await fetchText(`${baseURL}/health`, { method: "POST" });
  const queriedHealth = await fetchText(`${baseURL}/health?probe=1`);

  return [missing, postHealth, queriedHealth].every((result) => (
    result
    && result.response.status === 404
    && result.response.headers.get("content-type") === "text/plain; charset=utf-8"
    && result.body === "Not found\n"
  ));
}

async function grade() {
  lockVerifierBoundary();
  const testsUnchanged = visibleTestIsUnchanged() ? 1 : 0;
  const visibleSuitePassed = runVisibleSuite();
  const addedHealthTest = hasAddedHealthTest();
  let functional = 0;
  let regression = 0;
  let app = null;

  try {
    const port = await getFreePort();
    app = startApp(port);
    if (await waitForApp(app, port)) {
      const baseURL = `http://127.0.0.1:${port}`;
      functional = addedHealthTest && await checkHealth(baseURL) ? 1 : 0;
      regression = (
        visibleSuitePassed
        && await checkRoot(baseURL)
        && await checkOtherRoutes(baseURL)
      ) ? 1 : 0;
    }
  } finally {
    if (app) {
      await stopApp(app.child);
    }
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
    const reward = await grade();
    writeReward(reward);
    return 0;
  } catch (error) {
    try {
      writeReward(emptyReward());
    } catch (writeError) {
      console.error("Failed to write verifier reward:", writeError);
    }
    console.error("Verifier infrastructure error:", error);
    return 1;
  }
};

process.exitCode = await main();
