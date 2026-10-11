#!/usr/bin/env node
// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// MoltenTerm performance harness (FR-PERF-006). See scripts/perf/README.md.
//
//   node scripts/perf/perf.mjs run [--profile full|quick|ci] [--scenarios a,b] [--out dir] [--id name] [--gate ci|local]
//                                [--tmp dir] [--keep] [--baseline file]
//   node scripts/perf/perf.mjs check <report.json> [--scope ci|local] [--baseline file]
//   node scripts/perf/perf.mjs compare <a.json> <b.json>
//   node scripts/perf/perf.mjs baseline <report.json> [--id name]
//
// `run` needs a built app: `task build:backend` and `npm run build:prod` (the `task perf*` targets do both).

/* global console, process */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { disposeAll, installCleanupHandlers } from "./lib/instance.mjs";
import { compareReports, evaluate, renderCompare, renderMarkdown } from "./lib/report.mjs";
import { Profiles, Runners } from "./lib/scenarios.mjs";

const PerfDir = path.dirname(fileURLToPath(import.meta.url));
const RepoRoot = path.resolve(PerfDir, "..", "..");
const BudgetsFile = path.join(PerfDir, "budgets.json");

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split("=", 2);
    if (v != null) {
      opts[k] = v;
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      opts[k] = argv[++i];
    } else {
      opts[k] = true;
    }
  }
  return { pos, opts };
}

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

function loadBudgets() {
  return readJson(BudgetsFile);
}

function loadBaseline(budgets, override) {
  const file = override ? path.resolve(override) : budgets.baseline ? path.join(PerfDir, budgets.baseline) : null;
  if (!file || !fs.existsSync(file)) {
    return null;
  }
  return readJson(file);
}

function git(args) {
  try {
    return execFileSync("git", args, { cwd: RepoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function machine() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus[0]?.model ?? "?",
    cores: cpus.length,
    memGB: Math.round(os.totalmem() / 2 ** 30),
    loadAvg: os
      .loadavg()
      .map((x) => x.toFixed(2))
      .join(" "),
    ci: !!process.env.CI,
  };
}

function electronVersion() {
  try {
    return readJson(path.join(RepoRoot, "node_modules", "electron", "package.json")).version;
  } catch {
    return null;
  }
}

function writeReport(outDir, report, evaluation) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify({ ...report, evaluation }, null, 1));
  fs.writeFileSync(path.join(outDir, "report.md"), renderMarkdown(report, evaluation) + "\n");
}

