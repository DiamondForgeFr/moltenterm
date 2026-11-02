// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    CaptureClock,
    captureDue,
    CaptureMinGapMs,
    CaptureSettleMs,
    CaptureSource,
    CaptureTarget,
    CarpetCapture,
    CarpetCaptureScheduler,
    nextDueInMs,
} from "./carpet-captures";

// A clock whose timers only run when the test advances it.
function fakeClock() {
    let now = 1_000_000;
    let seq = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const clock: CaptureClock = {
        setTimeout: (fn, ms) => {
            seq++;
            timers.set(seq, { at: now + ms, fn });
            return seq;
        },
        clearTimeout: (h) => timers.delete(h),
        now: () => now,
    };
    const advance = async (ms: number) => {
        const until = now + ms;
        for (;;) {
            const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
            if (next == null || next[1].at > until) {
                break;
            }
            timers.delete(next[0]);
            now = next[1].at;
            next[1].fn();
            await flush();
        }
        now = until;
    };
    return { clock, advance, pending: () => timers.size };
}

async function flush() {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

const rect = { x: 0, y: 0, width: 600, height: 800 };

function setup(targets: CaptureTarget[], opts: { atRest?: () => boolean; capture?: () => Promise<string> } = {}) {
    const { clock, advance, pending } = fakeClock();
    const store = new Map<string, CarpetCapture>();
    const calls: CaptureTarget["rect"][] = [];
    const source: CaptureSource = {
        targets: () => targets,
        atRest: opts.atRest ?? (() => true),
        capture: async (r) => {
            calls.push(r);
            return opts.capture ? opts.capture() : "data:image/jpeg;base64,AA==";
        },
    };
    const scheduler = new CarpetCaptureScheduler(
        source,
        clock,
        (id) => store.get(id) ?? null,
        (id, c) => store.set(id, c)
    );
    return { scheduler, store, calls, advance, pending, clock };
}

describe("capture budget (FR-SHELL-065 AC12, DS-SHELL-152)", () => {
    it("captures the columns in view once the carpet has stayed still, one each", async () => {
        const { scheduler, store, calls, advance } = setup([
            { columnId: "a", rect },
            { columnId: "b", rect },
        ]);
        scheduler.noteChange();
        await advance(CaptureSettleMs - 1);
        expect(calls).toHaveLength(0);
        await advance(1);
        expect(calls).toHaveLength(2);
        expect([...store.keys()]).toEqual(["a", "b"]);
        expect(store.get("a")).toMatchObject({ width: 600, height: 800 });
    });

    it("restarts its one timer on every change: a scroll captures nothing until it stops", async () => {
        const { scheduler, calls, advance, pending } = setup([{ columnId: "a", rect }]);
        for (let i = 0; i < 20; i++) {
            scheduler.noteChange();
            await advance(16);
        }
        expect(calls).toHaveLength(0);
        expect(pending()).toBe(1);
        await advance(CaptureSettleMs);
        expect(calls).toHaveLength(1);
    });

    it("leaves nothing running at rest once every column is captured", async () => {
        const { scheduler, advance, pending } = setup([{ columnId: "a", rect }]);
        scheduler.noteChange();
        await advance(CaptureSettleMs);
        expect(pending()).toBe(0);
    });

    it("captures a column again at most every CaptureMinGapMs, with one follow-up timer", async () => {
        const { scheduler, calls, advance, pending } = setup([{ columnId: "a", rect }]);
        scheduler.noteChange();
        await advance(CaptureSettleMs);
        scheduler.noteChange();
        await advance(CaptureSettleMs);
        expect(calls).toHaveLength(1);
        expect(pending()).toBe(1);
        await advance(CaptureMinGapMs);
        expect(calls).toHaveLength(2);
        expect(pending()).toBe(0);
    });

    it("stops after its one follow-up even when the columns' captures are staggered", async () => {
        const { scheduler, store, calls, advance, pending, clock } = setup([
            { columnId: "a", rect },
            { columnId: "b", rect },
        ]);
        store.set("a", { url: "x", width: 1, height: 1, at: clock.now() - 1000 });
        scheduler.noteChange();
        await advance(CaptureSettleMs);
        expect(calls).toHaveLength(1);
        await advance(CaptureMinGapMs);
        expect(calls).toHaveLength(2);
        await advance(10 * CaptureMinGapMs);
        expect(calls).toHaveLength(2);
        expect(pending()).toBe(0);
    });

    it("waits while the carpet is not at rest (a drag, a glide, a hidden window)", async () => {
        let rest = false;
        const { scheduler, calls, advance } = setup([{ columnId: "a", rect }], { atRest: () => rest });
        scheduler.noteChange();
        await advance(3 * CaptureSettleMs);
        expect(calls).toHaveLength(0);
        rest = true;
        await advance(CaptureSettleMs);
        expect(calls).toHaveLength(1);
    });

    it("drops a capture taken while the carpet moved: it may show a half-moved frame", async () => {
        let resolve: (url: string) => void;
        const { scheduler, store, advance } = setup([{ columnId: "a", rect }], {
            capture: () => new Promise((r) => (resolve = r)),
        });
        scheduler.noteChange();
        await advance(CaptureSettleMs);
        scheduler.noteChange();
        resolve("data:image/jpeg;base64,AA==");
        await flush();
        expect(store.size).toBe(0);
        await advance(CaptureSettleMs);
        resolve("data:image/jpeg;base64,BB==");
        await flush();
        expect(store.get("a")?.url).toBe("data:image/jpeg;base64,BB==");
    });

    it("keeps nothing after it is disposed", async () => {
        const { scheduler, calls, advance, pending } = setup([{ columnId: "a", rect }]);
        scheduler.noteChange();
        scheduler.dispose();
        await advance(CaptureSettleMs);
        expect(calls).toHaveLength(0);
        expect(pending()).toBe(0);
    });

    it("says when a capture is due", () => {
        const at = 5000;
        expect(captureDue(null, at)).toBe(true);
        expect(captureDue({ url: "x", width: 1, height: 1, at }, at + CaptureMinGapMs - 1)).toBe(false);
        expect(captureDue({ url: "x", width: 1, height: 1, at }, at + CaptureMinGapMs)).toBe(true);
        expect(nextDueInMs([{ url: "x", width: 1, height: 1, at }], at + 1000)).toBe(CaptureMinGapMs - 1000);
        expect(nextDueInMs([], at)).toBeNull();
    });
});
