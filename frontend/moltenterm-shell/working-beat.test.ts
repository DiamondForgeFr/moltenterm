// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ActivityPolicy, ActivityScheduler, ActivityState, SchedulerClock } from "./tab-activity-model";
import { WorkingBeat, WorkingBeatMs, WorkingBeatPolicy } from "./working-beat";

function fakeClock() {
    let now = 0;
    let nextId = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const clock: SchedulerClock = {
        now: () => now,
        setTimeout: (fn, ms) => {
            const id = nextId++;
            timers.set(id, { at: now + ms, fn });
            return id as any;
        },
        clearTimeout: (id) => {
            timers.delete(id as any);
        },
    };
    const advance = (ms: number) => {
        const end = now + ms;
        for (;;) {
            const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (due == null) {
                break;
            }
            timers.delete(due[0]);
            now = due[1].at;
            due[1].fn();
        }
        now = end;
    };
    return { clock, advance, armed: () => timers.size };
}

function setup(state: ActivityState = "active") {
    const { clock, advance, armed } = fakeClock();
    const scheduler = new ActivityScheduler(state, clock);
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    let reduced = false;
    const beat = WorkingBeat.makeForTest(
        (policy: ActivityPolicy, run: () => void, label: string) => scheduler.every(policy, run, label),
        () => reduced,
        () => root
    );
    return {
        beat,
        scheduler,
        advance,
        armed,
        phase: () => root.dataset.mtBeat,
        setReduced: (v: boolean) => (reduced = v),
    };
}

describe("working beat (#473)", () => {
    it("steps through 4 phases, one per second, while an indicator holds it", () => {
        const t = setup();
        const release = t.beat.retain();
        expect(t.phase()).toBeUndefined();
        const seen: string[] = [];
        for (let i = 0; i < 5; i++) {
            t.advance(WorkingBeatMs);
            seen.push(t.phase());
        }
        expect(seen).toEqual(["1", "2", "3", "0", "1"]);
        release();
    });

    it("is one clock however many indicators hold it", () => {
        const t = setup();
        const releases = Array.from({ length: 10 }, () => t.beat.retain());
        expect(t.armed()).toBe(1);
        expect(t.scheduler.armedLabels()).toEqual(["working-beat"]);
        releases.slice(0, 9).forEach((r) => r());
        expect(t.armed()).toBe(1);
        releases[9]();
        expect(t.armed()).toBe(0);
    });

    it("stops and clears the phase when the last indicator goes, and a release counts once", () => {
        const t = setup();
        const a = t.beat.retain();
        const b = t.beat.retain();
        t.advance(WorkingBeatMs);
        a();
        a();
        expect(t.armed()).toBe(1);
        b();
        expect(t.armed()).toBe(0);
        expect(t.phase()).toBeUndefined();
        t.advance(WorkingBeatMs * 4);
        expect(t.phase()).toBeUndefined();
    });

    it("runs only while the view is active (FR-PERF-009-AC4)", () => {
        for (const state of ["visible", "hidden", "minimized"] as ActivityState[]) {
            const t = setup(state);
            t.beat.retain();
            expect(t.armed(), state).toBe(0);
            t.advance(WorkingBeatMs * 4);
            expect(t.phase(), state).toBeUndefined();
        }
        expect(WorkingBeatPolicy).toEqual({ active: WorkingBeatMs, visible: null });
    });

    it("resumes when the view becomes active again", () => {
        const t = setup("visible");
        t.beat.retain();
        t.scheduler.setState("active");
        t.advance(WorkingBeatMs);
        expect(t.phase()).not.toBeUndefined();
    });

    it("writes no phase under reduced motion, so the indicators keep their static look", () => {
        const t = setup();
        t.beat.retain();
        t.advance(WorkingBeatMs);
        expect(t.phase()).toBe("1");
        t.setReduced(true);
        t.advance(WorkingBeatMs);
        expect(t.phase()).toBeUndefined();
    });
});

describe("working indicators' CSS (#473)", () => {
    const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");
    const shell = read("moltenterm-shell.css");
    const header = read("header/header.css");
    const tabBar = read("tab-bar.css");

    it("runs no infinite animation of their own", () => {
        expect(tabBar).not.toMatch(/infinite/);
        expect(header).not.toMatch(/infinite/);
        const working = /\[data-mt-agent-state="working"\]::after \{([^}]*)\}/.exec(shell)[1];
        expect(working).not.toContain("animation");
    });

    it("changes only opacity or a transform on the beat, never blur, shadow, filter or layout", () => {
        const bodies = [...(shell + header).matchAll(/([^{}]*\[data-mt-beat[^{]*)\{([^}]*)\}/g)];
        expect(bodies.length).toBeGreaterThanOrEqual(7);
        for (const [, selector, body] of bodies) {
            const props = body
                .split(";")
                .map((d) => d.trim().split(":")[0].trim())
                .filter(Boolean);
            for (const prop of props) {
                // display: the header segment appears once, when the beat starts.
                expect(["opacity", "transform", "display"], selector.trim()).toContain(prop);
            }
        }
    });

    it("draws working as a ring and waiting as a filled dot, on the rail as on the tab", async () => {
        const { AgentStateDotClasses } = await import("./agent-state-model");
        expect(AgentStateDotClasses.working).toContain("border-2");
        expect(AgentStateDotClasses.working).not.toMatch(/\bbg-/);
        expect(AgentStateDotClasses.waiting).toContain("bg-[var(--mt-state-waiting)]");
        expect(tabBar).toMatch(/\.molten-tab-dot\[data-state="working"\] \{\s*border: 2px solid/);
        expect(tabBar).toMatch(/\.molten-tab-dot\[data-state="waiting"\] \{\s*background:/);
    });
});
