import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, chownSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_DIR = process.env.HARBOR_APP_DIR || "/app";
const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const REWARD_DIR = process.env.HARBOR_REWARD_DIR || "/logs/verifier";
const REWARD_FILE = process.env.HARBOR_REWARD_FILE || `${REWARD_DIR}/reward.json`;
const SERVICE_FILE = `${APP_DIR}/src/reconciliation-service.mjs`;
const PACKAGE_FILE = `${APP_DIR}/package.json`;
const VISIBLE_TEST_FILE = `${APP_DIR}/src/reconciliation.test.mjs`;
const EXPECTED_PACKAGE_SHA256 = "feeb5823e3b6e0d15a5abba8d98a13082cbafaa66974d603b5ac1762d1456499";
const EXPECTED_VISIBLE_SHA256 = "35dbb5b5a88aa80beab6029fbbd2be9d8977aeb26db635fce22704641bf6fc0d";

function emptyReward() { return { functional: 0, regression: 0, tests_unchanged: 0, shippable: 0 }; }
function identity() {
  const uid = process.env.HARBOR_UNTRUSTED_UID, gid = process.env.HARBOR_UNTRUSTED_GID;
  if (uid === undefined && gid === undefined) return {};
  if (!/^[0-9]+$/.test(uid || "") || !/^[0-9]+$/.test(gid || "") || typeof process.getuid !== "function" || process.getuid() !== 0) throw new Error("invalid worker identity");
  return { uid: Number(uid), gid: Number(gid) };
}
function env(extra = {}) { return { PATH: process.env.PATH, HOME: "/tmp", LANG: process.env.LANG || "C.UTF-8", HARBOR_APP_DIR: APP_DIR, ...extra }; }
function visit(target, modes, own = false) {
  const info = lstatSync(target);
  if (info.isSymbolicLink()) throw new Error("symlink forbidden");
  if (own && typeof process.getuid === "function" && process.getuid() === 0) chownSync(target, 0, 0);
  if (info.isDirectory()) { chmodSync(target, modes.directory); for (const entry of readdirSync(target)) visit(join(target, entry), modes, own); }
  else if (info.isFile()) chmodSync(target, modes.file); else throw new Error("non-regular tree entry");
}
function regular(target) { const info = lstatSync(target); if (info.isSymbolicLink()) throw new Error("application symlink"); if (info.isDirectory()) for (const entry of readdirSync(target)) regular(join(target, entry)); else if (!info.isFile()) throw new Error("non-file application entry"); }
function writable(target) { visit(target, { directory: 0o755, file: 0o644 }); }
function readonly(target, own = false) { visit(target, { directory: 0o555, file: 0o444 }, own); }
function digest(target, mode = true) {
  const hash = createHash("sha256");
  function walk(file, rel) { const info = lstatSync(file); if (info.isSymbolicLink()) throw new Error("digest symlink"); const type = info.isDirectory() ? "d" : info.isFile() ? "f" : "x"; hash.update(`${rel}\0${type}\0${mode ? `${info.mode & 0o7777}\0` : ""}`); if (info.isFile()) hash.update(readFileSync(file)); else if (info.isDirectory()) for (const e of readdirSync(file).sort()) walk(join(file, e), `${rel}/${e}`); else throw new Error("digest entry"); }
  walk(target, "."); return hash.digest("hex");
}
function snapshot() { const digestValue = digest(APP_DIR, false); const directory = mkdtempSync(join(tmpdir(), "carrier-snapshot-")); chmodSync(directory, 0o700); const copy = join(directory, "app"); cpSync(APP_DIR, copy, { recursive: true, verbatimSymlinks: true }); readonly(copy); return { directory, copy, digest: digestValue }; }
function restore(copy) { writable(APP_DIR); for (const e of readdirSync(APP_DIR)) rmSync(join(APP_DIR, e), { recursive: true, force: true }); for (const e of readdirSync(copy)) cpSync(join(copy, e), join(APP_DIR, e), { recursive: true, verbatimSymlinks: true }); regular(APP_DIR); readonly(APP_DIR); }
function lock() { mkdirSync(REWARD_DIR, { recursive: true }); chmodSync(REWARD_DIR, 0o700); regular(TESTS_DIR); if (typeof process.getuid === "function" && process.getuid() === 0) { readonly(TESTS_DIR, true); try { chmodSync("/tests", 0o700); } catch { /* ignored */ } } writable(APP_DIR); readonly(APP_DIR, typeof process.getuid === "function" && process.getuid() === 0); }
function protectedFiles() { return [[PACKAGE_FILE, EXPECTED_PACKAGE_SHA256], [VISIBLE_TEST_FILE, EXPECTED_VISIBLE_SHA256]].every(([file, expected]) => { try { const info = lstatSync(file); return info.isFile() && !info.isSymbolicLink() && createHash("sha256").update(readFileSync(file)).digest("hex") === expected; } catch { return false; } }); }
function addedTests() { try { return readdirSync(`${APP_DIR}/src`).filter((name) => name.endsWith(".test.mjs") && name !== "reconciliation.test.mjs").map((name) => `${APP_DIR}/src/${name}`).filter((file) => lstatSync(file).isFile()); } catch { return []; } }
function visible() { const result = spawnSync("npm", ["test"], { cwd: APP_DIR, encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], env: env(), ...identity() }); return !result.error && result.status === 0; }

