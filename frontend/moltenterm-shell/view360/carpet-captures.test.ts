// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    CaptureClock,
    captureDue,
    CaptureMaxRetries,
    CaptureMinGapMs,
    CaptureSettleMs,
    CaptureSource,
    CaptureTarget,
    CarpetCapture,
    CarpetCaptureScheduler,
    nextDueInMs,
    registerCarpetScheduler,
    wakeCarpetCaptures,
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

function setup(
    targets: CaptureTarget[],
    opts: {
        atRest?: () => boolean;
        capture?: () => Promise<string>;
        inspect?: (columnId: string) => { tag: string; capturable: boolean };
    } = {}
) {
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
        inspect: opts.inspect,
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

    it("says a capture is due at once when it was taken for another tag", () => {
        const at = 5000;
        const held = { url: "x", width: 1, height: 1, at, tag: "web1@https://a.dev/" };
        expect(captureDue(held, at + 1, CaptureMinGapMs, "web1@https://a.dev/")).toBe(false);
        expect(captureDue(held, at + 1, CaptureMinGapMs, "web1@https://a.dev/next")).toBe(true);
        expect(captureDue(held, at + 1)).toBe(false);
    });
});

describe("thumbnails kept per page (#1814)", () => {
    const good = "data:image/jpeg;base64,AA==";
    const state = (tag: string, capturable = true) => ({ tag, capturable });

    it("takes no capture of a page that is loading, failed, crashed or unloaded, and keeps the previous one", async () => {
        const page = state("web1@https://a.dev/", false);
        const { scheduler, store, calls, advance, pending, clock } = setup([{ columnId: "a", rect }], {
            inspect: () => ({ ...page }),
        });
        const previous = { url: "old", width: 1, height: 1, at: clock.now() - 10 * CaptureMinGapMs, tag: page.tag };
        store.set("a", previous);
        scheduler.noteChange();
        await advance(10 * CaptureSettleMs);
        expect(calls).toHaveLength(0);
        expect(store.get("a")).toBe(previous);
        expect(pending()).toBe(0);
    });

    it("captures the page once the change that made it ready wakes the scheduler", async () => {
        const page = state("web1@https://a.dev/", false);
        const { scheduler, store, calls, advance } = setup([{ columnId: "a", rect }], { inspect: () => ({ ...page }) });
        scheduler.noteChange();
        await advance(CaptureSettleMs);
        expect(calls).toHaveLength(0);
        page.capturable = true;
        scheduler.noteChange();
        await advance(CaptureSettleMs - 1);
        expect(calls).toHaveLength(0);
        await advance(1);
        expect(calls).toHaveLength(1);
        expect(store.get("a")).toMatchObject({ url: good, tag: "web1@https://a.dev/" });
    });

    it("takes a new capture at once when the page's address changed, however recent the old one is", async () => {
        const page = state("web1@https://a.dev/next");
        const { scheduler, store, calls, advance, clock } = setup([{ columnId: "a", rect }], {
            inspect: () => ({ ...page }),
        });
        store.set("a", { url: "old", width: 1, height: 1, at: clock.now(), tag: "web1@https://a.dev/" });
        scheduler.noteChange();
        await advance(CaptureSettleMs);
        expect(calls).toHaveLength(1);
        expect(store.get("a")).toMatchObject({ url: good, tag: "web1@https://a.dev/next" });
    });

    it("refreshes the thumbnail of a page in view when it is older than the gap, as after a restart", async () => {
        const page = state("web1@https://a.dev/");
        const { scheduler, store, calls, advance, clock } = setup([{ columnId: "a", rect }], {
            inspect: () => ({ ...page }),
        });
        store.set("a", { url: "stored", width: 1, height: 1, at: clock.now() - 60 * 60 * 1000, tag: page.tag });
        scheduler.noteChange();
        await advance(CaptureSettleMs - 1);
        expect(store.get("a")?.url).toBe("stored");
        await advance(1);
        expect(calls).toHaveLength(1);
        expect(store.get("a")?.url).toBe(good);
    });

    it("leaves a recent thumbnail of the same page alone: nothing is retaken more often than the gap", async () => {
        const page = state("web1@https://a.dev/");
        const { scheduler, store, calls, advance, clock } = setup([{ columnId: "a", rect }], {
            inspect: () => ({ ...page }),
        });
        store.set("a", { url: "stored", width: 1, height: 1, at: clock.now(), tag: page.tag });
        scheduler.noteChange();
        await advance(CaptureSettleMs);
        expect(calls).toHaveLength(0);
        await advance(CaptureMinGapMs);
        expect(calls).toHaveLength(1);
    });

    it("keeps the previous thumbnail when the main process refuses the frame, and retries a bounded number of times", async () => {
        const page = state("web1@https://a.dev/");
        const { scheduler, store, calls, advance, pending, clock } = setup([{ columnId: "a", rect }], {
            inspect: () => ({ ...page }),
            capture: async () => "",
        });
        const previous = { url: "old", width: 1, height: 1, at: clock.now() - 10 * CaptureMinGapMs, tag: page.tag };
        store.set("a", previous);
        scheduler.noteChange();
        await advance(CaptureSettleMs);
        expect(calls).toHaveLength(1);
        for (let i = 0; i < CaptureMaxRetries; i++) {
            expect(pending()).toBe(1);
            await advance(CaptureMinGapMs);
        }
        expect(calls).toHaveLength(1 + CaptureMaxRetries);
        expect(pending()).toBe(0);
        await advance(10 * CaptureMinGapMs);
        expect(calls).toHaveLength(1 + CaptureMaxRetries);
        expect(store.get("a")).toBe(previous);
    });

    it("keeps the retried capture when the page has painted by then", async () => {
        const page = state("web1@https://a.dev/");
        let answers = [Promise.resolve(""), Promise.resolve(good)];
        const { scheduler, store, advance } = setup([{ columnId: "a", rect }], {
            inspect: () => ({ ...page }),
            capture: () => answers.shift() ?? Promise.resolve(""),
        });
        scheduler.noteChange();
        await advance(CaptureSettleMs);
        expect(store.size).toBe(0);
        await advance(CaptureMinGapMs);
        expect(store.get("a")).toMatchObject({ url: good, tag: page.tag });
        answers = [];
    });

    it("drops a capture taken while the page changed under it: a frame of another page, or a page now loading", async () => {
        const page = state("web1@https://a.dev/");
        let resolve: (url: string) => void;
        const { scheduler, store, calls, advance } = setup([{ columnId: "a", rect }], {
            inspect: () => ({ ...page }),
            capture: () => new Promise((r) => (resolve = r)),
        });
        scheduler.noteChange();
        await advance(CaptureSettleMs);
        expect(calls).toHaveLength(1);
        page.tag = "web1@https://a.dev/next";
        resolve(good);
        await flush();
        expect(store.size).toBe(0);

        page.tag = "web1@https://a.dev/";
        scheduler.noteChange();
        await advance(CaptureSettleMs);
        page.capturable = false;
        resolve(good);
        await flush();
        expect(store.size).toBe(0);
    });

    it("wakes every running scheduler when something that covered the carpet is gone, and none after it is disposed", async () => {
        const a = setup([{ columnId: "a", rect }]);
        const b = setup([{ columnId: "b", rect }]);
        const stopA = registerCarpetScheduler(a.scheduler);
        const stopB = registerCarpetScheduler(b.scheduler);
        wakeCarpetCaptures();
        await a.advance(CaptureSettleMs);
        await b.advance(CaptureSettleMs);
        expect(a.calls).toHaveLength(1);
        expect(b.calls).toHaveLength(1);
        stopB();
        a.store.clear();
        b.store.clear();
        wakeCarpetCaptures();
        await a.advance(CaptureSettleMs);
        await b.advance(CaptureSettleMs);
        expect(a.calls).toHaveLength(2);
        expect(b.calls).toHaveLength(1);
        stopA();
    });

    it("captures the columns that may be captured and skips the others in the same pass", async () => {
        const { scheduler, store, calls, advance } = setup(
            [
                { columnId: "a", rect },
                { columnId: "b", rect },
            ],
            { inspect: (id) => state(id, id === "b") }
        );
        scheduler.noteChange();
        await advance(CaptureSettleMs);
        expect(calls).toHaveLength(1);
        expect([...store.keys()]).toEqual(["b"]);
    });
});
