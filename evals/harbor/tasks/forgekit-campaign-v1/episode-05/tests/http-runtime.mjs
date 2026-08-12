import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

export const FIXED_NOW_MS = 1_700_000_000_000;

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on("error", reject);
  });
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("server start timed out"));
    }, 10_000);
    let stdout = "";
    const onExit = (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited ${code}: ${stdout}`));
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (/listening on \d+/.test(stdout)) {
        clearTimeout(timer);
        child.off("exit", onExit);
        resolve();
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", onExit);
  });
}

export async function startAppServer(appDirectory, { nowMs = FIXED_NOW_MS } = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(appDirectory, "src", "server.mjs")], {
    cwd: appDirectory,
    env: {
      PATH: process.env.PATH,
      HOME: "/tmp",
      LANG: process.env.LANG || "C.UTF-8",
      PORT: String(port),
      NOW_MS: String(nowMs),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForListening(child);
  return {
    port,
    nowMs,
    async request(method, pathname, body, headers = {}) {
      const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let json = null;
      if (text.length > 0) {
        try { json = JSON.parse(text); } catch { json = null; }
      }
      return { status: response.status, json };
    },
    stop() {
      child.kill("SIGKILL");
    },
  };
}

export async function runChecks(checks, http) {
  const results = [];
  for (const check of checks) {
    try {
      results.push(await check.run(http) === true);
    } catch {
      results.push(false);
    }
  }
  return results;
}

export function countResults(results) {
  return {
    met: results.filter(Boolean).length,
    total: results.length,
  };
}
