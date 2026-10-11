// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Renderer measurements over CDP on one page: JS evaluated, Performance.getMetrics deltas and a short trace.

/* global setTimeout */

import fs from "node:fs";
import { round } from "./stats.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Enabling the debugger replays a scriptParsed event for every script already compiled in the page, so the sum of
// their lengths is the JavaScript the tab view has evaluated so far (characters, close to bytes for minified JS).
export async function jsEvaluated(page) {
  const scripts = new Map();
  page.on((d) => {
    if (d.method === "Debugger.scriptParsed" && d.params.url && !d.params.url.startsWith("devtools://")) {
      scripts.set(d.params.scriptId, { url: d.params.url, length: d.params.length ?? 0 });
    }
  });
  await page.send("Debugger.enable");
  await sleep(1000);
  await page.send("Debugger.disable");
  const byFile = {};
  for (const s of scripts.values()) {
    const name = s.url.split("/").pop().split("?")[0];
    byFile[name] = (byFile[name] ?? 0) + s.length;
  }
  const total = Object.values(byFile).reduce((a, b) => a + b, 0);
  const top = Object.entries(byFile)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name, len]) => ({ name, mb: round(len / 1e6, 2) }));
  return { mb: round(total / 1e6, 2), scripts: scripts.size, top };
}

export async function idleMetrics(page, secs = 10) {
  await page.send("Performance.enable");
  const get = async () =>
    Object.fromEntries((await page.send("Performance.getMetrics")).result.metrics.map((m) => [m.name, m.value]));
  const a = await get();
  await sleep(secs * 1000);
  const b = await get();
  await page.send("Performance.disable");
  return {
    windowS: secs,
    taskMsPerS: round((1000 * (b.TaskDuration - a.TaskDuration)) / secs, 2),
    scriptMsPerS: round((1000 * (b.ScriptDuration - a.ScriptDuration)) / secs, 2),
    layoutsPerS: round((b.LayoutCount - a.LayoutCount) / secs, 2),
    styleRecalcsPerS: round((b.RecalcStyleCount - a.RecalcStyleCount) / secs, 2),
    jsHeapMB: round(b.JSHeapUsedSize / 1048576, 1),
    nodes: b.Nodes,
    listeners: b.JSEventListeners,
  };
}

export async function trace(page, secs, outFile) {
  const events = [];
  let done;
  const finished = new Promise((r) => (done = r));
  page.on((d) => {
    if (d.method === "Tracing.dataCollected") {
      events.push(...d.params.value);
    }
    if (d.method === "Tracing.tracingComplete") {
      done();
    }
  });
  await page.send("Tracing.start", {
    categories: "devtools.timeline,disabled-by-default-devtools.timeline,v8.execute,blink.user_timing",
    transferMode: "ReportEvents",
  });
  await sleep(secs * 1000);
  await page.send("Tracing.end");
  await Promise.race([finished, sleep(15000)]);
  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify(events));
  }
  const fn = {};
  for (const e of events) {
    if (e.name === "FunctionCall" && e.args?.data) {
      const k = `${e.args.data.functionName || "(anonymous)"} ${String(e.args.data.url).split("/").pop()}:${e.args.data.lineNumber}`;
      fn[k] = (fn[k] ?? 0) + (e.dur ?? 0);
    }
  }
  return {
    windowS: secs,
    events: events.length,
    timerFiresPerS: round(events.filter((e) => e.name === "TimerFire").length / secs, 2),
    animationFramesPerS: round(events.filter((e) => e.name === "FireAnimationFrame").length / secs, 2),
    topFunctionCalls: Object.entries(fn)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, us]) => `${round(us / 1000, 1)} ms ${k}`),
  };
}
