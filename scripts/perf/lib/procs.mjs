// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Process tree of a launched instance: CPU from cumulative CPU time, memory as macOS footprint (phys_footprint)
// or Linux PSS, falling back to RSS. Only the tree of the pid the harness started is ever looked at.

/* global process, setTimeout */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { mean, median, round, summarize } from "./stats.mjs";

const IsLinux = process.platform === "linux";
const IsMac = process.platform === "darwin";
const ClockTicks = 100;

// "[DD-]HH:MM:SS", "MM:SS.cc" or "HH:MM:SS.cc" -> seconds.
export function parsePsTime(t) {
  let days = 0;
  let rest = t;
  const dash = t.indexOf("-");
  if (dash > 0) {
    days = Number(t.slice(0, dash));
    rest = t.slice(dash + 1);
  }
  const parts = rest.split(":").map(Number);
  let secs = 0;
  for (const p of parts) {
    secs = secs * 60 + p;
  }
  return days * 86400 + secs;
}

export function parsePs(text) {
  return text
    .trim()
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((m) => ({
      pid: +m[1],
      ppid: +m[2],
      zombie: m[3].startsWith("Z"),
      cpuS: parsePsTime(m[4]),
      rssKB: +m[5],
      cmd: m[6],
    }));
}

export function psAll() {
  return parsePs(
    execFileSync("ps", ["-A", "-o", "pid=,ppid=,stat=,time=,rss=,command="], {
      encoding: "utf8",
      maxBuffer: 1 << 26,
    })
  );
}

export function descendants(procs, rootPid) {
  const kids = new Map();
  for (const p of procs) {
    if (!kids.has(p.ppid)) {
      kids.set(p.ppid, []);
    }
    kids.get(p.ppid).push(p);
  }
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const p = byPid.get(id);
    if (p) {
      out.push(p);
    }
    for (const k of kids.get(id) ?? []) {
      stack.push(k.pid);
    }
  }
  return out;
}

// Linux `ps` reports whole seconds only; /proc gives clock ticks.
function linuxCpuS(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(fields[11]) + Number(fields[12])) / ClockTicks;
  } catch {
    return null;
  }
}

export function snapshot(rootPid) {
  const tree = descendants(psAll(), rootPid);
  if (IsLinux) {
    for (const p of tree) {
      p.cpuS = linuxCpuS(p.pid) ?? p.cpuS;
    }
  }
  return tree;
}

export function processKind(p, rootPid) {
  const c = p.cmd;
  if (p.pid === rootPid) {
    return "main";
  }
  if (c.includes("wavesrv")) {
    return "wavesrv";
  }
  if (c.includes("--type=renderer")) {
    return "renderer";
  }
  if (c.includes("--type=gpu-process")) {
    return "gpu";
  }
  if (c.includes("--type=utility")) {
    return c.includes("network.mojom") ? "utility-network" : "utility";
  }
  if (c.includes("--type=zygote")) {
    return "zygote";
  }
  if (/\bwsh\b|wsh-/.test(c)) {
    return "wsh";
  }
  return "other";
}

// CPU in % of one core per kind and in total, over consecutive intervals; memory as RSS (cheap) per sample.
export async function sampleCpu(rootPid, { samples = 12, intervalS = 5 } = {}) {
  const rows = [];
  let prev = snapshot(rootPid);
  let prevT = Date.now();
  for (let i = 0; i < samples; i++) {
    await new Promise((r) => setTimeout(r, intervalS * 1000));
    const cur = snapshot(rootPid);
    const now = Date.now();
    const dt = (now - prevT) / 1000;
    const before = new Map(prev.map((p) => [p.pid, p]));
    const kinds = {};
    let total = 0;
    for (const p of cur) {
      const k = processKind(p, rootPid);
      kinds[k] ??= { n: 0, cpu: 0, rssMB: 0 };
      kinds[k].n++;
      kinds[k].rssMB += p.rssKB / 1024;
      const q = before.get(p.pid);
      if (q) {
        const cpu = (100 * (p.cpuS - q.cpuS)) / dt;
        kinds[k].cpu += cpu;
        total += cpu;
      }
    }
    rows.push({ total, n: cur.length, kinds });
    prev = cur;
    prevT = now;
  }
  const kindNames = [...new Set(rows.flatMap((r) => Object.keys(r.kinds)))].sort();
  const perKind = {};
  for (const k of kindNames) {
    const xs = rows.map((r) => r.kinds[k] ?? { n: 0, cpu: 0, rssMB: 0 });
    perKind[k] = {
      n: median(xs.map((x) => x.n)),
      cpuMed: round(median(xs.map((x) => x.cpu))),
      cpuMean: round(mean(xs.map((x) => x.cpu))),
      rssMB: round(median(xs.map((x) => x.rssMB)), 1),
    };
  }
  return { total: summarize(rows.map((r) => r.total)), processes: median(rows.map((r) => r.n)), perKind };
}

function parseSize(num, unit) {
  const n = Number(num);
  const u = unit.toUpperCase();
  if (u === "B") {
    return n / 1048576;
  }
  if (u === "KB") {
    return n / 1024;
  }
  if (u === "GB") {
    return n * 1024;
  }
  return n;
}

export function parseFootprint(text) {
  const perPid = {};
  for (const line of text.split("\n")) {
    const m = line.match(/\[(\d+)\](?::\s*\d+-bit)?\s+Footprint:\s+([\d.]+)\s*(B|KB|MB|GB)/i);
    if (m) {
      perPid[+m[1]] = parseSize(m[2], m[3]);
    }
  }
  return perPid;
}

function linuxPssMB(pid) {
  try {
    const m = fs.readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").match(/^Pss:\s+(\d+) kB/m);
    return m ? Number(m[1]) / 1024 : null;
  } catch {
    return null;
  }
}

// Memory per pid of the tree in MB, with the method used ("footprint", "pss" or "rss").
export function memory(rootPid) {
  const tree = snapshot(rootPid);
  let perPid = {};
  let method = "rss";
  if (IsMac) {
    try {
      const args = tree.flatMap((p) => ["-p", String(p.pid)]);
      perPid = parseFootprint(
        execFileSync("footprint", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      );
      method = Object.keys(perPid).length ? "footprint" : "rss";
    } catch {
      perPid = {};
    }
  } else if (IsLinux) {
    for (const p of tree) {
      const v = linuxPssMB(p.pid);
      if (v != null) {
        perPid[p.pid] = v;
      }
    }
    method = Object.keys(perPid).length ? "pss" : "rss";
  }
  const procs = tree.map((p) => ({
    pid: p.pid,
    kind: processKind(p, rootPid),
    mb: round(perPid[p.pid] ?? p.rssKB / 1024, 1),
  }));
  const byKind = {};
  for (const p of procs) {
    byKind[p.kind] = round((byKind[p.kind] ?? 0) + p.mb, 1);
  }
  return {
    method,
    totalMB: round(
      procs.reduce((a, p) => a + p.mb, 0),
      1
    ),
    byKind,
    procs,
  };
}
