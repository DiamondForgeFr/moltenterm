// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The harness scenarios (FR-PERF-006, DS-PERF-001). Each one starts its own isolated instance and disposes of it in
// a finally block; a failing scenario is recorded in the report and the next one still runs.

/* global console, setTimeout */

import path from "node:path";
import { analyzeBundle } from "./bundle.mjs";
import { visiblePage } from "./cdp.mjs";
import { BusyLoad, Instance } from "./instance.mjs";
import { memory, sampleCpu } from "./procs.mjs";
import { idleMetrics, jsEvaluated, trace } from "./renderer.mjs";
import { median, round, single, summarize } from "./stats.mjs";
import { Driver } from "./workspace.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Create/delete loops after which the leaked views are counted (leak.viewsAfterLoops), the same in every profile.
const GatedLoops = 5;

export const Profiles = {
  full: {
    scenarios: ["bundle", "startup", "session", "leaks", "load", "mods"],
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
    traceS: 5,
  },
  quick: {
    scenarios: ["bundle", "startup", "session", "leaks", "load", "mods"],
    coldRuns: 2,
    warmRuns: 2,
    settleS: 20,
    samples: 6,
    intervalS: 5,
    minimisedSettleS: 5,
    switchRounds: 1,
    deletes: 4,
    loops: 5,
    loadProcs: 8,
    loadTimeoutS: 20,
    modsSettleS: 10,
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
    const cpu = await sampleCpu(inst.pid, { samples: p.samples, intervalS: p.intervalS });
    out[state] = { ...cpu, window };
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
        const page = await visiblePage(inst.port, driver.main);
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
      const page = await visiblePage(inst.port, driver.main);
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
  ctx.metrics["startup.failedLaunches"] = single(runs.filter((r) => r.timedOut || r.error).length);
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

function leakedViews(inv, workspaces) {
  const live = new Set(workspaces.flatMap((w) => w.tabs));
  const tabViews = inv.filter((w) => w.isTabView);
  return {
    tabViews: tabViews.length,
    spares: tabViews.filter((w) => w.tabId == null).length,
    unresponsive: tabViews.filter((w) => typeof w.tabId === "string" && w.tabId.startsWith("__")).length,
    leaked: tabViews.filter((w) => w.tabId && !w.tabId.startsWith("__") && !live.has(w.tabId)).length,
    webviews: inv.filter((w) => w.type === "webview").length,
  };
}

// NFR-PERF-006: views left after deleting workspaces, and over create/delete loops.
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
    for (let i = 0; i < p.deletes; i++) {
      const r = await driver.create();
      opSamples(ctx).create.push(r.ms);
      created.push(r.workspace);
      await driver.waitSpare(r.t0);
    }
    await driver.switchTo(first);
    await sleep(1000);
    for (const ws of created) {
      opSamples(ctx).delete.push((await driver.remove(ws)).ms);
      await sleep(500);
    }
    await sleep(3000);
    leaks.afterDeletes = leakedViews(await driver.inventory(), await driver.listWorkspaces());
    leaks.afterDeletes.deleted = created.length;
    ctx.metrics["leak.viewsAfterDeletes"] = single(leaks.afterDeletes.leaked);
    log(`leaks after ${created.length} deletes: ${JSON.stringify(leaks.afterDeletes)}`);

    // The view count is read after a fixed number of loops in every profile, so CI and local runs compare with
    // the same baseline: the tab cache evicts old views, so the count per loop depends on the number of loops.
    const memBefore = memory(inst.pid).totalMB;
    const loops = Math.max(p.loops, GatedLoops);
    for (let i = 0; i < loops; i++) {
      const r = await driver.create();
      opSamples(ctx).create.push(r.ms);
      await driver.waitSpare(r.t0);
      if (r.workspace) {
        opSamples(ctx).delete.push((await driver.remove(r.workspace)).ms);
      }
      await sleep(500);
      if (i + 1 === GatedLoops) {
        await sleep(2000);
        leaks.gatedLoops = {
          loops: GatedLoops,
          ...leakedViews(await driver.inventory(), await driver.listWorkspaces()),
        };
      }
    }
    await sleep(3000);
    const after = leakedViews(await driver.inventory(), await driver.listWorkspaces());
    const memAfter = memory(inst.pid).totalMB;
    leaks.loops = { loops, ...after, memBeforeMB: memBefore, memAfterMB: memAfter };
    ctx.metrics["leak.viewsAfterLoops"] = single(leaks.gatedLoops.leaked - leaks.afterDeletes.leaked);
    ctx.metrics["leak.memGrowthPerLoopMB"] = single(round((memAfter - memBefore) / loops, 1));
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
};