async function cmdRun(opts) {
  const profileName = opts.profile ?? "full";
  const profile = Profiles[profileName];
  if (!profile) {
    throw new Error(`unknown profile ${profileName} (full, quick, ci)`);
  }
  const scenarios = opts.scenarios ? String(opts.scenarios).split(",") : profile.scenarios;
  for (const s of scenarios) {
    if (!Runners[s]) {
      throw new Error(`unknown scenario ${s} (${Object.keys(Runners).join(", ")})`);
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.resolve(opts.out ?? path.join(RepoRoot, "dist", "perf", `${stamp}-${profileName}`));
  fs.mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  const commit = git(["rev-parse", "--short=8", "HEAD"]);
  const report = {
    meta: {
      id: opts.id ?? commit,
      commit,
      dirty: !!git(["status", "--porcelain", "--untracked-files=no"]),
      profile: profileName,
      scenarios,
      startedAt: new Date(started).toISOString(),
      durationS: null,
      machine: machine(),
      electron: electronVersion(),
      memoryMethod: null,
      settings: profile,
    },
    metrics: {},
    details: { idle: {}, memory: {} },
    errors: [],
  };
  const instances = new Set();
  const ctx = {
    repoRoot: RepoRoot,
    tmpBase: path.resolve(typeof opts.tmp === "string" ? opts.tmp : "/tmp"),
    outDir,
    profile,
    meta: report.meta,
    metrics: report.metrics,
    details: report.details,
    track(inst) {
      instances.add(inst);
      return inst;
    },
    async dispose(inst) {
      instances.delete(inst);
      await inst.dispose({ keep: !!opts.keep });
    },
  };
  installCleanupHandlers();
  for (const s of scenarios) {
    console.error(`perf: scenario ${s}`);
    try {
      await Runners[s](ctx);
    } catch (e) {
      console.error(`perf: scenario ${s} failed: ${e.stack ?? e.message}`);
      report.errors.push({ scenario: s, message: e.message });
    } finally {
      await disposeAll({ keep: !!opts.keep });
    }
  }
  if (!Object.keys(report.details.idle).length) {
    delete report.details.idle;
  }
  if (!Object.keys(report.details.memory).length) {
    delete report.details.memory;
  }
  report.meta.durationS = Math.round((Date.now() - started) / 1000);
  const budgets = loadBudgets();
  const scope = typeof opts.gate === "string" ? opts.gate : "local";
  const evaluation = evaluate(report, budgets, loadBaseline(budgets, opts.baseline), scope);
  writeReport(outDir, report, evaluation);
  console.log(path.join(outDir, "report.md"));
  console.error(
    `perf: ${evaluation.pass ? "PASS" : `FAIL: ${evaluation.failures.join(", ")}`} (${scope} scope), report in ${outDir}`
  );
  if (report.errors.length) {
    console.error(
      `perf: ${report.errors.length} scenario(s) failed: ${report.errors.map((e) => e.scenario).join(", ")}`
    );
  }
  if (opts.gate && (!evaluation.pass || report.errors.length)) {
    return 1;
  }
  return 0;
}

function cmdCheck(pos, opts) {
  const report = readJson(pos[0]);
  const budgets = loadBudgets();
  const scope = typeof opts.scope === "string" ? opts.scope : "local";
  const evaluation = evaluate(report, budgets, loadBaseline(budgets, opts.baseline), scope);
  const md = renderMarkdown(report, evaluation);
  if (opts.md) {
    fs.writeFileSync(opts.md, md + "\n");
  } else {
    console.log(md);
  }
  console.error(`perf: ${evaluation.pass ? "PASS" : `FAIL: ${evaluation.failures.join(", ")}`} (${scope} scope)`);
  return evaluation.pass ? 0 : 1;
}

function cmdCompare(pos, opts) {
  const a = readJson(pos[0]);
  const b = readJson(pos[1]);
  const cmp = compareReports(a, b, loadBudgets());
  const md = renderCompare(cmp, a, b);
  if (opts.md) {
    fs.writeFileSync(opts.md, md + "\n");
  } else {
    console.log(md);
  }
  return 0;
}

// Stores a report as the baseline the gate compares with, and points budgets.json at it.
function cmdBaseline(pos, opts) {
  const report = readJson(pos[0]);
  const id = opts.id ?? report.meta.id;
  if (!/^[\w.-]+$/.test(id)) {
    throw new Error(`invalid baseline id ${id}`);
  }
  report.meta.id = id;
  delete report.evaluation;
  const rel = `baselines/${id}.json`;
  fs.mkdirSync(path.join(PerfDir, "baselines"), { recursive: true });
  fs.writeFileSync(path.join(PerfDir, rel), JSON.stringify(report, null, 1) + "\n");
  const budgets = loadBudgets();
  budgets.baseline = rel;
  fs.writeFileSync(BudgetsFile, JSON.stringify(budgets, null, 4) + "\n");
  console.log(`baseline ${rel} stored; budgets.json points at it`);
  return 0;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opts } = parseArgs(rest);
  switch (cmd) {
    case "run":
      return cmdRun(opts);
    case "check":
      return cmdCheck(pos, opts);
    case "compare":
      return cmdCompare(pos, opts);
    case "baseline":
      return cmdBaseline(pos, opts);
    default:
      console.error("usage: perf.mjs run|check|compare|baseline (see scripts/perf/README.md)");
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`perf: ${e.stack ?? e.message}`);
    process.exit(2);
  }
);
