// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it } from "vitest";
import {
    DiscardRetryMs,
    FreezeDelayMs,
    FreezeRetryMs,
    PageCheck,
    PageProtection,
    readWebviewLifecycleConfig,
    WebviewLifecycleConfig,
    WebviewLifecycleTracker,
} from "./moltenterm-webview-lifecycle-policy";

const Min = 60000;

class FakeClock {
    t = 0;
    timers = new Map<number, { at: number; fn: () => void }>();
    next = 1;

    setTimeout(fn: () => void, ms: number) {
        const id = this.next++;
        this.timers.set(id, { at: this.t + ms, fn });
        return id;
    }

    clearTimeout(id: number) {
        this.timers.delete(id);
    }

    async advance(ms: number) {
        const end = this.t + ms;
        for (;;) {
            const due = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (due == null) {
                break;
            }
            this.timers.delete(due[0]);
            this.t = due[1].at;
            due[1].fn();
            await flush();
        }
        this.t = end;
        await flush();
    }
}

async function flush() {
    for (let i = 0; i < 5; i++) {
        await Promise.resolve();
    }
}

type Page = PageProtection & { check: PageCheck; prompts?: boolean };

function setup(cfg: Partial<WebviewLifecycleConfig> = {}) {
    const clock = new FakeClock();
    const config: WebviewLifecycleConfig = { freeze: true, discardMs: 10 * Min, ...cfg };
    const pages = new Map<number, Page>();
    const calls: string[] = [];
    const page = (id: number, extra: Partial<Page> = {}) => {
        const p: Page = {
            gone: false,
            controlled: false,
            audible: false,
            devtools: false,
            check: { dirty: false, unloadListener: false, scroll: { x: 0, y: 120 } },
            ...extra,
        };
        pages.set(id, p);
        return p;
    };
    const tracker = new WebviewLifecycleTracker({
        now: () => clock.t,
        setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
        clearTimeout: (h) => clock.clearTimeout(h),
        config: () => config,
        protection: (id) => pages.get(id) ?? { gone: true, controlled: false, audible: false, devtools: false },
        freeze: async (id) => {
            calls.push(`freeze ${id}`);
            return pages.get(id)?.check ?? null;
        },
        thaw: async (id) => {
            calls.push(`thaw ${id}`);
        },
        check: async (id) => {
            calls.push(`check ${id}`);
            return pages.get(id)?.check ?? null;
        },
        wouldPromptOnUnload: async (id) => {
            calls.push(`prompt? ${id}`);
            return pages.get(id)?.prompts ?? null;
        },
        discard: (id, scroll) => calls.push(`discard ${id} ${scroll.x},${scroll.y}`),
        log: () => {},
    });
    return { clock, config, page, pages, calls, tracker };
}

describe("hidden page settings (#459)", () => {
    it("freezes and discards after 10 minutes by default", () => {
        expect(readWebviewLifecycleConfig(null)).toEqual({ freeze: true, discardMs: 10 * Min });
    });

    it("0 minutes never discards; false never freezes; bad values fall back", () => {
        expect(readWebviewLifecycleConfig({ "moltenterm:hiddenpagediscardmin": 0 }).discardMs).toBe(0);
        expect(readWebviewLifecycleConfig({ "moltenterm:hiddenpagediscardmin": 2.5 }).discardMs).toBe(150000);
        expect(readWebviewLifecycleConfig({ "moltenterm:hiddenpagediscardmin": -3 }).discardMs).toBe(0);
        expect(readWebviewLifecycleConfig({ "moltenterm:hiddenpagediscardmin": "x" }).discardMs).toBe(10 * Min);
        expect(readWebviewLifecycleConfig({ "moltenterm:hiddenpagefreeze": false }).freeze).toBe(false);
    });
});

