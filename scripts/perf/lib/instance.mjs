// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// An isolated MoltenTerm instance for the performance harness. Everything it uses lives in a throwaway root the
// harness creates under /tmp, or --tmp (short on purpose: wavesrv's unix socket path has a length limit), marked with a file
// that names the root. It refuses to launch on, or delete, a directory without that marker, so it can never touch the
// user's data or another instance. It stops only the processes it started: the saved Electron pid, the process tree
// captured under it, and processes whose command line holds its own root (durable shells, wsh job managers).

/* global process, setTimeout, console */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { descendants, psAll } from "./procs.mjs";

export const MarkerName = ".moltenterm-perf-root";
const Live = new Set();
const LiveLoads = new Set();

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function assertOwnedRoot(root) {
  const marker = path.join(root, MarkerName);
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(marker, "utf8"));
  } catch {
    throw new Error(`refusing ${root}: it was not created by the perf harness (no ${MarkerName})`);
  }
  if (data.root !== fs.realpathSync(root)) {
    throw new Error(`refusing ${root}: its marker names another directory`);
  }
  return true;
}

// Lines "YYYY-MM-DD HH:MM:SS.mmm message" of waveapp.log written at or after `sinceMs` (local time).
export function readLog(file, sinceMs) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const l of text.split("\n")) {
    const m = l.match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d\.\d{3}) (.*)$/);
    if (!m) {
      continue;
    }
    const t = new Date(`${m[1]}T${m[2]}`).getTime();
    if (t >= sinceMs - 50) {
      out.push({ t, s: m[3] });
    }
  }
  return out;
}

// Start-up milestones of the launch that started at `startMs`, in ms since the launch.
export function startupTimings(lines, startMs) {
  const first = (re) => lines.find((l) => re.test(l.s));
  const at = (l) => (l ? l.t - startMs : null);
  const tabviewInits = lines
    .filter((l) => /^tabview init/.test(l.s))
    .map((l) => Number(l.s.match(/(\d+)ms/)?.[1]))
    .filter(Number.isFinite);
  return {
    wavesrvReady: at(first(/wavesrv ready signal/)),
    createWin: at(first(/^create win/)),
    initBare: at(first(/fe-log Init Bare/)),
    waveReady: at(first(/^wave-ready init time/)),
    firstTabviewInitMs: tabviewInits[0] ?? null,
    tabviewInits,
  };
}

// Instances run in the background test mode (#495) unless `run --foreground`: they never take the focus or cover the
// user's windows. A build from before #495 (`--app` on an older checkout) ignores the variable.
let backgroundMode = true;

export function setBackgroundMode(on) {
  backgroundMode = !!on;
}

export class Instance {
  root;
  dataDir;
  configDir;
  logFile;
  port = null;
  inspectPort = null;
  child = null;
  pid = null;
  tree = [];
  startMs = null;
  launches = 0;
  repoRoot;

  constructor(repoRoot, root) {
    this.repoRoot = repoRoot;
    this.root = root;
    this.dataDir = path.join(root, "data");
    this.configDir = path.join(root, "config");
    this.logFile = path.join(this.dataDir, "waveapp.log");
  }

