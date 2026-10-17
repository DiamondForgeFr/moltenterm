// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

/* global process */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initialScripts } from "./lib/bundle.mjs";
import { assertOwnedRoot, Instance, MarkerName, startupTimings } from "./lib/instance.mjs";
import { descendants, parseFootprint, parsePs, parsePsTime } from "./lib/procs.mjs";
import { compareReports, evaluate, evaluateMetric, renderMarkdown } from "./lib/report.mjs";
import { spawnsPerMinute } from "./lib/scenarios.mjs";
import { quantile, splitHalfSpreadPct, summarize } from "./lib/stats.mjs";

const budgets = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "budgets.json"), "utf8"));

describe("stats", () => {
  it("computes quantiles with interpolation", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([10, 20, 30, 40, 50], 0.95)).toBeCloseTo(48);
    expect(quantile([], 0.5)).toBeNull();
  });

  it("reports the split-half spread of interleaved samples", () => {
    expect(splitHalfSpreadPct([10, 10, 10, 10])).toBe(0);
    expect(splitHalfSpreadPct([10, 20, 10, 20, 10, 20])).toBeCloseTo(66.7, 0);
    expect(splitHalfSpreadPct([1, 2, 3])).toBeNull();
  });

  it("summarizes as median or p95", () => {
    const s = summarize([100, 110, 120, 130, 400], "p95");
    expect(s.value).toBe(346);
    expect(s.median).toBe(120);
    expect(s.n).toBe(5);
  });
});

describe("process parsing", () => {
  it("parses ps CPU times on macOS and Linux", () => {
    expect(parsePsTime("0:01.50")).toBeCloseTo(1.5);
    expect(parsePsTime("1:02:03")).toBe(3723);
    expect(parsePsTime("2-00:00:01")).toBe(172801);
  });

  it("walks only the tree under the root pid", () => {
    const procs = parsePs(
      [
        "10 1 S 0:01.00 1000 /x/Electron .",
        "11 10 S 0:00.50 2000 helper --type=renderer",
        "12 11 Z 0:00.10 10 child",
        "20 1 R 0:09.00 10 other",
      ].join("\n")
    );
    expect(
      descendants(procs, 10)
        .map((p) => p.pid)
        .sort()
    ).toEqual([10, 11, 12]);
  });

  it("parses footprint output in any unit", () => {
    const fp = parseFootprint(
      "Electron Helper [47495]: 64-bit    Footprint: 875 MB (16384 bytes per page)\nwavesrv [5]    Footprint: 512 KB (16384 bytes per page)\nGPU [6]    Footprint: 1.5 GB (16384 bytes per page)\nSummary Footprint: 1855 MB"
    );
    expect(fp).toEqual({ 47495: 875, 5: 0.5, 6: 1536 });
  });
});

