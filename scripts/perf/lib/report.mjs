// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Budget evaluation and report rendering for the performance harness (FR-PERF-006, NFR-PERF-007).
//
// Gate rule, per metric in scope:
// - it fails when it regresses from the stored baseline by more than its tolerance (and by more than its noise floor);
// - it fails when it exceeds its budget, unless the baseline was already over the budget and it did not regress
//   (a target not met yet is grandfathered until the story that meets it stores a new baseline);
// - a metric flagged noisy never fails the gate: it is reported for a rerun instead.
// Scope "ci" covers the machine-independent metrics only (gate "ci"); scope "local" adds the measured ones
// (gate "local"), which are only meaningful against a baseline taken on the same machine. Gate "info" is never gated.

import { round } from "./stats.mjs";

export const Scopes = { ci: ["ci"], local: ["ci", "local"] };

function cfg(budgets, id) {
  const m = budgets.metrics[id] ?? {};
  return {
    tolerancePct: m.tolerancePct ?? budgets.defaults?.tolerancePct ?? 10,
    noisePct: m.noisePct ?? budgets.defaults?.noisePct ?? 10,
    noiseFloor: m.noiseFloor ?? 0,
    ...m,
  };
}

export function isNoisy(metric, c) {
  if (metric?.spreadPct == null) {
    return false;
  }
  return metric.spreadPct > c.noisePct && (metric.spreadAbs ?? Infinity) > c.noiseFloor;
}

export function evaluateMetric(id, metric, baselineMetric, budgets, scope) {
  const c = cfg(budgets, id);
  const value = metric?.value;
  const base = baselineMetric?.value;
  const row = {
    id,
    nfr: c.nfr ?? "",
    title: c.title ?? id,
    unit: c.unit ?? "",
    gate: c.gate ?? "info",
    value: value ?? null,
    budget: c.budget ?? null,
    baseline: base ?? null,
    delta: null,
    deltaPct: null,
    spreadPct: metric?.spreadPct ?? null,
    noisy: false,
    status: "n/a",
    fails: false,
  };
  if (value == null) {
    row.status = metric?.error ? "error" : "not measured";
    return row;
  }
  if (base != null) {
    row.delta = round(value - base, 2);
    row.deltaPct = base === 0 ? (value === 0 ? 0 : null) : round((100 * (value - base)) / Math.abs(base), 1);
  }
  row.noisy = isNoisy(metric, c);
  const overBudget = row.budget != null && value > row.budget;
  const allowance = base == null ? 0 : Math.max((Math.abs(base) * c.tolerancePct) / 100, c.noiseFloor);
  const regressed = base != null && value > base + allowance;
  const grandfathered = overBudget && base != null && base > row.budget && !regressed;
  if (regressed) {
    row.status = "regressed";
  } else if (overBudget && grandfathered) {
    row.status = "over budget (as baseline)";
  } else if (overBudget) {
    row.status = "over budget";
  } else {
    row.status = "ok";
  }
  const inScope = (Scopes[scope] ?? []).includes(row.gate);
  row.fails = inScope && !row.noisy && (regressed || (overBudget && !grandfathered));
  if (row.noisy) {
    row.status += ", noisy";
  }
  return row;
}

export function evaluate(report, budgets, baseline, scope = "local") {
  const ids = Object.keys(budgets.metrics);
  const rows = ids.map((id) => evaluateMetric(id, report.metrics[id], baseline?.metrics?.[id], budgets, scope));
  const measured = rows.filter((r) => r.value != null);
  return {
    scope,
    baselineId: baseline?.meta?.id ?? null,
    rows,
    failures: rows.filter((r) => r.fails).map((r) => r.id),
    noisy: rows.filter((r) => r.noisy).map((r) => r.id),
    measured: measured.length,
    pass: rows.every((r) => !r.fails),
  };
}

