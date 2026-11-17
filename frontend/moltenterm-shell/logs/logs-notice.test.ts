// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const gestures = new Map<string, () => Promise<any>>();
const published: any[] = [];
const resolved: string[] = [];
const written: Record<string, any>[] = [];
const api = {
    onMoltentermLogsHigh: null as (cb: (edge: any) => void) => () => void,
    moltentermLogsListen: null as () => Promise<any>,
    moltentermLogsClear: vi.fn(),
    moltentermShowLog: vi.fn(),
};
let pushed: (edge: any) => void = null;
let clientMeta: Record<string, any> = {};

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/client-model", async () => {
    const { atom } = await import("jotai");
    return { ClientModel: { getInstance: () => ({ clientAtom: atom(() => ({ meta: clientMeta })) }) } };
});
vi.mock("@/app/store/global", () => ({ getApi: () => api }));
vi.mock("../notifications-store", () => ({
    registerNotificationGesture: (name: string, fn: () => Promise<any>) => {
        gestures.set(name, fn);
        return () => gestures.delete(name);
    },
    addMoltentermNotification: (input: any) => published.push(input),
    resolveMoltentermNotification: (key: string) => resolved.push(key),
    MoltentermNotifications: {
        getInstance: () => ({
            write: (update: Record<string, any>) => {
                written.push(update);
                clientMeta = { ...clientMeta, ...update };
            },
        }),
    },
}));

import { LogsClearGesture, LogsNoticeKey, LogsNoticeMetaKey, LogsShowGesture } from "./logs-model";
import { applyLogsEdge, startLogsNotice } from "./logs-notice";

const High = { high: true, total: 1_300_000_000, highMark: 1_000_000_000 };
const Low = { high: false, total: 20_000, highMark: 1_000_000_000 };

beforeEach(() => {
    gestures.clear();
    published.length = 0;
    resolved.length = 0;
    written.length = 0;
    clientMeta = {};
    pushed = null;
    api.moltentermLogsListen = async () => null;
    api.onMoltentermLogsHigh = (cb) => {
        pushed = cb;
        return () => {
            pushed = null;
        };
    };
    api.moltentermLogsClear.mockReset();
    api.moltentermShowLog.mockReset();
});

describe("the note of the logs in Brokk's notes (#2335)", () => {
    it("says it once: the second crossing of the same stretch, from another window or launch, says nothing", () => {
        applyLogsEdge(High);
        expect(published.map((n) => n.key)).toEqual([LogsNoticeKey]);
        expect(written).toEqual([{ [LogsNoticeMetaKey]: true }]);
        applyLogsEdge(High);
        expect(published.length).toBe(1);
    });

    it("settles the note and forgets that it was said when the logs are back under the mark", () => {
        applyLogsEdge(High);
        applyLogsEdge(Low);
        expect(resolved).toEqual([LogsNoticeKey]);
        expect(clientMeta[LogsNoticeMetaKey]).toBeNull();
        applyLogsEdge(High);
        expect(published.length).toBe(2);
    });

    it("says nothing of a reading under the mark that was never over it", () => {
        applyLogsEdge(Low);
        expect(resolved).toEqual([]);
        expect(written).toEqual([]);
        applyLogsEdge(null);
        expect(published).toEqual([]);
    });
});

describe("the window that Electron main tells (#2335)", () => {
    it("takes the edge that waited for it and the ones that follow", async () => {
        api.moltentermLogsListen = async () => High;
        const stop = startLogsNotice();
        await Promise.resolve();
        await Promise.resolve();
        expect(published.length).toBe(1);
        pushed(Low);
        expect(resolved).toEqual([LogsNoticeKey]);
        stop();
        expect(pushed).toBeNull();
    });

    it("registers its two actions and removes them when it stops", () => {
        const stop = startLogsNotice();
        expect([...gestures.keys()].sort()).toEqual([LogsClearGesture, LogsShowGesture].sort());
        stop();
        expect(gestures.size).toBe(0);
    });

    it("does not act on an edge that arrives after it stopped", async () => {
        let give: (edge: any) => void;
        api.moltentermLogsListen = () => new Promise((resolve) => (give = resolve));
        const stop = startLogsNotice();
        stop();
        give(High);
        await Promise.resolve();
        await Promise.resolve();
        expect(published).toEqual([]);
    });

    it("clears from the note and settles it", async () => {
        api.moltentermLogsClear.mockResolvedValue({ ok: true, removed: 4, freed: 9, failed: 0, info: {} });
        startLogsNotice();
        await expect(gestures.get(LogsClearGesture)()).resolves.toEqual({ ok: true, resolve: true });
    });

    it("tells why the note could not clear, and keeps it", async () => {
        startLogsNotice();
        api.moltentermLogsClear.mockResolvedValue({ ok: false, removed: 1, freed: 1, failed: 2, info: {} });
        expect(await gestures.get(LogsClearGesture)()).toMatchObject({
            ok: false,
            error: expect.stringContaining("could not be removed"),
        });
        api.moltentermLogsClear.mockRejectedValue(new Error("gone"));
        expect(await gestures.get(LogsClearGesture)()).toMatchObject({
            ok: false,
            error: expect.stringContaining("could not be cleared"),
        });
    });

    it("shows the folder of the current log", async () => {
        api.moltentermShowLog.mockResolvedValue(undefined);
        startLogsNotice();
        await expect(gestures.get(LogsShowGesture)()).resolves.toEqual({ ok: true });
        expect(api.moltentermShowLog).toHaveBeenCalledTimes(1);
    });
});
