// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The harness scenarios (FR-PERF-006, DS-PERF-001). Each one starts its own isolated instance and disposes of it in
// a finally block; a failing scenario is recorded in the report and the next one still runs.

/* global console, setTimeout */

import fs from "node:fs";
import path from "node:path";
import { analyzeBundle } from "./bundle.mjs";
import { BusyLoad, Instance } from "./instance.mjs";
import { memory, sampleCpu } from "./procs.mjs";
import { idleMetrics, jsEvaluated, trace } from "./renderer.mjs";
import { median, round, single, summarize } from "./stats.mjs";
import { Driver } from "./workspace.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Create/delete loops after which the leaked views are counted (leak.viewsAfterLoops), the same in every profile.
const GatedLoops = 5;
// Memory growth per loop is only comparable over the same number of loops; the CI profile runs fewer and only
// reports it in the details.
const MemLoops = 20;

export const Profiles = {
  full: {
    scenarios: ["bundle", "startup", "session", "leaks", "load", "mods", "working"],
    coldRuns: 3,
    warmRuns: 4,
    settleS: 60,
    samples: 12,
    intervalS: 5,
    minimisedSettleS: 10,
    switchRounds: 2,
    deletes: 4,
    loops: 20,
    loadProcs: 12,
    loadTimeoutS: 30,
    modsSettleS: 30,
    workingSettleS: 30,
    traceS: 5,
  },
  quick: {
    scenarios: ["bundle", "startup", "session", "leaks", "load", "mods", "working"],
    coldRuns: 2,
    warmRuns: 2,
    settleS: 20,
    samples: 6,
    intervalS: 5,
    minimisedSettleS: 5,
    switchRounds: 1,
    deletes: 4,
    loops: 20,
    loadProcs: 8,
    loadTimeoutS: 20,
    modsSettleS: 10,
    workingSettleS: 10,
    traceS: 3,
  },
  // The subset that is stable on CI runners: machine-independent numbers (bundle, JS evaluated, leaked views) and
  // a start-up smoke test. Times are reported but not gated there.
  ci: {
    scenarios: ["bundle", "startup", "leaks"],
    coldRuns: 1,
    warmRuns: 2,
    settleS: 5,
    samples: 0,
    intervalS: 5,
    deletes: 4,
    loops: 5,
    readyTimeoutS: 90,
  },
};

const log = (msg) => console.error(`perf: ${msg}`);

// Memory of the tree, with each tab view's renderer attributed to it (active, hidden, spare) and the webviews.
async function memoryWithViews(inst, driver) {
  const mem = memory(inst.pid);
  let inv = [];
  try {
    inv = await driver.inventory();
  } catch (e) {
    log(`inventory failed: ${e.message}`);
  }
  const byPid = new Map(mem.procs.map((p) => [p.pid, p.mb]));
  const mbOf = (wc) => byPid.get(wc.pid) ?? null;
  const tabViews = inv.filter((w) => w.isTabView);
  const views = {
    activeMB: mbOf(tabViews.find((w) => w.onScreen) ?? {}),
    hiddenMB: tabViews
      .filter((w) => w.tabId && !w.tabId.startsWith("__") && !w.onScreen)
      .map(mbOf)
      .filter((x) => x != null),
    spareMB: tabViews
      .filter((w) => w.tabId == null)
      .map(mbOf)
      .filter((x) => x != null),
    webviewMB: inv
      .filter((w) => w.type === "webview")
      .map(mbOf)
      .filter((x) => x != null),
  };
  return { ...mem, views, procs: undefined };
}

// The programs wavesrv started for its own work (FR-PERF-011, pkg/molten/spawns); null on a build without the counter.
const SpawnsExpr = `TabRpcClient.wshRpcCall("moltenmissionspawns", {}, { route: "molten:mission", timeout: 5000 })`;

async function readSpawns(driver) {
  try {
    return await driver.pageEval(SpawnsExpr);
  } catch {
    return null;
  }
}

// git and gh started per minute between two reads of the counter.
export function spawnsPerMinute(before, after) {
  if (before?.counts == null || after?.counts == null || !(after.at > before.at)) {
    return null;
  }
  const gitGh = (s) => (s.counts.git ?? 0) + (s.counts.gh ?? 0);
  const minutes = (after.at - before.at) / 60000;
  return {
    gitGhPerMin: round((gitGh(after) - gitGh(before)) / minutes, 2),
    totalPerMin: round((after.total - before.total) / minutes, 2),
  };
}

