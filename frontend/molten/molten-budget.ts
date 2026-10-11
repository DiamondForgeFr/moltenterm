// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What each mod costs, and its budget (FR-PERF-014, DS-PERF-012). Every tab view runs its own mods, so a mod that
// keeps working while the user does nothing is paid once per open view: the host measures each mod's script time,
// timers and memory, and reports the one above its budget. Measurement is best-effort and reads the mod's own work
// only: the code the host runs for it (activate, command handlers, box actions, timer callbacks) and the long
// animation frames whose scripts come from its module.

// Idle CPU in % of one core over the window, and the JS heap the mod's activation added.
export const MoltenBudgetCpuPct = 2;
export const MoltenBudgetMemoryMB = 20;
export const MoltenBudgetWindowMs = 30000;
// How often the host compares the mods with their budget while the view shows: an over-budget mod is reported
// within MoltenBudgetWindowMs + MoltenBudgetCheckMs (FR-PERF-014-AC2: within one minute).
export const MoltenBudgetCheckMs = 10000;
// A mod younger than this is not judged on CPU yet: a few milliseconds over a few seconds is not a rate.
export const MoltenBudgetMinSpanMs = 10000;

// Lowercase fields: the tab sends it to `molten mod list --json` (cmd/wsh/cmd/wshcmd-molten.go, MoltenModUsage).
export type MoltenModUsage = {
    // Script time of activate (its synchronous part), ms.
    activatems: number;
    // Script time of everything the host ran for the mod since it activated, ms.
    scriptms: number;
    // Idle CPU over the last window, % of one core: timer callbacks and long-frame scripts, not the commands the
    // user ran.
    cpupct: number;
    // Timers the mod holds now.
    timers: number;
    // JS heap the import and activate added, MB; null when the renderer does not expose it.
    heapmb: number;
    over: boolean;
    // Why it is over, one line, with the numbers.
    reason?: string;
};

type Sample = { at: number; ms: number };

export class MoltenModMeter {
    now: () => number;
    startedAt: number;
    activateMs = 0;
    scriptMs = 0;
    heapMB: number = null;
    timers = 0;
    // Idle work measured by the host (timer callbacks), and long-frame script time attributed to the mod. They
    // overlap (a long timer callback is in both), so the window takes the larger of the two, never their sum.
    idle: Sample[] = [];
    frames: Sample[] = [];

    constructor(now: () => number) {
        this.now = now;
        this.startedAt = now();
    }

    // Runs fn and counts its synchronous time; a promise it returns is not waited for (awaiting is not CPU).
    measure<T>(fn: () => T, idle = false): T {
        const start = this.now();
        try {
            return fn();
        } finally {
            const end = this.now();
            const ms = Math.max(0, end - start);
            this.scriptMs += ms;
            if (idle) {
                this.idle.push({ at: end, ms });
            }
        }
    }

    addLongFrameScript(ms: number, at: number) {
        if (!(ms > 0)) {
            return;
        }
        this.frames.push({ at, ms });
    }

    prune(now: number) {
        const from = now - MoltenBudgetWindowMs;
        this.idle = this.idle.filter((s) => s.at > from);
        this.frames = this.frames.filter((s) => s.at > from);
    }

    // Idle CPU over the window, or over the mod's life when it is younger; null while it is too young to tell.
    cpuPct(now: number): number {
        this.prune(now);
        const span = Math.min(MoltenBudgetWindowMs, now - this.startedAt);
        if (span < MoltenBudgetMinSpanMs) {
            return null;
        }
        const sum = (samples: Sample[]) => samples.reduce((total, s) => total + s.ms, 0);
        return (Math.max(sum(this.idle), sum(this.frames)) / span) * 100;
    }

    usage(now: number): MoltenModUsage {
        const cpu = this.cpuPct(now);
        const verdict = judgeBudget(cpu, this.heapMB);
        return {
            activatems: round(this.activateMs, 1),
            scriptms: round(this.scriptMs, 1),
            cpupct: cpu == null ? 0 : round(cpu, 2),
            timers: this.timers,
            heapmb: this.heapMB == null ? null : round(this.heapMB, 1),
            over: verdict != null,
            ...(verdict != null ? { reason: verdict } : {}),
        };
    }
}

export function judgeBudget(cpuPct: number, heapMB: number): string {
    const reasons: string[] = [];
    if (cpuPct != null && cpuPct > MoltenBudgetCpuPct) {
        reasons.push(
            `${formatPct(cpuPct)} CPU while idle over the last ${MoltenBudgetWindowMs / 1000} s (budget ${MoltenBudgetCpuPct} %)`
        );
    }
    if (heapMB != null && heapMB > MoltenBudgetMemoryMB) {
        reasons.push(`${round(heapMB, 1)} MB of memory at activation (budget ${MoltenBudgetMemoryMB} MB)`);
    }
    return reasons.length === 0 ? null : reasons.join("; ");
}

export function sameUsage(a: MoltenModUsage, b: MoltenModUsage): boolean {
    if (a == null || b == null) {
        return a == b;
    }
    return (
        a.over === b.over &&
        a.reason === b.reason &&
        a.timers === b.timers &&
        a.heapmb === b.heapmb &&
        a.activatems === b.activatems &&
        Math.abs(a.cpupct - b.cpupct) < 0.1 &&
        Math.abs(a.scriptms - b.scriptms) < 50
    );
}

export function formatPct(pct: number): string {
    return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)} %`;
}

function round(value: number, digits: number): number {
    const f = 10 ** digits;
    return Math.round(value * f) / f;
}

// The mod a long-animation-frame script belongs to, from its source: the blob URL the host imported it from, or
// the molten-mod://<id>/ name it gave the module.
export function modIdForScript(sourceURL: string, blobOwners: Map<string, string>): string {
    if (!sourceURL) {
        return null;
    }
    const owner = blobOwners.get(sourceURL);
    if (owner != null) {
        return owner;
    }
    const m = /^molten-mod:\/\/([^/]+)\//.exec(sourceURL);
    return m == null ? null : m[1];
}