// Two runs of the same build: a metric whose medians differ by more than the noise threshold (and its floor) is
// flagged noisy (FR-PERF-006-AC3).
export function compareReports(a, b, budgets) {
  const rows = [];
  for (const id of Object.keys(budgets.metrics)) {
    const va = a.metrics[id]?.value;
    const vb = b.metrics[id]?.value;
    if (va == null || vb == null) {
      continue;
    }
    const c = cfg(budgets, id);
    const diff = vb - va;
    const diffPct = va === 0 ? (vb === 0 ? 0 : 100) : (100 * Math.abs(diff)) / Math.abs(va);
    rows.push({
      id,
      unit: c.unit ?? "",
      a: va,
      b: vb,
      diffPct: round(diffPct, 1),
      noisy: diffPct > c.noisePct && Math.abs(diff) > c.noiseFloor,
    });
  }
  return { rows, noisy: rows.filter((r) => r.noisy).map((r) => r.id) };
}

const fmt = (v, unit = "") => (v == null ? "—" : `${v}${unit ? ` ${unit}` : ""}`);
const signed = (v) => (v == null ? "—" : v > 0 ? `+${v}` : `${v}`);

export function renderCompare(cmp, a, b) {
  const lines = [
    `## Same-build comparison`,
    "",
    `A: ${a.meta.id} (${a.meta.startedAt}) — B: ${b.meta.id} (${b.meta.startedAt})`,
    "",
    "| Metric | A | B | Difference | Verdict |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of cmp.rows) {
    lines.push(
      `| ${r.id} | ${fmt(r.a, r.unit)} | ${fmt(r.b, r.unit)} | ${r.diffPct} % | ${r.noisy ? "noisy" : "stable"} |`
    );
  }
  lines.push("", `${cmp.rows.length - cmp.noisy.length} of ${cmp.rows.length} metrics within the noise threshold.`);
  return lines.join("\n");
}

function detailTable(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ];
}