async function idleCondition(ctx, inst, driver, label, { withRenderer = false } = {}) {
  const p = ctx.profile;
  const out = {};
  await driver.stopPoll();
  for (const state of ["visible", "minimised"]) {
    if (state === "minimised") {
      await driver.minimize();
      await sleep(p.minimisedSettleS * 1000);
    }
    const window = await driver.windowState();
    log(`idle ${label} ${state}: sampling ${p.samples} x ${p.intervalS} s`);
    const spawnsBefore = await readSpawns(driver);
    const cpu = await sampleCpu(inst.pid, { samples: p.samples, intervalS: p.intervalS });
    out[state] = { ...cpu, window, spawns: spawnsPerMinute(spawnsBefore, await readSpawns(driver)) };
    ctx.details.idle[`${label} ${state}`] = out[state];
    if (state === "visible") {
      // A few snapshots, so that memory gets a median and a spread like CPU (the GPU process moves the most).
      const snaps = [];
      for (let i = 0; i < (p.memSamples ?? 4); i++) {
        if (i > 0) {
          await sleep(3000);
        }
        snaps.push(await memoryWithViews(inst, driver));
      }
      const hidden = snaps
        .map((m) => (m.views.hiddenMB.length ? median(m.views.hiddenMB) : null))
        .filter((x) => x != null);
      out.memory = {
        total: summarize(snaps.map((m) => m.totalMB)),
        gpu: summarize(snaps.map((m) => m.byKind.gpu).filter((x) => x != null)),
        hiddenView: hidden.length ? summarize(hidden) : single(null),
      };
      ctx.details.memory[label] = snaps.at(-1);
      ctx.meta.memoryMethod = snaps.at(-1).method;
      if (withRenderer) {
        const page = await driver.page();
        try {
          ctx.details.renderer = {
            metrics: await idleMetrics(page, 10),
            trace: await trace(page, p.traceS, path.join(ctx.outDir, "trace-idle-1ws.json")),
          };
        } finally {
          page.close();
        }
      }
    }
  }
  await driver.restore();
  await sleep(1000);
  return out;
}

export async function runBundle(ctx) {
  const b = analyzeBundle(path.join(ctx.repoRoot, "dist", "frontend"));
  ctx.details.bundle = b;
  ctx.metrics["bundle.initialJsMB"] = single(b.initialJsMB);
  ctx.metrics["bundle.jsMB"] = single(b.jsMB);
  ctx.metrics["bundle.jsGzipMB"] = single(b.jsGzipMB);
  ctx.metrics["bundle.cssMB"] = single(b.cssMB);
}

async function launchAndMeasure(ctx, inst, kind, { js = true } = {}) {
  await inst.launch();
  const t = await inst.waitReady((ctx.profile.readyTimeoutS ?? 60) * 1000);
  const run = { kind, ...t, jsEvaluatedMB: null };
  if (!t.timedOut && js) {
    const driver = new Driver(inst);
    try {
      await driver.attach();
      await sleep(3000);
      const page = await driver.page(15000);
      try {
        const js = await jsEvaluated(page);
        run.jsEvaluatedMB = js.mb;
        run.jsTop = js.top;
      } finally {
        page.close();
      }
    } catch (e) {
      run.error = e.message;
    } finally {
      driver.detach();
    }
  }
  ctx.details.startup.runs.push(run);
  log(
    `${kind} start: wave-ready ${t.timedOut ? "timeout" : `${t.waveReady} ms`}, tab view init ${t.firstTabviewInitMs} ms, JS ${run.jsEvaluatedMB} MB`
  );
  return run;
}

export async function runStartup(ctx) {
  const p = ctx.profile;
  ctx.details.startup = { runs: [] };
  for (let i = 0; i < p.coldRuns; i++) {
    const inst = ctx.track(Instance.create(ctx.repoRoot, ctx.tmpBase));
    try {
      await launchAndMeasure(ctx, inst, "cold");
      if (i === 0) {
        for (let j = 0; j < p.warmRuns; j++) {
          await inst.stop();
          await sleep(1000);
          await launchAndMeasure(ctx, inst, "warm");
        }
      }
    } finally {
      await ctx.dispose(inst);
    }
  }
  const runs = ctx.details.startup.runs;
  const ok = (k) => runs.filter((r) => r.kind === k && !r.timedOut);
  ctx.metrics["startup.failedLaunches"] = single(runs.filter((r) => r.timedOut).length);
  ctx.metrics["startup.jsEvaluatedMB"] = summarize(runs.map((r) => r.jsEvaluatedMB).filter((x) => x != null));
  ctx.metrics["startup.waveReadyColdMs"] = summarize(ok("cold").map((r) => r.waveReady));
  ctx.metrics["startup.tabviewInitColdMs"] = summarize(ok("cold").map((r) => r.firstTabviewInitMs));
  ctx.metrics["startup.waveReadyWarmMs"] = summarize(ok("warm").map((r) => r.waveReady));
  ctx.metrics["startup.tabviewInitWarmMs"] = summarize(ok("warm").map((r) => r.firstTabviewInitMs));
}