describe("hidden page lifecycle (#459)", () => {
    let s: ReturnType<typeof setup>;
    beforeEach(() => {
        s = setup();
    });

    it("does nothing to a page that stays shown", async () => {
        s.page(1);
        s.tracker.report(1, true);
        await s.clock.advance(60 * Min);
        expect(s.calls).toEqual([]);
    });

    it("freezes a hidden page after the delay and thaws it when shown", async () => {
        s.page(1);
        s.tracker.report(1, false);
        await s.clock.advance(FreezeDelayMs - 1);
        expect(s.calls).toEqual([]);
        await s.clock.advance(1);
        expect(s.calls).toEqual(["freeze 1"]);
        s.tracker.report(1, true);
        expect(s.calls).toEqual(["freeze 1", "thaw 1"]);
    });

    it("costs nothing when shown again before the freeze delay", async () => {
        s.page(1);
        s.tracker.report(1, false);
        await s.clock.advance(1000);
        s.tracker.report(1, true);
        await s.clock.advance(60 * Min);
        expect(s.calls).toEqual([]);
    });

    it("discards a page hidden for the delay, with its scroll position (AC2)", async () => {
        s.page(1);
        s.tracker.report(1, false);
        await s.clock.advance(10 * Min);
        expect(s.calls).toEqual(["freeze 1", "discard 1 0,120"]);
    });

    it("discards without freezing when freezing is off, reading the page first", async () => {
        s = setup({ freeze: false });
        s.page(1);
        s.tracker.report(1, false);
        await s.clock.advance(10 * Min);
        expect(s.calls).toEqual(["check 1", "discard 1 0,120"]);
    });

    it("never discards with a delay of 0", async () => {
        s = setup({ discardMs: 0 });
        s.page(1);
        s.tracker.report(1, false);
        await s.clock.advance(120 * Min);
        expect(s.calls).toEqual(["freeze 1"]);
    });

    it("never freezes nor discards a page an agent drives (AC3)", async () => {
        s.page(1, { controlled: true });
        s.tracker.report(1, false);
        await s.clock.advance(120 * Min);
        expect(s.calls).toEqual([]);
    });

    it("never freezes nor discards a page playing audio, and freezes it once the audio stops (AC3)", async () => {
        const p = s.page(1, { audible: true });
        s.tracker.report(1, false);
        await s.clock.advance(30 * Min);
        expect(s.calls).toEqual([]);
        p.audible = false;
        await s.clock.advance(FreezeRetryMs);
        expect(s.calls).toEqual(["freeze 1"]);
        await s.clock.advance(DiscardRetryMs);
        expect(s.calls).toEqual(["freeze 1", "discard 1 0,120"]);
    });

    it("leaves a page with open DevTools alone", async () => {
        s.page(1, { devtools: true });
        s.tracker.report(1, false);
        await s.clock.advance(30 * Min);
        expect(s.calls).toEqual([]);
    });

    it("never discards a page holding typed text", async () => {
        s.page(1, { check: { dirty: true, unloadListener: false, scroll: { x: 0, y: 0 } } });
        s.tracker.report(1, false);
        await s.clock.advance(120 * Min);
        expect(s.calls).toEqual(["freeze 1"]);
        expect(await s.tracker.hasUnsavedWork(1)).toBe(true);
    });

    it("discards a page whose beforeunload listener lets it go, only trying it just before", async () => {
        s.page(1, { check: { dirty: false, unloadListener: true, scroll: { x: 0, y: 0 } }, prompts: false });
        s.tracker.report(1, false);
        await s.clock.advance(FreezeDelayMs);
        expect(s.calls).toEqual(["freeze 1"]);
        await s.clock.advance(10 * Min);
        expect(s.calls).toEqual(["freeze 1", "prompt? 1", "discard 1 0,0"]);
    });

    it("never discards a page whose beforeunload asks to stay, or that cannot tell", async () => {
        s.page(1, { check: { dirty: false, unloadListener: true, scroll: { x: 0, y: 0 } }, prompts: true });
        s.page(2, { check: { dirty: false, unloadListener: true, scroll: { x: 0, y: 0 } } });
        s.tracker.report(1, false);
        s.tracker.report(2, false);
        await s.clock.advance(60 * Min);
        expect(s.calls.filter((c) => c.startsWith("discard"))).toEqual([]);
        expect(await s.tracker.hasUnsavedWork(1)).toBe(true);
        expect(await s.tracker.hasUnsavedWork(2)).toBe(true);
    });

    it("keeps a page that cannot be read, and tries again later", async () => {
        s = setup({ freeze: false });
        const p = s.page(1, { check: null });
        s.tracker.report(1, false);
        await s.clock.advance(10 * Min);
        expect(s.calls).toEqual(["check 1"]);
        p.check = { dirty: false, unloadListener: false, scroll: { x: 0, y: 0 } };
        await s.clock.advance(DiscardRetryMs);
        expect(s.calls).toEqual(["check 1", "check 1", "discard 1 0,0"]);
    });

    it("thaws a frozen page an agent takes", async () => {
        s.page(1);
        s.tracker.report(1, false);
        await s.clock.advance(FreezeDelayMs);
        s.tracker.noteControlled(1);
        expect(s.calls).toEqual(["freeze 1", "thaw 1"]);
    });

    it("forgets a destroyed page", async () => {
        s.page(1);
        s.tracker.report(1, false);
        s.tracker.forget(1);
        await s.clock.advance(60 * Min);
        expect(s.calls).toEqual([]);
        expect(s.tracker.entries.size).toBe(0);
    });

    it("counts the hidden time from when the page was hidden, not from the last report", async () => {
        s.page(1);
        s.tracker.report(1, false);
        await s.clock.advance(5 * Min);
        s.tracker.report(1, false);
        await s.clock.advance(5 * Min);
        expect(s.calls).toContain("discard 1 0,120");
    });

    it("thaws every frozen page when freezing is turned off", async () => {
        s.page(1);
        s.tracker.report(1, false);
        await s.clock.advance(FreezeDelayMs);
        s.config.freeze = false;
        s.tracker.noteConfigChanged();
        expect(s.calls).toEqual(["freeze 1", "thaw 1"]);
    });

    it("applies a shorter discard delay to pages already hidden", async () => {
        s.page(1);
        s.tracker.report(1, false);
        await s.clock.advance(3 * Min);
        s.config.discardMs = 2 * Min;
        s.tracker.noteConfigChanged();
        await s.clock.advance(1);
        expect(s.calls).toEqual(["freeze 1", "discard 1 0,120"]);
    });

    it("answers the budget's unsaved-work question from a frozen page's check or a fresh one", async () => {
        s.page(1);
        expect(await s.tracker.hasUnsavedWork(1)).toBe(false);
        expect(s.calls).toEqual(["check 1"]);
        s.tracker.report(1, false);
        await s.clock.advance(FreezeDelayMs);
        s.calls.length = 0;
        expect(await s.tracker.hasUnsavedWork(1)).toBe(false);
        expect(s.calls).toEqual([]);
        expect(await s.tracker.hasUnsavedWork(99)).toBe(true);
    });
});

