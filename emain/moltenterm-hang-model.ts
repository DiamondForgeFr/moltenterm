// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pure side of the hang watch (#849): which tab view stopped answering Electron main's heartbeat, for how long,
// and the recent events the diagnostics copy. moltenterm-hang-watch.ts wires it to the windows.

export const HangPingMs = 500;
// No answer for this long: the page's thread is stuck, the window ignores clicks.
export const HangStallMs = 2000;
// A stall this long gets the "did not respond" notification once the page answers again.
export const HangNotifyMs = 4000;
// Electron main's own timer late by this much: main was blocked (or the system slept), so a missing answer proves
// nothing about the page.
export const MainLagLogMs = 1000;
// sendSync round trips at least this long are logged (the page waits for Electron main the whole time).
export const SlowSyncIpcMs = 1000;
export const HangEventsKept = 60;

type Target = { seq: number; lastPong: number; outstanding: boolean; stalled: boolean };

export type HangTick = {
    ping: { id: number; seq: number }[];
    stalled: { id: number; ms: number }[];
    // How late Electron main's tick was, when it was late by MainLagLogMs or more.
    mainLagMs: number;
};

export type HangPong = { stalledMs: number };

export class HangWatchModel {
    targets = new Map<number, Target>();
    lastTick = 0;
    paused = false;

    // ids: the web contents to watch now (the active tab view of each shown window).
    tick(now: number, ids: number[]): HangTick {
        const result: HangTick = { ping: [], stalled: [], mainLagMs: 0 };
        if (this.paused) {
            return result;
        }
        const late = this.lastTick > 0 ? now - this.lastTick - HangPingMs : 0;
        this.lastTick = now;
        if (late >= MainLagLogMs) {
            result.mainLagMs = late;
            this.targets.clear();
        }
        const live = new Set(ids);
        for (const id of [...this.targets.keys()]) {
            if (!live.has(id)) {
                this.targets.delete(id);
            }
        }
        for (const id of ids) {
            let target = this.targets.get(id);
            if (target == null) {
                target = { seq: 0, lastPong: now, outstanding: false, stalled: false };
                this.targets.set(id, target);
            }
            if (!target.outstanding) {
                target.seq++;
                target.outstanding = true;
                result.ping.push({ id, seq: target.seq });
                continue;
            }
            const silent = now - target.lastPong;
            if (!target.stalled && silent >= HangStallMs) {
                target.stalled = true;
                result.stalled.push({ id, ms: silent });
            }
        }
        return result;
    }

    // stalledMs: how long the page had been silent, when it had been reported stalled; 0 otherwise.
    pong(id: number, seq: number, now: number): HangPong {
        const target = this.targets.get(id);
        if (target == null || seq !== target.seq) {
            return { stalledMs: 0 };
        }
        const silent = now - target.lastPong;
        const wasStalled = target.stalled;
        target.outstanding = false;
        target.stalled = false;
        target.lastPong = now;
        return { stalledMs: wasStalled ? silent : 0 };
    }

    // System sleep: nothing answers while the machine sleeps, and nothing must be blamed for it.
    pause() {
        this.paused = true;
        this.targets.clear();
    }

    resume() {
        this.paused = false;
        this.lastTick = 0;
        this.targets.clear();
    }
}

export function shouldNotifyStall(ms: number): boolean {
    return ms >= HangNotifyMs;
}

export class HangEventLog {
    lines: string[] = [];
    max: number;

    constructor(max = HangEventsKept) {
        this.max = max;
    }

    add(line: string) {
        this.lines.push(line);
        if (this.lines.length > this.max) {
            this.lines.splice(0, this.lines.length - this.max);
        }
    }

    recent(): string[] {
        return [...this.lines];
    }
}
