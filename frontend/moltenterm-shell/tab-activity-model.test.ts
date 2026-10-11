// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    ActivityInputs,
    ActivityRunReason,
    ActivityScheduler,
    always,
    deriveActivity,
    isShowing,
    periodFor,
    SchedulerClock,
    whileShown,
} from "./tab-activity-model";

function inputs(partial: Partial<ActivityInputs>): ActivityInputs {
    return {
        window: { focused: true, minimized: false, shown: true },
        documentFocused: true,
        documentVisible: true,
        onScreen: true,
        ...partial,
    };
}

// A manual clock: advance() fires the timers due, in order.
class FakeClock implements SchedulerClock {
    t = 0;
    seq = 0;
    timers = new Map<number, { at: number; fn: () => void }>();
    now = () => this.t;
    setTimeout = (fn: () => void, ms: number) => {
        const id = ++this.seq;
        this.timers.set(id, { at: this.t + ms, fn });
        return id;
    };
    clearTimeout = (id: number) => {
        this.timers.delete(id);
    };
    advance(ms: number) {
        const end = this.t + ms;
        for (;;) {
            const next = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (next == null) {
                break;
            }
            this.timers.delete(next[0]);
            this.t = next[1].at;
            next[1].fn();
        }
        this.t = end;
    }
}

function recorder(clock: FakeClock) {
    const runs: { at: number; reason: ActivityRunReason }[] = [];
    return { runs, run: (reason: ActivityRunReason) => runs.push({ at: clock.now(), reason }) };
}

describe("tab activity state", () => {
    it("is active on screen in the focused window", () => {
        expect(deriveActivity(inputs({}))).toBe("active");
    });

    it("is visible on screen in an unfocused window", () => {
        expect(deriveActivity(inputs({ window: { focused: false, minimized: false, shown: true } }))).toBe("visible");
    });

    it("is hidden when another tab or workspace is on screen, or the document is hidden", () => {
        expect(deriveActivity(inputs({ onScreen: false }))).toBe("hidden");
        expect(deriveActivity(inputs({ documentVisible: false }))).toBe("hidden");
    });

    it("is minimized when the window is minimised or not shown, whatever the view", () => {
        expect(deriveActivity(inputs({ window: { focused: false, minimized: true, shown: true } }))).toBe("minimized");
        expect(deriveActivity(inputs({ window: { focused: false, minimized: false, shown: false } }))).toBe(
            "minimized"
        );
        expect(
            deriveActivity(inputs({ onScreen: false, window: { focused: false, minimized: true, shown: true } }))
        ).toBe("minimized");
    });

    it("falls back on the document's focus without a window state", () => {
        expect(deriveActivity(inputs({ window: null, documentFocused: true }))).toBe("active");
        expect(deriveActivity(inputs({ window: null, documentFocused: false }))).toBe("visible");
        expect(deriveActivity(inputs({ window: null, onScreen: false }))).toBe("hidden");
    });

    it("shows only when active or visible", () => {
        expect(["active", "visible", "hidden", "minimized"].map((s) => isShowing(s as any))).toEqual([
            true,
            true,
            false,
            false,
        ]);
    });
});

describe("activity policies", () => {
    it("pause a while-shown job when hidden or minimised", () => {
        const p = whileShown(3000, 10000);
        expect(periodFor(p, "active")).toBe(3000);
        expect(periodFor(p, "visible")).toBe(10000);
        expect(periodFor(p, "hidden")).toBeNull();
        expect(periodFor(p, "minimized")).toBeNull();
        expect(periodFor(whileShown(3000), "visible")).toBe(3000);
    });

    it("keep an always job in every state", () => {
        expect(["active", "visible", "hidden", "minimized"].map((s) => periodFor(always(15000), s as any))).toEqual([
            15000, 15000, 15000, 15000,
        ]);
    });

    it("let minimised differ from hidden", () => {
        expect(periodFor({ active: 1000, hidden: 5000, minimized: null }, "hidden")).toBe(5000);
        expect(periodFor({ active: 1000, hidden: 5000, minimized: null }, "minimized")).toBeNull();
        expect(periodFor({ active: 1000, hidden: 5000 }, "minimized")).toBe(5000);
    });
});