describe("a page off-screen on the carpet (#618)", () => {
    let s: ReturnType<typeof setup>;
    beforeEach(() => {
        s = setup();
    });
    const discards = () => s.calls.filter((c) => c.startsWith("discard"));

    it("is frozen like a hidden page but never discarded while on the carpet", async () => {
        s.page(1);
        s.tracker.report(1, false, true);
        await s.clock.advance(FreezeDelayMs);
        expect(s.calls).toEqual(["freeze 1"]);
        await s.clock.advance(60 * Min);
        expect(s.calls).toEqual(["freeze 1"]);
        s.tracker.report(1, true);
        expect(s.calls).toEqual(["freeze 1", "thaw 1"]);
    });

    it("follows moltenterm:hiddenpagefreeze", async () => {
        s = setup({ freeze: false });
        s.page(1);
        s.tracker.report(1, false, true);
        await s.clock.advance(60 * Min);
        expect(s.calls).toEqual([]);
    });

    it("starts the discard delay when it leaves the carpet still hidden, and stops it when laid back", async () => {
        s.page(1);
        s.tracker.report(1, false, true);
        await s.clock.advance(30 * Min);
        s.tracker.report(1, false, false);
        await s.clock.advance(10 * Min - 1);
        expect(discards()).toEqual([]);
        s.tracker.report(1, false, true);
        await s.clock.advance(30 * Min);
        expect(discards()).toEqual([]);
        s.tracker.report(1, false, false);
        await s.clock.advance(10 * Min);
        expect(discards()).toEqual(["discard 1 0,120"]);
    });

    it("drops the discard timer of a hidden page that goes off-screen on the carpet", async () => {
        s.page(1);
        s.tracker.report(1, false);
        await s.clock.advance(5 * Min);
        s.tracker.report(1, false, true);
        await s.clock.advance(30 * Min);
        expect(discards()).toEqual([]);
    });

    it("arms no discard timer on a settings change while on the carpet", async () => {
        s.page(1);
        s.tracker.report(1, false, true);
        s.config.discardMs = 1 * Min;
        s.tracker.noteConfigChanged();
        await s.clock.advance(30 * Min);
        expect(discards()).toEqual([]);
    });
});