// Idle at 1, 3 and 6 workspaces, workspace operations, and the create/delete race, in one instance.
export async function runSession(ctx) {
  const p = ctx.profile;
  const samples = opSamples(ctx);
  const inst = ctx.track(Instance.create(ctx.repoRoot, ctx.tmpBase));
  const driver = new Driver(inst);
  try {
    await inst.launch();
    const t = await inst.waitReady();
    if (t.timedOut) {
      throw new Error("the app did not reach wave-ready");
    }
    await driver.attach();
    await sleep(p.settleS * 1000);
    const idle1 = await idleCondition(ctx, inst, driver, "1 ws", { withRenderer: true });
    ctx.metrics["idle.cpu1wsVisiblePct"] = idle1.visible.total;
    ctx.metrics["idle.cpu1wsMinimisedPct"] = idle1.minimised.total;
    if (idle1.visible.spawns != null) {
      ctx.metrics["idle.spawns1wsPerMin"] = single(idle1.visible.spawns.gitGhPerMin);
    }
    ctx.metrics["mem.total1wsMB"] = idle1.memory.total;
    ctx.metrics["renderer.taskMsPerS"] = single(ctx.details.renderer.metrics.taskMsPerS);
    ctx.metrics["renderer.timerFiresPerS"] = single(ctx.details.renderer.trace.timerFiresPerS);

    for (let i = 0; i < 5; i++) {
      const r = await driver.create();
      samples.create.push(r.ms);
      log(`create ${i + 1}: ${r.ms} ms`);
      await driver.waitSpare(r.t0);
      if (i === 1) {
        await sleep(p.settleS * 1000);
        const idle3 = await idleCondition(ctx, inst, driver, "3 ws");
        ctx.metrics["idle.cpu3wsVisiblePct"] = idle3.visible.total;
        ctx.metrics["idle.cpu3wsMinimisedPct"] = idle3.minimised.total;
      }
    }

    // Creating a workspace breaks the cached views of the others (FR-PERF-001); a relaunch gives clean views.
    driver.detach();
    await inst.stop();
    await sleep(1000);
    await inst.launch();
    const relaunch = await inst.waitReady();
    ctx.details.workspaces.relaunch6ws = relaunch;
    await driver.attach();
    await sleep(3000);
    const first = await driver.currentWorkspace();
    const others = (await driver.listWorkspaces()).map((w) => w.id).filter((id) => id !== first);
    for (const ws of others) {
      const r = await driver.switchTo(ws);
      samples.switchNew.push(r.ms);
      log(`switch never visited: ${r.ms} ms`);
      await driver.waitSpare(r.t0);
    }
    for (let i = 0; i < p.switchRounds; i++) {
      for (const ws of [first, ...others]) {
        const r = await driver.switchTo(ws);
        samples.switchVisited.push(r.ms);
        await sleep(300);
      }
    }
    await driver.switchTo(first);
    log(`switch visited: ${samples.switchVisited.join(", ")} ms`);

    await sleep(p.settleS * 1000);
    const idle6 = await idleCondition(ctx, inst, driver, "6 ws");
    ctx.metrics["idle.cpu6wsVisiblePct"] = idle6.visible.total;
    ctx.metrics["idle.cpu6wsMinimisedPct"] = idle6.minimised.total;
    if (idle6.visible.spawns != null) {
      ctx.metrics["idle.spawns6wsPerMin"] = single(idle6.visible.spawns.gitGhPerMin);
    }
    ctx.metrics["mem.total6wsMB"] = idle6.memory.total;
    ctx.metrics["mem.gpu6wsMB"] = idle6.memory.gpu;
    ctx.metrics["mem.hiddenViewMB"] = idle6.memory.hiddenView;

    await driver.startPoll();
    for (const ws of others.slice(0, p.deletes)) {
      const r = await driver.remove(ws);
      samples.delete.push(r.ms);
      log(`delete: ${r.ms} ms`);
      await sleep(500);
    }

    const race = await driver.race();
    ctx.details.workspaces.race = race;
    ctx.metrics["ws.raceBlockedMs"] = single(race.blockedMs);
    log(`race: queue blocked ${race.blockedMs} ms`);
  } finally {
    driver.detach();
    await ctx.dispose(inst);
  }
}