describe("instance safety", () => {
  it("refuses a directory the harness did not create", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notours-"));
    try {
      expect(() => assertOwnedRoot(dir)).toThrow(/not created by the perf harness/);
      fs.writeFileSync(path.join(dir, MarkerName), JSON.stringify({ root: "/somewhere/else" }));
      expect(() => assertOwnedRoot(dir)).toThrow(/another directory/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates, recognises and removes its own root", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "perfbase-"));
    try {
      const inst = Instance.create(process.cwd(), base);
      expect(assertOwnedRoot(inst.root)).toBe(true);
      expect(fs.existsSync(inst.dataDir)).toBe(true);
      inst.removeRoot();
      expect(fs.existsSync(inst.root)).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("reads start-up milestones from the app log", () => {
    const t0 = new Date("2026-10-11T10:00:00.000").getTime();
    const lines = [
      { t: t0 + 300, s: "wavesrv ready signal" },
      { t: t0 + 1900, s: "tabview init 1400ms" },
      { t: t0 + 2000, s: "wave-ready init time 1200ms" },
      { t: t0 + 4000, s: "tabview init 900ms" },
    ];
    expect(startupTimings(lines, t0)).toMatchObject({
      wavesrvReady: 300,
      waveReady: 2000,
      firstTabviewInitMs: 1400,
      tabviewInits: [1400, 900],
    });
  });
});

describe("bundle", () => {
  it("lists the entry script and its modulepreloads", () => {
    const html = `<script type="module" crossorigin src="./assets/index-A.js"></script>
            <link rel="modulepreload" crossorigin href="./assets/shiki-B.js"><link rel="stylesheet" href="./assets/x.css">`;
    expect(initialScripts(html)).toEqual(["./assets/index-A.js", "./assets/shiki-B.js"]);
  });
});

describe("budget gate", () => {
  const b = {
    defaults: { tolerancePct: 10, noisePct: 10 },
    metrics: {
      js: { budget: 8, gate: "ci" },
      leak: { budget: 0, gate: "ci", tolerancePct: 0 },
      cpu: { budget: 2, gate: "local", noiseFloor: 0.5 },
      info: { budget: null, gate: "info" },
    },
  };

  it("grandfathers a target the baseline did not meet while it does not regress", () => {
    const row = evaluateMetric("js", { value: 31 }, { value: 30.7 }, b, "ci");
    expect(row.status).toBe("over budget (as baseline)");
    expect(row.fails).toBe(false);
  });

  it("fails a regression beyond the tolerance", () => {
    const row = evaluateMetric("js", { value: 34 }, { value: 30.7 }, b, "ci");
    expect(row.status).toBe("regressed");
    expect(row.fails).toBe(true);
    expect(row.deltaPct).toBeCloseTo(10.7, 1);
  });

  it("fails a metric over budget once the baseline met it", () => {
    const row = evaluateMetric("js", { value: 8.5 }, { value: 7.9 }, b, "ci");
    expect(row.fails).toBe(true);
    expect(row.status).toBe("over budget");
  });

  it("fails any new leak when the tolerance is zero", () => {
    expect(evaluateMetric("leak", { value: 5 }, { value: 4 }, b, "ci").fails).toBe(true);
    expect(evaluateMetric("leak", { value: 4 }, { value: 4 }, b, "ci").fails).toBe(false);
    expect(evaluateMetric("leak", { value: 1 }, { value: 0 }, b, "ci").fails).toBe(true);
  });

  it("never grandfathers an absolute budget", () => {
    const strict = { ...b, metrics: { leak: { budget: 0, gate: "ci", tolerancePct: 0, absolute: true } } };
    const row = evaluateMetric("leak", { value: 4 }, { value: 4 }, strict, "ci");
    expect(row.status).toBe("over budget");
    expect(row.fails).toBe(true);
    expect(evaluateMetric("leak", { value: 0 }, { value: 4 }, strict, "ci").fails).toBe(false);
  });

  it("fails the leaked views of the stored baseline's run", () => {
    const leak = { value: 4, stat: "value", n: 1 };
    expect(evaluateMetric("leak.viewsAfterDeletes", leak, leak, budgets, "ci").fails).toBe(true);
  });

  it("gates local metrics only in the local scope", () => {
    expect(evaluateMetric("cpu", { value: 5 }, { value: 3 }, b, "ci").fails).toBe(false);
    expect(evaluateMetric("cpu", { value: 5 }, { value: 3 }, b, "local").fails).toBe(true);
    expect(evaluateMetric("info", { value: 500 }, { value: 1 }, b, "local").fails).toBe(false);
  });

  it("flags a noisy metric and fails it only beyond twice its split-half gap", () => {
    const row = evaluateMetric("cpu", { value: 5, spreadPct: 40, spreadAbs: 2 }, { value: 3 }, b, "local");
    expect(row.noisy).toBe(true);
    expect(row.fails).toBe(false);
    expect(evaluateMetric("cpu", { value: 9, spreadPct: 40, spreadAbs: 2 }, { value: 3 }, b, "local").fails).toBe(true);
    expect(evaluateMetric("cpu", { value: 3, spreadPct: 40, spreadAbs: 0.2 }, { value: 3 }, b, "local").noisy).toBe(
      false
    );
  });

  it("fails a gated metric that a scenario which ran did not produce, and a report with failed scenarios", () => {
    const bs = { ...b, metrics: { js: { budget: 8, gate: "ci", scenario: "startup" } } };
    const base = { metrics: { js: { value: 7 } } };
    const ran = evaluate({ meta: { scenarios: ["startup"] }, metrics: {}, errors: [] }, bs, base, "ci");
    expect(ran.failures).toEqual(["js"]);
    const skipped = evaluate({ meta: { scenarios: ["bundle"] }, metrics: {}, errors: [] }, bs, base, "ci");
    expect(skipped.pass).toBe(true);
    const crashed = evaluate(
      { meta: { scenarios: ["bundle"] }, metrics: {}, errors: [{ scenario: "leaks", message: "x" }] },
      bs,
      base,
      "ci"
    );
    expect(crashed.pass).toBe(false);
  });

  // Except the absolute budgets the baseline's own run did not meet (the leaked views, #895).
  it("passes the stored baseline against itself in both scopes", () => {
    const baseline = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, budgets.baseline), "utf8"));
    const unmet = (scope) =>
      Object.entries(budgets.metrics)
        .filter(([, m]) => m.absolute && (scope === "local" || m.gate === "ci"))
        .filter(([id, m]) => baseline.metrics[id]?.value > m.budget)
        .map(([id]) => id);
    expect(unmet("ci")).toEqual(["leak.viewsAfterDeletes"]);
    for (const scope of ["ci", "local"]) {
      const ev = evaluate(baseline, budgets, baseline, scope);
      expect(ev.failures).toEqual(unmet(scope));
    }
    const met = JSON.parse(JSON.stringify(baseline));
    for (const id of unmet("local")) {
      met.metrics[id].value = 0;
    }
    expect(renderMarkdown(met, evaluate(met, budgets, baseline, "ci"))).toContain("Gate (ci scope): PASS");
  });

  it("defines every metric with an NFR, a title and a known gate", () => {
    for (const [id, m] of Object.entries(budgets.metrics)) {
      expect(m.title, id).toBeTruthy();
      expect(m.nfr, id).toBeTruthy();
      expect(["ci", "local", "info"], id).toContain(m.gate);
      expect(["bundle", "startup", "session", "leaks", "load", "mods", "working"], id).toContain(m.scenario);
    }
  });
});

describe("same-build comparison", () => {
  it("flags metrics whose medians differ by more than the noise threshold", () => {
    const b = { defaults: { noisePct: 10 }, metrics: { a: {}, c: { noiseFloor: 1 }, d: {} } };
    const cmp = compareReports(
      { metrics: { a: { value: 100 }, c: { value: 2 }, d: { value: 10 } } },
      { metrics: { a: { value: 105 }, c: { value: 2.5 }, d: { value: 12 } } },
      b
    );
    expect(cmp.noisy).toEqual(["d"]);
  });
});

describe("spawn counter", () => {
  it("counts git and gh per minute between two reads", () => {
    const before = { at: 0, total: 5, counts: { git: 3, gh: 1, security: 1 } };
    const after = { at: 120000, total: 12, counts: { git: 6, gh: 2, security: 4 } };
    expect(spawnsPerMinute(before, after)).toEqual({ gitGhPerMin: 2, totalPerMin: 3.5 });
  });

  it("is unknown on a build without the counter", () => {
    expect(spawnsPerMinute(null, { at: 1, total: 0, counts: {} })).toBeNull();
    expect(spawnsPerMinute({ at: 5, total: 0, counts: {} }, { at: 5, total: 0, counts: {} })).toBeNull();
  });
});
