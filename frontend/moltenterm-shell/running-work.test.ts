// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The running-work reading (FR-MC-019; FR-BOSS-009, AC85, #2233): one reading for the notification panel and the
// activity source, kept current by the run and CI events, with no timer of its own.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
    handlers: new Map<string, () => void>(),
    unsubscribed: [] as string[],
    calls: 0,
    // What the next call answers; a function lets a test hold an answer back.
    answer: (() => Promise.resolve([])) as () => Promise<unknown>,
}));

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (sub: { eventType: string; handler: () => void }) => {
        m.handlers.set(sub.eventType, sub.handler);
        return () => {
            m.unsubscribed.push(sub.eventType);
            m.handlers.delete(sub.eventType);
        };
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({
    TabRpcClient: {
        wshRpcCall: () => {
            m.calls++;
            return m.answer();
        },
    },
}));
vi.mock("@/util/util", () => ({
    fireAndForget: (f: () => Promise<void>) => {
        void f();
    },
}));
vi.mock("./mission/mission-client", () => ({
    MissionRouteId: "molten:mission",
    MissionRunEvent: "molten:mission:run",
    MissionCiEvent: "molten:mission:ci",
    ciCancel: vi.fn(),
    missionCancel: vi.fn(),
}));
vi.mock("./tab-activity", () => ({
    TabActivity: { getInstance: () => ({ every: () => () => {} }) },
    whileShown: (ms: number) => ({ shown: ms }),
}));
vi.mock("./update/update-store", async () => {
    const jotai = await import("jotai");
    return { GoldUpdateModel: { getInstance: () => ({ busyAtom: jotai.atom(false) }) } };
});
vi.mock("./i18n/i18n", () => ({ t: (key: string) => key }));

import { globalStore } from "@/app/store/jotaiStore";
import { RunningWork, WorkItem } from "./running-work";
import { reconnectHandler } from "./ws-resubscribe";

const src = readFileSync(fileURLToPath(new URL("./running-work.ts", import.meta.url)), "utf8");

const build = (id: string): WorkItem => ({
    id,
    kind: "build",
    dir: "/work/p",
    title: "Build",
    startedat: 1,
    progress: -1,
});

function items(): WorkItem[] {
    return globalStore.get(RunningWork.getInstance().itemsAtom);
}

// Lets the reads that are due finish.
async function settle() {
    await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
    vi.useFakeTimers();
    RunningWork.resetInstance();
    m.handlers.clear();
    m.unsubscribed = [];
    m.calls = 0;
    m.answer = () => Promise.resolve([]);
});

afterEach(() => {
    RunningWork.resetInstance();
    vi.useRealTimers();
});

describe("the running-work reading", () => {
    it("reads once when the first watcher comes and listens to the run and CI events", async () => {
        m.answer = () => Promise.resolve([build("a")]);
        const source = RunningWork.getInstance();
        const stop = source.watch();
        await settle();
        expect(m.calls).toBe(1);
        expect(items().map((i) => i.id)).toEqual(["a"]);
        expect([...m.handlers.keys()].sort()).toEqual(["molten:mission:ci", "molten:mission:run"]);
        const second = source.watch();
        await settle();
        expect(m.calls).toBe(1);
        second();
        stop();
    });

    it("reads again after one pause for a burst of events, never more than once", async () => {
        const source = RunningWork.getInstance();
        const stop = source.watch();
        await settle();
        m.answer = () => Promise.resolve([build("b")]);
        for (let i = 0; i < 5; i++) {
            m.handlers.get("molten:mission:run")();
            m.handlers.get("molten:mission:ci")();
        }
        await settle();
        expect(m.calls).toBe(1);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(m.calls).toBe(2);
        expect(items().map((i) => i.id)).toEqual(["b"]);
        stop();
    });

    it("reads again after a reconnect, which may have lost events", async () => {
        const stop = RunningWork.getInstance().watch();
        await settle();
        m.answer = () => Promise.resolve([build("c")]);
        reconnectHandler(
            () => {},
            () => {}
        )();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(m.calls).toBe(2);
        expect(items().map((i) => i.id)).toEqual(["c"]);
        stop();
    });

    it("lets go of the events when the last watcher leaves, and starts no timer on its own", async () => {
        const source = RunningWork.getInstance();
        const first = source.watch();
        const second = source.watch();
        await settle();
        first();
        first();
        expect(m.unsubscribed).toEqual([]);
        m.handlers.get("molten:mission:run")();
        second();
        expect(m.unsubscribed.sort()).toEqual(["molten:mission:ci", "molten:mission:run"]);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(m.calls).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps the same reading when nothing changed, and the last one when the call fails", async () => {
        m.answer = () => Promise.resolve([build("d")]);
        const source = RunningWork.getInstance();
        const stop = source.watch();
        await settle();
        const before = items();
        await source.refresh();
        expect(items()).toBe(before);
        m.answer = () => Promise.reject(new Error("wavesrv is away"));
        await source.refresh();
        expect(items()).toBe(before);
        stop();
    });

    it("drops the answer of an older ask that comes after a newer one", async () => {
        const source = RunningWork.getInstance();
        let releaseOld: (value: unknown) => void;
        m.answer = () => new Promise((resolve) => (releaseOld = resolve));
        const old = source.refresh();
        m.answer = () => Promise.resolve([build("new")]);
        await source.refresh();
        releaseOld([build("old")]);
        await old;
        expect(items().map((i) => i.id)).toEqual(["new"]);
    });

    it("has no interval and no poll in the reading itself: only the panel's own hook polls", () => {
        const reading = src.slice(
            src.indexOf("export class RunningWork"),
            src.indexOf("export function useRunningWork")
        );
        expect(reading).not.toMatch(/setInterval|\.every\(|TabActivity/);
        const hook = src.slice(src.indexOf("export function useRunningWork"));
        expect(hook).toContain("TabActivity.getInstance().every(");
    });
});