  static create(repoRoot, tmpBase = "/tmp") {
    fs.mkdirSync(tmpBase, { recursive: true });
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase, "mtperf-")));
    fs.writeFileSync(
      path.join(root, MarkerName),
      JSON.stringify({ root, harnessPid: process.pid, created: Date.now() })
    );
    const inst = new Instance(repoRoot, root);
    fs.mkdirSync(inst.dataDir);
    fs.mkdirSync(inst.configDir);
    Live.add(inst);
    return inst;
  }

  writeConfig(rel, content) {
    assertOwnedRoot(this.root);
    const file = path.join(this.configDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }

  writeData(rel, content) {
    assertOwnedRoot(this.root);
    const file = path.join(this.dataDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }

  electronBinary() {
    return createRequire(path.join(this.repoRoot, "package.json"))("electron");
  }

  async launch() {
    assertOwnedRoot(this.root);
    if (this.child) {
      throw new Error("instance already running");
    }
    this.port = await freePort();
    this.inspectPort = await freePort();
    const args = [".", `--remote-debugging-port=${this.port}`, `--inspect=${this.inspectPort}`];
    if (process.platform === "linux") {
      // CI runners have no setuid sandbox helper.
      args.push("--no-sandbox");
    }
    const env = {
      ...process.env,
      MOLTENTERM_DATA_HOME: this.dataDir,
      MOLTENTERM_CONFIG_HOME: this.configDir,
      // A path that never exists, so a legacy ~/.moltenterm-dev home can never be picked up instead.
      MOLTENTERM_HOME: path.join(this.root, "no-legacy-home"),
      WAVETERM_NOCONFIRMQUIT: "1",
      MOLTENTERM_SKIP_ONBOARDING: "1",
    };
    if (backgroundMode) {
      env.MOLTENTERM_BACKGROUND = "1";
    } else {
      delete env.MOLTENTERM_BACKGROUND;
    }
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    const out = fs.openSync(path.join(this.root, `electron-${++this.launches}.out`), "a");
    this.startMs = Date.now();
    const child = spawn(this.electronBinary(), args, { cwd: this.repoRoot, env, stdio: ["ignore", out, out] });
    fs.closeSync(out);
    this.child = child;
    this.pid = child.pid;
    child.on("exit", () => {
      // A late exit of a previous launch must not clear the current one.
      if (this.child === child) {
        this.child = null;
      }
    });
    return this.pid;
  }

  log(sinceMs = this.startMs) {
    return readLog(this.logFile, sinceMs);
  }

  // Resolves with the start-up timings once wave-ready is logged, or with `timedOut` after `timeoutMs`.
  async waitReady(timeoutMs = 60000) {
    const end = this.startMs + timeoutMs;
    while (Date.now() < end) {
      if (!this.child) {
        throw new Error(`the app exited during start-up (see ${this.root}/electron-${this.launches}.out)`);
      }
      const t = startupTimings(this.log(), this.startMs);
      if (t.waveReady != null) {
        this.captureTree();
        return { ...t, timedOut: false };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    this.captureTree();
    return { ...startupTimings(this.log(), this.startMs), timedOut: true };
  }

  // Waits for a log line matching `re` written after `sinceMs`.
  async waitLog(re, sinceMs, timeoutMs = 20000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const hit = this.log(sinceMs).find((l) => re.test(l.s));
      if (hit) {
        return hit;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  // The saved pid is ours only while the child we spawned has not exited: after that it may be reused.
  mainAlive() {
    return this.pid != null && this.child != null && this.child.exitCode == null && this.child.signalCode == null;
  }

  captureTree() {
    if (!this.mainAlive()) {
      return;
    }
    const known = new Map(this.tree.map((p) => [p.pid, p]));
    for (const p of descendants(psAll(), this.pid)) {
      known.set(p.pid, p);
    }
    this.tree = [...known.values()];
  }

  // Processes that belong to this instance: the captured tree (only while each pid still runs the same command, so
  // a reused pid is never hit), the tree under the live main process, and the processes that run a binary from this
  // root or carry its data directory in their environment (the detached wsh job managers), with their descendants
  // (durable shells). A process that merely mentions the root in its arguments (`tail -f <root>/data/waveapp.log`)
  // is never one of them.
  ownProcesses() {
    const all = psAll();
    const byPid = new Map(all.map((p) => [p.pid, p]));
    const mine = new Map();
    for (const p of this.tree) {
      const cur = byPid.get(p.pid);
      if (cur && cur.cmd === p.cmd) {
        mine.set(p.pid, cur);
      }
    }
    if (this.mainAlive()) {
      for (const p of descendants(all, this.pid)) {
        mine.set(p.pid, p);
      }
    }
    for (const p of all) {
      if (p.pid !== process.pid && !mine.has(p.pid) && this.isRootProcess(p)) {
        for (const d of descendants(all, p.pid)) {
          mine.set(d.pid, d);
        }
      }
    }
    mine.delete(process.pid);
    // A zombie is already dead; it only waits for its parent to reap it.
    return [...mine.values()].filter((p) => !p.zombie);
  }

  rootAliases() {
    return [this.root, this.root.replace(/^\/private\//, "/")].map((a) => `${a}/`);
  }

  isRootProcess(p) {
    const aliases = this.rootAliases();
    if (!aliases.some((a) => p.cmd.includes(a))) {
      return false;
    }
    if (aliases.some((a) => p.cmd.startsWith(a))) {
      return true;
    }
    const env = processEnv(p.pid, p.cmd);
    return env != null && hasToken(env, new Set(aliases.map((a) => `MOLTENTERM_DATA_HOME=${a}data`)));
  }

  async stop() {
    if (this.pid == null) {
      this.killLeftovers();
      return;
    }
    this.captureTree();
    if (this.mainAlive()) {
      try {
        process.kill(this.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    const end = Date.now() + 10000;
    while (this.child && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 300));
    this.killLeftovers();
    this.pid = null;
    this.child = null;
    this.tree = [];
  }

  killLeftovers() {
    for (let round = 0; round < 3; round++) {
      const left = this.ownProcesses();
      if (!left.length) {
        return;
      }
      for (const p of left) {
        try {
          process.kill(p.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      spawnSync("sleep", ["0.3"]);
    }
    const still = this.ownProcesses();
    if (still.length) {
      console.error(
        `perf: ${still.length} process(es) of ${this.root} survived SIGKILL: ${still.map((p) => p.pid).join(" ")}`
      );
    }
  }

  async dispose({ keep = false } = {}) {
    try {
      await this.stop();
    } finally {
      this.removeRoot(keep);
    }
  }

  removeRoot(keep = false) {
    Live.delete(this);
    if (keep || !fs.existsSync(this.root)) {
      return;
    }
    assertOwnedRoot(this.root);
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  // Synchronous last-resort cleanup, for process exit and signals.
  disposeSync() {
    try {
      this.captureTree();
    } catch {
      // ps unavailable: fall back to the root match below
    }
    try {
      this.killLeftovers();
    } catch {
      // nothing more we can do
    }
    try {
      this.removeRoot(false);
    } catch {
      // leave it; the marker lets a later run recognise it
    }
  }
}

// The environment of a process, as text: `ps -E` on macOS, /proc on Linux. Null when it cannot be read.
function processEnv(pid, cmd) {
  try {
    if (process.platform === "linux") {
      return fs.readFileSync(`/proc/${pid}/environ`, "utf8");
    }
    const out = spawnSync("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout;
    return out == null ? null : envPart(out.trim(), cmd);
  } catch {
    return null;
  }
}

// macOS `ps -E` appends the environment to the command line; only what follows the command is the environment, so
// a command that merely mentions a variable in its arguments is not mistaken for one that has it.
function envPart(withEnv, cmd) {
  if (cmd == null || !withEnv.startsWith(cmd)) {
    return "";
  }
  return withEnv.slice(cmd.length);
}

function hasToken(env, tokens) {
  return env.split(/[\s\0]+/).some((t) => tokens.has(t));
}

// Roots left by a harness that was killed outright (SIGKILL, crash): their marker names a harness pid that no
// longer runs. Their processes are stopped and the roots removed before a new run starts.
export function sweepStaleRoots(repoRoot, tmpBase) {
  let names = [];
  try {
    names = fs.readdirSync(tmpBase).filter((n) => n.startsWith("mtperf-"));
  } catch {
    return 0;
  }
  let swept = 0;
  for (const name of names) {
    const root = path.join(tmpBase, name);
    let marker;
    try {
      marker = JSON.parse(fs.readFileSync(path.join(root, MarkerName), "utf8"));
      assertOwnedRoot(root);
    } catch {
      continue;
    }
    if (marker.harnessPid === process.pid || pidRuns(marker.harnessPid)) {
      continue;
    }
    const inst = new Instance(repoRoot, fs.realpathSync(root));
    // The Electron main process has no root in its command line, only in its environment.
    for (const pid of pidsWithDataHome(inst.rootAliases().map((a) => `${a}data`))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    inst.killLeftovers();
    inst.removeRoot(false);
    swept++;
  }
  return swept;
}

function pidsWithDataHome(dataDirs) {
  const tokens = new Set(dataDirs.map((d) => `MOLTENTERM_DATA_HOME=${d}`));
  const pids = [];
  if (process.platform === "linux") {
    for (const name of fs.readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
      try {
        if (hasToken(fs.readFileSync(`/proc/${name}/environ`, "utf8"), tokens)) {
          pids.push(Number(name));
        }
      } catch {
        // not ours to read
      }
    }
  } else {
    const list = (args) =>
      new Map(
        (spawnSync("ps", args, { encoding: "utf8", maxBuffer: 1 << 28 }).stdout ?? "")
          .split("\n")
          .map((l) => l.trim().match(/^(\d+)\s+(.*)$/))
          .filter(Boolean)
          .map((m) => [Number(m[1]), m[2]])
      );
    const plain = list(["-A", "-ww", "-o", "pid=,command="]);
    for (const [pid, withEnv] of list(["-A", "-E", "-ww", "-o", "pid=,command="])) {
      if (hasToken(envPart(withEnv, plain.get(pid)), tokens)) {
        pids.push(pid);
      }
    }
  }
  return pids.filter((pid) => pid !== process.pid);
}

function pidRuns(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

export async function disposeAll(opts) {
  for (const inst of [...Live]) {
    try {
      await inst.dispose(opts);
    } catch (e) {
      console.error(`perf: cleanup of ${inst.root} failed: ${e.message}`);
    }
  }
}

export function liveInstances() {
  return [...Live];
}

let handlersInstalled = false;

// Cleans every live instance up on exit, Ctrl-C, SIGTERM and crashes.
export function installCleanupHandlers(onSignal) {
  if (handlersInstalled) {
    return;
  }
  handlersInstalled = true;
  let cleaning = false;
  const syncCleanup = () => {
    if (cleaning) {
      return;
    }
    cleaning = true;
    for (const load of [...LiveLoads]) {
      load.stop();
    }
    for (const inst of [...Live]) {
      inst.disposeSync();
    }
    onSignal?.();
  };
  process.on("exit", syncCleanup);
  for (const [sig, num] of [
    ["SIGINT", 2],
    ["SIGTERM", 15],
    ["SIGHUP", 1],
  ]) {
    process.on(sig, () => {
      if (cleaning) {
        return;
      }
      console.error(`perf: ${sig}, cleaning up`);
      syncCleanup();
      process.exit(128 + num);
    });
  }
  process.on("uncaughtException", (e) => {
    console.error(e);
    syncCleanup();
    process.exit(1);
  });
}

// Busy processes for the load scenario. Only the children spawned here are ever killed, and each one exits by
// itself if the harness dies without stopping it (its parent pid changes).
const BusyScript =
  "const p = process.ppid; let i = 0; for (;;) { if (++i % 50000000 === 0 && process.ppid !== p) process.exit(0); }";

export class BusyLoad {
  children = [];

  start(n) {
    LiveLoads.add(this);
    for (let i = 0; i < n; i++) {
      this.children.push(spawn(process.execPath, ["-e", BusyScript], { stdio: ["ignore", "ignore", "ignore"] }));
    }
    return this.children.length;
  }

  stop() {
    for (const c of this.children) {
      if (c.exitCode == null) {
        c.kill("SIGKILL");
      }
    }
    this.children = [];
    LiveLoads.delete(this);
  }
}