function loaderSource(marker, parent) {
  const state = `node:carrier-state-${marker}`;
  const stateCode = `import { AssertionError } from "node:assert?carrier-real"; const marked = new WeakSet(); export function mark(error) { if (error instanceof AssertionError) marked.add(error); } const failures = new Map(); export function record(name,error) { if (marked.has(error)) failures.set(name,(failures.get(name)||0)+1); } export function consume(name) { const n=failures.get(name)||0; if(n<=1) failures.delete(name); else failures.set(name,n-1); return n>0; }`;
  const assertCode = (spec) => `import * as ns from ${JSON.stringify(spec)}; import { mark } from ${JSON.stringify(state)}; const actual=ns.default; const cache=new WeakMap(); function wrap(v){if(typeof v!=="function")return v;if(cache.has(v))return cache.get(v);const w=function(...a){try{const r=Reflect.apply(v,this,a);return r&&typeof r.then==="function"?r.catch(e=>{mark(e);throw e;}):r;}catch(e){mark(e);throw e;}};cache.set(v,w);return w;} const proxy=new Proxy(actual,{apply(t,x,a){try{return Reflect.apply(t,x,a)}catch(e){mark(e);throw e;}},get(t,p,r){return wrap(Reflect.get(t,p,r));}}); export default proxy; export const AssertionError=ns.AssertionError; export const deepEqual=proxy.deepEqual; export const deepStrictEqual=proxy.deepStrictEqual; export const equal=proxy.equal; export const fail=proxy.fail; export const match=proxy.match; export const notDeepEqual=proxy.notDeepEqual; export const notEqual=proxy.notEqual; export const ok=proxy.ok; export const rejects=proxy.rejects; export const strictEqual=proxy.strictEqual; export const throws=proxy.throws;`;
  const testCode = `import * as ns from "node:test?carrier-real"; import { record } from ${JSON.stringify(state)}; const actual=ns.default; function wrap(cb,name){return(...a)=>{try{const r=cb(...a);return r&&typeof r.then==="function"?r.catch(e=>{record(name,e);throw e;}):r;}catch(e){record(name,e);throw e;}}} const proxy=new Proxy(actual,{apply(t,x,a){const cb=a.findLast(v=>typeof v==="function");if(!cb)return Reflect.apply(t,x,a);const b=[...a];b[b.lastIndexOf(cb)]=wrap(cb,typeof a[0]==="string"?a[0]:cb.name||"anonymous");return Reflect.apply(t,x,b);}}); export default proxy; export const test=proxy;`;
  const a = `data:text/javascript,${encodeURIComponent(assertCode("node:assert?carrier-real"))}`;
  const s = `data:text/javascript,${encodeURIComponent(assertCode("node:assert/strict?carrier-real"))}`;
  const t = `data:text/javascript,${encodeURIComponent(testCode)}`;
  return `export async function resolve(specifier,context,nextResolve){const trusted=new Set([${JSON.stringify(a)},${JSON.stringify(s)},${JSON.stringify(t)},${JSON.stringify(parent)},${JSON.stringify(parent.replace("%5Bstdin%5D","[stdin]"))}]);if(specifier===${JSON.stringify(state)}){if(context.parentURL!==undefined&&!trusted.has(context.parentURL))throw new Error("untrusted state");return{url:"data:text/javascript,"+encodeURIComponent(${JSON.stringify(stateCode)}),shortCircuit:true};}if(specifier==="node:assert"||specifier==="node:assert/strict"){const source=specifier==="node:assert/strict"?${JSON.stringify(assertCode("node:assert/strict?carrier-real"))}:${JSON.stringify(assertCode("node:assert?carrier-real"))};return{url:"data:text/javascript,"+encodeURIComponent(source),shortCircuit:true};}if(specifier==="node:test"){return{url:"data:text/javascript,"+encodeURIComponent(${JSON.stringify(testCode)}),shortCircuit:true};}if(specifier.endsWith("?carrier-real"))return nextResolve(specifier.slice(0,-13),context,nextResolve);return nextResolve(specifier,context,nextResolve);}`;
}
function runClassified(files) {
  if (!files.length) return { completed: false, passed: 0, bodyAssertionFailures: 0, bodyOtherFailures: 0, bootstrapFailures: 0 };
  const nonce = randomBytes(24).toString("hex"), prefix = `CARRIER_ASSERTION_${nonce} `, state = `node:carrier-state-CARRIER_MARKER_${nonce}`;
  const runner = `const{writeSync}=require("node:fs");const{run}=require("node:test");const files=${JSON.stringify(files)};const set=new Set(files);let passed=0,bodyAssertionFailures=0,bodyOtherFailures=0,bootstrapFailures=0;(async()=>{const{consume}=await import(${JSON.stringify(state)});for await(const e of run({files,concurrency:false,isolation:"none"})){const d=e.data||{};const body=typeof d.file==="string"&&typeof d.line==="number"&&typeof d.name==="string"&&!set.has(d.name);if(e.type==="test:pass"&&body)passed++;if(e.type==="test:fail"){if(!body)bootstrapFailures++;else if(consume(d.name))bodyAssertionFailures++;else bodyOtherFailures++;}}writeSync(3,${JSON.stringify(prefix)}+JSON.stringify({passed,bodyAssertionFailures,bodyOtherFailures,bootstrapFailures})+"\\n");})().catch(()=>process.exitCode=1);`;
  try { const result = spawnSync(process.execPath, ["--loader", `data:text/javascript,${encodeURIComponent(loaderSource(`CARRIER_MARKER_${nonce}`, pathToFileURL(join(APP_DIR, "[stdin]")).href))}`], { cwd: APP_DIR, encoding: "utf8", input: runner, timeout: 30_000, stdio: ["pipe", "ignore", "ignore", "pipe"], env: env({ HARBOR_CLASSIFIER_RUN: "1" }), ...identity() }); if (result.error || result.status !== 0 || typeof result.output[3] !== "string") throw new Error("classifier failed"); const lines = result.output[3].split("\n").filter((line) => line.startsWith(prefix)); if (lines.length !== 1) throw new Error("unauthenticated classifier"); const value = JSON.parse(lines[0].slice(prefix.length)); if (Object.keys(value).sort().join(",") !== "bodyAssertionFailures,bodyOtherFailures,bootstrapFailures,passed" || !Object.values(value).every((n) => Number.isSafeInteger(n) && n >= 0)) throw new Error("invalid classifier"); return { completed: true, ...value }; } catch { return { completed: false, passed: 0, bodyAssertionFailures: 0, bodyOtherFailures: 0, bootstrapFailures: 0 }; }
}
function meaningful(files) {
  if (!files.length) return false;
  const original = readFileSync(SERVICE_FILE);
  try {
    const normal = runClassified(files);
    if (!normal.completed || normal.passed < 1 || normal.bodyAssertionFailures || normal.bodyOtherFailures || normal.bootstrapFailures) return false;
    writable(SERVICE_FILE);
    writeFileSync(SERVICE_FILE, readFileSync(`${TESTS_DIR}/mutants/reconciliation-service.mjs`));
    chmodSync(SERVICE_FILE, 0o444);
    const mutant = runClassified(files);
    return mutant.completed && mutant.bodyAssertionFailures > 0 && mutant.bootstrapFailures === 0;
  } finally {
    writable(SERVICE_FILE);
    writeFileSync(SERVICE_FILE, original);
    chmodSync(SERVICE_FILE, 0o444);
  }
}
function hidden() { return new Promise((resolve) => { const workerIdentity = process.env.HARBOR_UNTRUSTED_UID === undefined || process.env.HARBOR_UNTRUSTED_GID === undefined ? {} : { HARBOR_UNTRUSTED_UID: process.env.HARBOR_UNTRUSTED_UID, HARBOR_UNTRUSTED_GID: process.env.HARBOR_UNTRUSTED_GID }; const child = spawn(process.execPath, [`${TESTS_DIR}/hidden-probe.mjs`], { cwd: APP_DIR, env: env(workerIdentity), stdio: ["ignore", "ignore", "ignore"] }); const timer = setTimeout(() => child.kill("SIGKILL"), 30_000); child.on("error", () => { clearTimeout(timer); resolve(false); }); child.on("close", (code) => { clearTimeout(timer); resolve(code === 0); }); }); }
function writeReward(value) { mkdirSync(dirname(REWARD_FILE), { recursive: true }); writeFileSync(REWARD_FILE, `${JSON.stringify(value)}\n`); }
async function grade() {
  let saved;
  try { regular(APP_DIR); const verifier = digest(TESTS_DIR, false); saved = snapshot(); lock(); const initial = protectedFiles(); const regression = visible() ? 1 : 0; const meaningfulTest = meaningful(addedTests()); const post = protectedFiles(); let safe = true; try { regular(APP_DIR); } catch { safe = false; } restore(saved.copy); const behavior = await hidden(); let restored = true, regularHidden = true; try { restored = digest(APP_DIR, false) === saved.digest; regular(APP_DIR); } catch { regularHidden = false; } restore(saved.copy); const finalProtected = protectedFiles(); const finalTree = digest(APP_DIR, false) === saved.digest; const testsUnchanged = initial && post && safe && restored && regularHidden && finalProtected && finalTree && digest(TESTS_DIR, false) === verifier ? 1 : 0; const functional = meaningfulTest && behavior ? 1 : 0; return { functional: functional ? 1 : 0, regression, tests_unchanged: testsUnchanged, shippable: functional && regression && testsUnchanged ? 1 : 0 }; } catch { return emptyReward(); } finally { if (saved) { writable(saved.directory); rmSync(saved.directory, { recursive: true, force: true }); } try { writable(APP_DIR); } catch { /* ignored */ } }
}
try { writeReward(await grade()); } catch { try { writeReward(emptyReward()); } catch { /* ignored */ } process.exitCode = 1; }
