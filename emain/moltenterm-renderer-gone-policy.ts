// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Renderer loss recovery (#973, FR-PERF-004): what Electron main decides when a renderer is gone, without Electron.
// A window whose renderer was killed is reloaded, but a renderer that dies again as soon as it loads would loop: the
// reloads of one window are counted over a sliding minute. Renderers killed together are grouped, since a single
// signal reaching several of them at once points at something outside MoltenTerm (a kill or pkill matching them).

export const RendererReloadLimit = 3;
export const RendererReloadWindowMs = 60 * 1000;
// Chromium reports each renderer separately; the ones of one kill arrive within a few milliseconds.
export const KillBurstMs = 1000;

// The reasons Electron gives in render-process-gone that a reload can help with.
const RecoverableReasons = new Set(["killed", "crashed", "oom", "abnormal-exit", "launch-failed", "integrity-failure"]);

const SignalNames: Record<number, string> = {
    1: "SIGHUP",
    2: "SIGINT",
    3: "SIGQUIT",
    6: "SIGABRT",
    9: "SIGKILL",
    11: "SIGSEGV",
    15: "SIGTERM",
};

export function isRecoverableLoss(reason: string): boolean {
    return RecoverableReasons.has(reason);
}

// Chromium reports a renderer ended by a signal as reason "killed" with the signal number as its exit code.
export function signalName(reason: string, exitCode: number): string {
    if (reason !== "killed" || exitCode == null) {
        return null;
    }
    return SignalNames[exitCode] ?? `signal ${exitCode}`;
}

export type ReloadDecision = { reload: true; count: number } | { reload: false; count: number };

export class RendererReloadPolicy {
    reloads = new Map<string, number[]>();

    constructor(
        readonly limit = RendererReloadLimit,
        readonly windowMs = RendererReloadWindowMs
    ) {}

    // A loss of `key`'s renderer at `now`: reload it unless it was reloaded `limit` times within the last window.
    admit(key: string, now: number): ReloadDecision {
        const recent = (this.reloads.get(key) ?? []).filter((at) => now - at < this.windowMs);
        if (recent.length >= this.limit) {
            this.reloads.set(key, recent);
            return { reload: false, count: recent.length };
        }
        recent.push(now);
        this.reloads.set(key, recent);
        return { reload: true, count: recent.length };
    }

    // The developer asked for a reload (or the window went): the count starts again.
    reset(key: string) {
        this.reloads.delete(key);
    }
}

export type GoneRenderer = { pid: number; at: number; signal: string };

export type KillBurst = { pids: number[]; signal: string; spanMs: number; count: number };

// Groups the renderers killed by a signal: the first loss opens a burst of KillBurstMs, closed by `close` (called
// by a timer that long after the first loss).
export class KillBurstDetector {
    current: GoneRenderer[] = [];

    // Whether this loss opened a new burst (the caller then arms the closing timer).
    add(gone: GoneRenderer): boolean {
        if (gone.signal == null) {
            return false;
        }
        const opened = this.current.length === 0;
        this.current.push(gone);
        return opened;
    }

    // The burst, when at least two renderers went to the same signal; null otherwise.
    close(): KillBurst {
        const gone = this.current;
        this.current = [];
        if (gone.length < 2) {
            return null;
        }
        const bySignal = new Map<string, GoneRenderer[]>();
        for (const g of gone) {
            bySignal.set(g.signal, [...(bySignal.get(g.signal) ?? []), g]);
        }
        const [signal, group] = [...bySignal.entries()].sort((a, b) => b[1].length - a[1].length)[0];
        if (group.length < 2) {
            return null;
        }
        const ats = group.map((g) => g.at);
        return {
            signal,
            count: group.length,
            pids: group.map((g) => g.pid).filter((pid) => pid > 0),
            spanMs: Math.max(...ats) - Math.min(...ats),
        };
    }
}

export function killBurstLine(burst: KillBurst, mainSignal: string, freeMemMb: number, totalMemMb: number): string {
    const pids = burst.pids.length > 0 ? burst.pids.join(", ") : "unknown";
    const main = mainSignal != null ? `Electron main caught ${mainSignal}` : "Electron main caught no signal";
    const memory = freeMemMb != null ? `; free memory ${freeMemMb} MB of ${totalMemMb} MB` : "";
    return (
        `external kill: ${burst.count} renderers ended by ${burst.signal} within ${burst.spanMs} ms (pids ${pids}); ` +
        `${main}${memory}; look for a kill or pkill whose pattern matches MoltenTerm's helper processes`
    );
}
