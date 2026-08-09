#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const USAGE = `Usage: node evals/harbor/normalize-results.mjs \\
  --reward <reward.json> --arm <baseline|forge> --task <task-id> --trial <positive-integer> \\
  [--forge-summary <summary.json>] [--harbor-result <result.json>] [--harbor-job-result <result.json>]

Reads external Harbor verifier rewards and writes one normalized JSON record to stdout.
Forge artifacts are optional secondary instrumentation and never affect outcome metrics.`;

const VALUE_OPTIONS = new Set([
  "--reward",
  "--arm",
  "--task",
  "--trial",
  "--forge-summary",
  "--harbor-result",
  "--harbor-job-result"
]);

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }

  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!VALUE_OPTIONS.has(name)) {
      throw new Error(`Unknown option: ${name}`);
    }
    if (Object.hasOwn(options, name)) {
      throw new Error(`Option may only be specified once: ${name}`);
    }

    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    options[name] = value;
    index += 1;
  }

  for (const name of ["--reward", "--arm", "--task", "--trial"]) {
    if (!options[name]) {
      throw new Error(`${name} is required`);
    }
  }
  if (options["--arm"] !== "baseline" && options["--arm"] !== "forge") {
    throw new Error("--arm must be baseline or forge");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options["--task"])) {
    throw new Error("--task must be a non-empty task id using letters, numbers, '.', '_' or '-'");
  }
  if (!/^[1-9][0-9]*$/.test(options["--trial"])
    || !Number.isSafeInteger(Number(options["--trial"]))) {
    throw new Error("--trial must be a safe positive integer");
  }

  return {
    rewardPath: options["--reward"],
    forgeSummaryPath: options["--forge-summary"],
    harborResultPath: options["--harbor-result"],
    harborJobResultPath: options["--harbor-job-result"],
    arm: options["--arm"],
    task: options["--task"],
    trial: Number(options["--trial"])
  };
}

async function readJson(path, label) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`Could not read ${label} at ${path}: ${error.message}`);
  }

  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid JSON in ${label} at ${path}: ${error.message}`);
  }
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
}

function requireMetric(reward, name) {
  const value = reward[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Harbor reward must include required numeric reward metric "${name}"`);
  }
  return value;
}

function normalizeOutcome(reward) {
  requireObject(reward, "Harbor reward");
  const functional = requireMetric(reward, "functional");
  const regression = requireMetric(reward, "regression");
  const testsUnchanged = requireMetric(reward, "tests_unchanged");
  const verifierShippable = requireMetric(reward, "shippable");

  // Never upgrade a verifier failure, and never accept a verifier's shippable=1
  // when any independently reported required metric does not fully pass.
  const shippable = verifierShippable === 1
    && functional === 1
    && regression === 1
    && testsUnchanged === 1
    ? 1
    : 0;

  return {
    functional,
    regression,
    tests_unchanged: testsUnchanged,
    shippable
  };
}

function missingHarbor(reason) {
  return {
    available: false,
    reason,
    wall_clock_seconds: null,
    input_tokens: null,
    cache_tokens: null,
    output_tokens: null,
    cost_usd: null,
    retries: null
  };
}

function finiteNumberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sumContextMetric(contexts, name) {
  const values = contexts.map((context) => finiteNumberOrNull(context?.[name])).filter((value) => value !== null);
  return values.length === 0 ? null : values.reduce((total, value) => total + value, 0);
}

function normalizeHarbor(result, jobResult) {
  requireObject(result, "Harbor trial result");
  const contexts = result.agent_result && typeof result.agent_result === "object"
    ? [result.agent_result]
    : Array.isArray(result.step_results)
      ? result.step_results.map((step) => step?.agent_result).filter((context) => context && typeof context === "object")
      : [];
  const started = Date.parse(result.started_at);
  const finished = Date.parse(result.finished_at);
  const wallClock = Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? (finished - started) / 1000
    : null;
  const retriesValue = jobResult?.stats?.n_retries;
  const retries = Number.isSafeInteger(retriesValue) && retriesValue >= 0 ? retriesValue : null;
  return {
    available: true,
    reason: null,
    wall_clock_seconds: wallClock,
    input_tokens: sumContextMetric(contexts, "n_input_tokens"),
    cache_tokens: sumContextMetric(contexts, "n_cache_tokens"),
    output_tokens: sumContextMetric(contexts, "n_output_tokens"),
    cost_usd: sumContextMetric(contexts, "cost_usd"),
    retries
  };
}

async function normalize(options) {
  const reward = await readJson(options.rewardPath, "Harbor reward");
  const outcome = normalizeOutcome(reward);

  let forge = null;
  let forgeReason = "Forge artifact summary was not provided";
  if (options.forgeSummaryPath !== undefined) {
    try {
      forge = await readJson(options.forgeSummaryPath, "Forge artifact summary");
      requireObject(forge, "Forge artifact summary");
      forgeReason = null;
    } catch (error) {
      forgeReason = error.message;
    }
  }

  let harbor = missingHarbor("Harbor trial result was not provided");
  if (options.harborResultPath !== undefined) {
    try {
      const trialResult = await readJson(options.harborResultPath, "Harbor trial result");
      const jobResult = options.harborJobResultPath === undefined
        ? null
        : await readJson(options.harborJobResultPath, "Harbor job result");
      if (jobResult !== null) requireObject(jobResult, "Harbor job result");
      harbor = normalizeHarbor(trialResult, jobResult);
    } catch (error) {
      harbor = missingHarbor(error.message);
    }
  }

  const instrumentation = {
    available: forge !== null,
    reason: forgeReason,
    forge,
    harbor
  };

  return {
    schema_version: 1,
    arm: options.arm,
    task: options.task,
    trial: options.trial,
    outcome,
    instrumentation
  };
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }
    const result = await normalize(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`normalize-results: ${error.message}\n`);
    process.exitCode = 1;
  }
}

await main();