// Tab views whose tab is one of `tabs` (tabs of deleted workspaces) and that are still alive.
function leakedViews(inv, tabs) {
  const tabViews = inv.filter((w) => w.isTabView);
  return {
    tabViews: tabViews.length,
    spares: tabViews.filter((w) => w.tabId == null).length,
    unresponsive: tabViews.filter((w) => typeof w.tabId === "string" && w.tabId.startsWith("__")).length,
    leaked: tabViews.filter((w) => tabs.has(w.tabId)).length,
    webviews: inv.filter((w) => w.type === "webview").length,
  };
}

// Reads the views until two reads a second apart agree, so a destroy still in flight is not counted as a leak.
async function stableLeakedViews(driver, tabs, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  let prev = leakedViews(await driver.inventory(), tabs);
  while (Date.now() < end) {
    await sleep(1000);
    const cur = leakedViews(await driver.inventory(), tabs);
    if (cur.leaked === prev.leaked && cur.tabViews === prev.tabViews) {
      return cur;
    }
    prev = cur;
  }
  return prev;
}

async function createOrThrow(ctx, driver) {
  const r = await driver.create();
  opSamples(ctx).create.push(r.ms);
  if (r.ms == null || !r.workspace) {
    throw new Error("a created workspace never reached the screen: the leak counts would be wrong");
  }
  return r;
}

async function removeOrThrow(ctx, driver, ws) {
  const r = await driver.remove(ws);
  opSamples(ctx).delete.push(r.ms);
  if (r.ms == null) {
    throw new Error(`workspace ${ws} was not deleted within 30 s`);
  }
}

// NFR-PERF-006: views left after deleting workspaces, and over create/delete loops. Views are counted by the tabs
// of the workspaces this scenario deleted.
export async function runLeaks(ctx) {
  const p = ctx.profile;
  const inst = ctx.track(Instance.create(ctx.repoRoot, ctx.tmpBase));
  const driver = new Driver(inst);
  const leaks = {};
  ctx.details.leaks = leaks;
  try {
    await inst.launch();
    const t = await inst.waitReady((p.readyTimeoutS ?? 60) * 1000);
    if (t.timedOut) {
      throw new Error("the app did not reach wave-ready");
    }
    await driver.attach();
    await sleep(3000);
    const first = await driver.currentWorkspace();
    const created = [];
    const deletedTabs = new Set();
    for (let i = 0; i < p.deletes; i++) {
      const r = await createOrThrow(ctx, driver);
      created.push(r);
      await driver.waitSpare(r.t0);
    }
    await driver.switchTo(first);
    await sleep(1000);
    for (const r of created) {
      await removeOrThrow(ctx, driver, r.workspace);
      deletedTabs.add(r.tab);
      await sleep(500);
    }
    leaks.afterDeletes = { deleted: created.length, ...(await stableLeakedViews(driver, deletedTabs)) };
    ctx.metrics["leak.viewsAfterDeletes"] = single(leaks.afterDeletes.leaked);
    log(`leaks after ${created.length} deletes: ${JSON.stringify(leaks.afterDeletes)}`);

    // The view count is read after a fixed number of loops in every profile, so CI and local runs compare with
    // the same baseline: the tab cache evicts old views, so the count per loop depends on the number of loops.
    const before = memory(inst.pid);
    ctx.meta.memoryMethod ??= before.method;
    const memBefore = before.totalMB;
    const loops = Math.max(p.loops, GatedLoops);
    const loopTabs = new Set();
    for (let i = 0; i < loops; i++) {
      const r = await createOrThrow(ctx, driver);
      await driver.waitSpare(r.t0);
      await removeOrThrow(ctx, driver, r.workspace);
      loopTabs.add(r.tab);
      await sleep(500);
      if (i + 1 === GatedLoops) {
        leaks.gatedLoops = { loops: GatedLoops, ...(await stableLeakedViews(driver, new Set(loopTabs))) };
      }
    }
    await sleep(3000);
    const after = leakedViews(await driver.inventory(), new Set([...deletedTabs, ...loopTabs]));
    const memAfter = memory(inst.pid).totalMB;
    leaks.loops = { loops, ...after, memBeforeMB: memBefore, memAfterMB: memAfter };
    ctx.metrics["leak.viewsAfterLoops"] = single(leaks.gatedLoops.leaked);
    if (loops === MemLoops) {
      ctx.metrics["leak.memGrowthPerLoopMB"] = single(round((memAfter - memBefore) / loops, 1));
    }
    log(`leaks after ${loops} loops: ${JSON.stringify(leaks.loops)}`);
  } finally {
    driver.detach();
    await ctx.dispose(inst);
  }
}