export function renderMarkdown(report, evaluation) {
  const m = report.meta;
  const out = [];
  out.push(`# MoltenTerm performance report`);
  out.push("");
  out.push(
    `Commit \`${m.commit}\`${m.dirty ? " (uncommitted changes)" : ""} · profile \`${m.profile}\` · ${m.startedAt} · ` +
      `${m.durationS} s · ${m.machine.platform}/${m.machine.arch}, ${m.machine.cpu} (${m.machine.cores} cores), ` +
      `${m.machine.memGB} GB · load average ${m.machine.loadAvg} · Electron ${m.electron ?? "?"} · memory: ${m.memoryMethod ?? "?"}`
  );
  out.push("");
  const verdict = evaluation.pass ? "PASS" : `FAIL (${evaluation.failures.join(", ")})`;
  out.push(
    `**Gate (${evaluation.scope} scope): ${verdict}** · baseline \`${evaluation.baselineId ?? "none"}\` · ` +
      `${evaluation.measured} metrics measured${evaluation.noisy.length ? ` · noisy: ${evaluation.noisy.join(", ")}` : ""}`
  );
  out.push("");
  const rows = evaluation.rows.filter((r) => r.value != null || r.status === "error");
  const groups = [...new Set(rows.map((r) => r.nfr || "Other"))];
  for (const g of groups) {
    out.push(`### ${g}`);
    out.push("");
    out.push(
      ...detailTable(
        ["Metric", "Value", "Budget", "Baseline", "Δ", "Spread", "Gate", "Status"],
        rows
          .filter((r) => (r.nfr || "Other") === g)
          .map((r) => [
            r.title,
            fmt(r.value, r.unit),
            fmt(r.budget, r.unit),
            fmt(r.baseline, r.unit),
            r.deltaPct == null ? signed(r.delta) : `${signed(r.delta)} (${signed(r.deltaPct)} %)`,
            r.spreadPct == null ? "—" : `${r.spreadPct} %`,
            r.gate,
            r.fails ? `**${r.status}**` : r.status,
          ])
      )
    );
    out.push("");
  }
  const d = report.details ?? {};
  out.push(`<details><summary>Details</summary>`);
  out.push("");
  if (d.startup) {
    out.push("#### Start-up runs (ms from launch)");
    out.push("");
    out.push(
      ...detailTable(
        ["Run", "wavesrv ready", "Init Bare", "wave-ready", "1st tab view init", "JS evaluated"],
        d.startup.runs.map((r) => [
          r.kind,
          fmt(r.wavesrvReady),
          fmt(r.initBare),
          r.timedOut ? "timeout" : fmt(r.waveReady),
          fmt(r.firstTabviewInitMs),
          fmt(r.jsEvaluatedMB, "MB"),
        ])
      )
    );
    out.push("");
  }
  if (d.idle) {
    out.push("#### Idle CPU (% of one core, median per process kind)");
    out.push("");
    out.push(
      ...detailTable(
        ["Condition", "Total", "Processes", "Per kind", "Window"],
        Object.entries(d.idle).map(([k, v]) => [
          k,
          fmt(v.total?.value, "%"),
          fmt(v.processes),
          Object.entries(v.perKind ?? {})
            .map(([kind, x]) => `${kind} ${x.n}p ${x.cpuMed} %`)
            .join(", "),
          (v.window ?? []).map((w) => `focused=${w.focused} minimized=${w.minimized}`).join("; "),
        ])
      )
    );
    out.push("");
  }
  if (d.memory) {
    out.push("#### Memory (MB)");
    out.push("");
    out.push(
      ...detailTable(
        ["Condition", "Total", "By kind", "Tab views"],
        Object.entries(d.memory).map(([k, v]) => [
          k,
          fmt(v.totalMB),
          Object.entries(v.byKind ?? {})
            .map(([kind, x]) => `${kind} ${x}`)
            .join(", "),
          v.views
            ? `active ${fmt(v.views.activeMB)}, hidden ${(v.views.hiddenMB ?? []).join("/") || "—"}, spare ${(v.views.spareMB ?? []).join("/") || "—"}, webviews ${(v.views.webviewMB ?? []).join("/") || "—"}`
            : "",
        ])
      )
    );
    out.push("");
  }
  if (d.workspaces) {
    out.push("#### Workspace operations (ms)");
    out.push("");
    out.push(
      ...detailTable(
        ["Operation", "Samples"],
        Object.entries(d.workspaces.samples ?? {}).map(([k, v]) => [k, v.map((x) => x ?? "timeout").join(", ") || "—"])
      )
    );
    if (d.workspaces.race) {
      out.push(
        "",
        `Create/delete race: deleted ${d.workspaces.race.foundMs} ms after the create; action queue blocked ${fmt(d.workspaces.race.blockedMs, "ms")}.`
      );
    }
    out.push("");
  }
  if (d.leaks) {
    out.push("#### Leaks");
    out.push("");
    out.push("```json", JSON.stringify(d.leaks, null, 1), "```", "");
  }
  if (d.load) {
    out.push("#### Under load");
    out.push("");
    out.push("```json", JSON.stringify(d.load, null, 1), "```", "");
  }
  if (d.mods) {
    out.push("#### Mods on and off");
    out.push("");
    out.push("```json", JSON.stringify(d.mods, null, 1), "```", "");
  }
  if (d.renderer) {
    out.push("#### Renderer (visible tab, idle)");
    out.push("");
    out.push("```json", JSON.stringify(d.renderer, null, 1), "```", "");
  }
  if (d.bundle) {
    out.push("#### Bundle");
    out.push("");
    out.push(`Up front: ${d.bundle.initial.map((x) => `${x.file} ${x.mb} MB`).join(", ")}.`);
    out.push(`Largest: ${d.bundle.largest.map((x) => `${x.file} ${x.mb} MB`).join(", ")}.`);
    out.push("");
  }
  if (report.errors?.length) {
    out.push("#### Errors");
    out.push("");
    for (const e of report.errors) {
      out.push(`- ${e.scenario}: ${e.message}`);
    }
    out.push("");
  }
  out.push("</details>");
  return out.join("\n");
}