describe("activity scheduler", () => {
    it("runs a job at its period, without a first run", () => {
        const clock = new FakeClock();
        const s = new ActivityScheduler("active", clock);
        const r = recorder(clock);
        s.every(whileShown(3000), r.run);
        clock.advance(2999);
        expect(r.runs).toEqual([]);
        clock.advance(6001);
        expect(r.runs).toEqual([
            { at: 3000, reason: "tick" },
            { at: 6000, reason: "tick" },
            { at: 9000, reason: "tick" },
        ]);
    });

    it("holds no timer while paused and runs at once when it comes back overdue (AC2, AC5)", () => {
        const clock = new FakeClock();
        const s = new ActivityScheduler("active", clock);
        const r = recorder(clock);
        s.every(whileShown(3000), r.run, "pane-status");
        clock.advance(1000);
        s.setState("minimized");
        expect(s.armedLabels()).toEqual([]);
        expect(clock.timers.size).toBe(0);
        clock.advance(60000);
        expect(r.runs).toEqual([]);
        s.setState("active");
        expect(r.runs).toEqual([{ at: 61000, reason: "resume" }]);
        clock.advance(3000);
        expect(r.runs[1]).toEqual({ at: 64000, reason: "tick" });
    });

    it("keeps the remaining delay when it comes back before its period", () => {
        const clock = new FakeClock();
        const s = new ActivityScheduler("active", clock);
        const r = recorder(clock);
        s.every(whileShown(3000), r.run);
        clock.advance(1000);
        s.setState("hidden");
        clock.advance(1000);
        s.setState("active");
        expect(r.runs).toEqual([]);
        clock.advance(1000);
        expect(r.runs).toEqual([{ at: 3000, reason: "tick" }]);
    });

    it("slows down when the window loses the focus and catches up when it gets it back", () => {
        const clock = new FakeClock();
        const s = new ActivityScheduler("active", clock);
        const r = recorder(clock);
        s.every(whileShown(3000, 10000), r.run);
        clock.advance(3000);
        s.setState("visible");
        clock.advance(9999);
        expect(r.runs.length).toBe(1);
        clock.advance(1);
        expect(r.runs[1]).toEqual({ at: 13000, reason: "tick" });
        clock.advance(4000);
        s.setState("active");
        expect(r.runs[2]).toEqual({ at: 17000, reason: "resume" });
    });

    it("keeps an always job running while hidden", () => {
        const clock = new FakeClock();
        const s = new ActivityScheduler("hidden", clock);
        const r = recorder(clock);
        s.every(always(15000), r.run, "lease");
        clock.advance(30000);
        expect(r.runs.map((x) => x.at)).toEqual([15000, 30000]);
        expect(s.armedLabels()).toEqual(["lease"]);
    });

    it("stops a disposed job, even from inside its own run", () => {
        const clock = new FakeClock();
        const s = new ActivityScheduler("active", clock);
        let count = 0;
        const stop = s.every(whileShown(1000), () => {
            count++;
            stop();
        });
        clock.advance(5000);
        expect(count).toBe(1);
        expect(s.jobs.size).toBe(0);
        expect(clock.timers.size).toBe(0);
    });

    it("keeps its timer when a run throws", () => {
        const clock = new FakeClock();
        const s = new ActivityScheduler("active", clock);
        let count = 0;
        s.every(whileShown(1000), () => {
            count++;
            throw new Error("boom");
        });
        clock.advance(3000);
        expect(count).toBe(3);
    });

    it("ignores a state it already has", () => {
        const clock = new FakeClock();
        const s = new ActivityScheduler("active", clock);
        const r = recorder(clock);
        s.every(whileShown(1000), r.run);
        clock.advance(1500);
        s.setState("active");
        expect(r.runs.length).toBe(1);
    });
});