// NFR-PERF-005: first tab with N busy processes, and whether the window stays blank.
export async function runLoad(ctx) {
  const p = ctx.profile;
  const inst = ctx.track(Instance.create(ctx.repoRoot, ctx.tmpBase));
  const load = new BusyLoad();
  try {
    await inst.launch();
    await inst.waitReady();
    await inst.stop();
    load.start(p.loadProcs);
    await sleep(3000);
    await inst.launch();
    const t = await inst.waitReady(p.loadTimeoutS * 1000);
    let onScreen = null;
    const driver = new Driver(inst);
    try {
      await driver.attach();
      onScreen = await driver.onScreen();
    } catch (e) {
      log(`load: main process did not answer: ${e.message}`);
    } finally {
      driver.detach();
    }
    load.stop();
    const blank = onScreen == null || onScreen.length === 0 ? 1 : 0;
    ctx.details.load = { busyProcesses: p.loadProcs, timeoutS: p.loadTimeoutS, ...t, onScreen, blank };
    // A timeout is reported as the timeout itself: a lower bound, flagged in the details.
    ctx.metrics["load.firstTabMs"] = single(t.timedOut ? p.loadTimeoutS * 1000 : t.waveReady);
    ctx.metrics["load.blankWindow"] = single(blank);
    log(`load ${p.loadProcs}: wave-ready ${t.timedOut ? "timeout" : `${t.waveReady} ms`}, blank ${blank}`);
  } finally {
    load.stop();
    await ctx.dispose(inst);
  }
}

// Built-in mods on (default) and off: idle CPU, memory and tab view init.
export async function runMods(ctx) {
  const p = ctx.profile;
  const res = {};
  for (const state of ["on", "off"]) {
    const inst = ctx.track(Instance.create(ctx.repoRoot, ctx.tmpBase));
    const driver = new Driver(inst);
    try {
      if (state === "off") {
        inst.writeConfig("molten/mods.json", { enabled: [], disabled: ["copy-box"] });
      }
      await inst.launch();
      const t = await inst.waitReady();
      await driver.attach();
      await sleep(p.modsSettleS * 1000);
      const cpu = await sampleCpu(inst.pid, { samples: p.samples, intervalS: p.intervalS });
      res[state] = { tabviewInitMs: t.firstTabviewInitMs, cpuPct: cpu.total.value, memMB: memory(inst.pid).totalMB };
      log(`mods ${state}: ${JSON.stringify(res[state])}`);
    } finally {
      driver.detach();
      await ctx.dispose(inst);
    }
  }
  ctx.details.mods = res;
  ctx.metrics["mods.cpuDeltaPct"] = single(round(res.on.cpuPct - res.off.cpuPct, 2));
  ctx.metrics["mods.memDeltaMB"] = single(round(res.on.memMB - res.off.memMB, 1));
}

// The focused tab's panels replaced by `count` terminals, each set to the agent state "working" as an agent's hook
// would. They are shell terminals, which draw the panel header, but their "shell" is a script in the instance's root
// that only sleeps: no rc file, no prompt, nothing typed.
const WorkingSetupExpr = (count, shellPath) => `(async () => {
    const tabId = globalStore.get(globalAtoms.staticTabId);
    const tab = await WOS.callBackendService("object", "GetObject", ["tab:" + tabId]);
    const ids = [];
    for (let i = 0; i < ${count}; i++) {
        const oref = await RpcApi.CreateBlockCommand(TabRpcClient, { tabid: tabId,
            blockdef: { meta: { view: "term", controller: "shell", "term:localshellpath": ${JSON.stringify(shellPath)} } } });
        ids.push(String(oref).replace(/^block:/, ""));
    }
    // After the creation: deleting a tab's last panel closes the tab.
    for (const blockid of tab?.blockids ?? []) {
        await RpcApi.DeleteBlockCommand(TabRpcClient, { blockid });
    }
    await new Promise((r) => setTimeout(r, 1500));
    for (const blockid of ids) {
        await TabRpcClient.wshRpcCall("moltenagentstateset", { blockid, state: "working", agent: "claude" },
            { route: "molten:agents", timeout: 5000 });
    }
    return ids.length; })()`;

