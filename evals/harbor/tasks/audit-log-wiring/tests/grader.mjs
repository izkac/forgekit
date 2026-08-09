import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const APP_DIR = process.env.HARBOR_APP_DIR || "/app";
const TEST_FILE = `${APP_DIR}/src/server.test.mjs`;
const REWARD_DIR = process.env.HARBOR_REWARD_DIR || "/logs/verifier";
const REWARD_FILE = process.env.HARBOR_REWARD_FILE || `${REWARD_DIR}/reward.json`;
const EXPECTED_VISIBLE_TEST_SHA256 = "68fe2969e1c88c4da2fc1c73c29e6d67e624204dc482f5e08c970f7ea6a36596";

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

function untrustedEnvironment() {
  return { PATH: process.env.PATH, HOME: "/tmp", LANG: process.env.LANG || "C.UTF-8" };
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

function hasAddedIntegrationTest() {
  try {
    return readdirSync(`${APP_DIR}/src`)
      .filter((name) => name.endsWith(".test.mjs") && name !== "server.test.mjs")
      .some((name) => {
        const source = readFileSync(`${APP_DIR}/src/${name}`, "utf8");
        return source.includes("/orders")
          && source.includes("auditSink")
          && /\b(?:assert|test)\b/.test(source);
      });
  } catch {
    return false;
  }
}

function runtimeProbe() {
  const serverModule = JSON.stringify(`${APP_DIR}/src/server.mjs`);
  const source = `import { pathToFileURL } from "node:url";
const { createServer } = await import(pathToFileURL(${serverModule}));
const effects = [];
const orderStore = {
  async save(input) {
    effects.push(["persist", input]);
    return { id: "hidden-order-7", ...input };
  }
};
const auditSink = {
  async append(entry) { effects.push(["audit", entry]); }
};
const server = createServer({ orderStore, auditSink });
let result = { functional: false, regression: false };
try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const base = \`http://127.0.0.1:\${port}\`;
  const created = await fetch(\`\${base}/orders\`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku: "hidden-widget", quantity: 3 })
  });
  const createdBody = await created.text();
  result.functional = created.status === 201
    && created.headers.get("content-type") === "application/json; charset=utf-8"
    && createdBody === JSON.stringify({ id: "hidden-order-7", sku: "hidden-widget", quantity: 3 })
    && JSON.stringify(effects) === JSON.stringify([
      ["persist", { sku: "hidden-widget", quantity: 3 }],
      ["audit", { action: "order.created", orderId: "hidden-order-7", sku: "hidden-widget" }]
    ]);
  const root = await fetch(\`\${base}/\`);
  const missing = await fetch(\`\${base}/missing\`);
  const invalid = await fetch(\`\${base}/orders\`, { method: "POST", body: "not-json" });
  result.regression = root.status === 200
    && root.headers.get("content-type") === "text/plain; charset=utf-8"
    && await root.text() === "audit-wiring-fixture\\n"
    && missing.status === 404
    && await missing.text() === "Not found\\n"
    && invalid.status === 400
    && await invalid.text() === JSON.stringify({ error: "Invalid JSON" });
} finally {
  await new Promise((resolve) => server.close(() => resolve()));
}
console.log("HARBOR_PROBE " + JSON.stringify(result));
`;

  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module"], {
      cwd: APP_DIR,
      env: untrustedEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      ...configuredIdentity()
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.on("error", () => { clearTimeout(timer); resolve({ functional: false, regression: false }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout.split("\n").findLast((value) => value.startsWith("HARBOR_PROBE "));
      if (code !== 0 || !line) {
        resolve({ functional: false, regression: false });
        return;
      }
      try { resolve(JSON.parse(line.slice("HARBOR_PROBE ".length))); }
      catch { resolve({ functional: false, regression: false }); }
    });
    child.stdin.end(source);
  });
}

async function grade() {
  lockVerifierBoundary();
  // Record the immutable visible-test result before any agent-controlled code executes.
  const testsUnchanged = visibleTestIsUnchanged() ? 1 : 0;
  const visibleSuitePassed = runVisibleSuite();
  const addedTest = hasAddedIntegrationTest();
  let probe = { functional: false, regression: false };
  try {
    probe = await runtimeProbe();
  } finally {
    makeOwnerWritable(APP_DIR);
  }
  const functional = addedTest && probe.functional ? 1 : 0;
  const regression = visibleSuitePassed && probe.regression ? 1 : 0;
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