// The tab activity model reads the window's focus from the main process (DS-PERF-008). The harness never takes the
// user's focus: the window reports itself focused and announces it, which is all a focused window changes for the
// view; Chromium draws a visible window the same, focused or not (#473 checked it against a real focus on the same
// build, 3 agents: 36.3 % emulated, 35.9 % focused).
const EmulateFocusExpr = `(() => { for (const w of require("electron").BaseWindow.getAllWindows()) {
    if (w.isMinimized()) w.restore(); w.showInactive(); w.isFocused = () => true; w.emit("focus"); } return 1; })()`;
const WorkingStateExpr = `(() => ({ activity: globalThis.moltenTabActivity?.state() ?? null,
    motion: document.documentElement.dataset.mtMotion ?? null,
    headers: document.querySelectorAll('[data-role="molten-header-working"]').length,
    animations: document.getAnimations().filter((a) => a.playState === "running").length }))()`;

// The working indicators' budget (#473): the whole app with 3, then 10 agents working on the focused tab.
export async function runWorking(ctx) {
  const p = ctx.profile;
  const inst = ctx.track(Instance.create(ctx.repoRoot, ctx.tmpBase));
  const driver = new Driver(inst);
  const res = {};
  try {
    // Not exec'd: the script's command line names the root, so the clean-up finds it and its sleep.
    const shellPath = path.join(inst.root, "agent-shell.sh");
    fs.writeFileSync(shellPath, "#!/bin/sh\n/bin/sleep 86400\n", { mode: 0o755 });
    await inst.launch();
    const t = await inst.waitReady();
    if (t.timedOut) {
      throw new Error("the app did not reach wave-ready");
    }
    await driver.attach();
    await driver.stopPoll();
    await sleep(3000);
    for (const count of [3, 10]) {
      await driver.pageEval(WorkingSetupExpr(count, shellPath));
      await driver.mainEval(EmulateFocusExpr);
      await sleep(p.workingSettleS * 1000);
      log(`working ${count}: sampling ${p.samples} x ${p.intervalS} s`);
      const cpu = await sampleCpu(inst.pid, { samples: p.samples, intervalS: p.intervalS });
      const view = await driver.pageEval(WorkingStateExpr);
      res[count] = { ...cpu, view };
      log(`working ${count}: ${cpu.total.value} % ${JSON.stringify(view)}`);
      if (view?.activity !== "active" || view?.headers !== count) {
        throw new Error(`working ${count}: the view was ${view?.activity} with ${view?.headers} working headers`);
      }
    }
  } finally {
    driver.detach();
    await ctx.dispose(inst);
  }
  ctx.details.working = res;
  ctx.metrics["working.cpu3Pct"] = res[3].total;
  ctx.metrics["working.cpu10Pct"] = res[10].total;
}

// Workspace operation latencies, pooled across the session and leaks scenarios so that the p95 rests on enough
// samples. An operation that never reached the screen is a null sample: it is counted in ws.failedOps, not in the p95.
function opSamples(ctx) {
  ctx.details.workspaces ??= {};
  ctx.details.workspaces.samples ??= { create: [], switchNew: [], switchVisited: [], delete: [] };
  return ctx.details.workspaces.samples;
}

export function finalize(ctx) {
  const samples = ctx.details.workspaces?.samples;
  if (!samples) {
    return;
  }
  const ops = {
    create: "ws.createP95Ms",
    switchNew: "ws.switchNewP95Ms",
    switchVisited: "ws.switchVisitedP95Ms",
    delete: "ws.deleteP95Ms",
  };
  let failed = 0;
  for (const [op, id] of Object.entries(ops)) {
    if (samples[op].length) {
      ctx.metrics[id] = summarize(samples[op], "p95");
      failed += samples[op].filter((x) => x == null).length;
    }
  }
  ctx.metrics["ws.failedOps"] = single(failed);
}

export const Runners = {
  bundle: runBundle,
  startup: runStartup,
  session: runSession,
  leaks: runLeaks,
  load: runLoad,
  mods: runMods,
  working: runWorking,
};
