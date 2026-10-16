// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ store: null as any, entriesAtom: null as any, requested: [] as string[][] }));

vi.mock("@/app/store/global", () => ({ getApi: () => null }));
vi.mock("@/app/store/jotaiStore", async () => {
    const { atom, createStore } = await import("jotai");
    env.store = createStore();
    env.entriesAtom = atom([]);
    return { globalStore: env.store };
});
vi.mock("./notifications-store", () => ({
    MoltentermNotifications: {
        getInstance: () => ({
            entriesAtom: env.entriesAtom,
            entries: () => env.store.get(env.entriesAtom),
            requestPanel: (ids: string[]) => env.requested.push(ids),
        }),
    },
}));

import {
    handoffNotifyChanges,
    isOpenHandoffQuestion,
    lastHandoffSystemNotify,
    startHandoffSystemNotifications,
    SystemNotifyApi,
} from "./handoff-system-notify";
import { MoltentermNotification } from "./notifications-model";

function entry(id: string, more: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return {
        id,
        key: `agenthandoff:${id}`,
        source: "agent",
        title: "Camille wants to hand work to Jules",
        message: "projecta → projectb",
        time: 1,
        updated: 1,
        kind: "warning",
        read: false,
        ...more,
    };
}

function fakeApi() {
    const calls = { notify: [] as any[], close: [] as string[], click: null as (id: string) => void };
    const api: SystemNotifyApi = {
        moltentermSystemNotify: async (req) => {
            calls.notify.push(req);
            return "shown";
        },
        moltentermSystemNotifyClose: (id) => calls.close.push(id),
        onMoltentermSystemNotifyClick: (callback) => {
            calls.click = callback;
            return () => {
                calls.click = null;
            };
        },
    };
    return { api, calls };
}

describe("isOpenHandoffQuestion", () => {
    it("is an unanswered handoff question only", () => {
        expect(isOpenHandoffQuestion(entry("a"))).toBe(true);
        expect(isOpenHandoffQuestion(entry("a", { resolved: 5 }))).toBe(false);
        expect(isOpenHandoffQuestion(entry("a", { archived: 5 }))).toBe(false);
        expect(isOpenHandoffQuestion(entry("a", { key: undefined }))).toBe(false);
        expect(isOpenHandoffQuestion(entry("a", { key: "attention:block" }))).toBe(false);
        expect(isOpenHandoffQuestion(null)).toBe(false);
    });
});

describe("handoffNotifyChanges", () => {
    it("asks for new questions and closes the answered ones", () => {
        const asked = new Set(["old", "kept"]);
        const out = handoffNotifyChanges([entry("kept"), entry("new"), entry("old", { resolved: 9 })], asked);
        expect(out.ask.map((e) => e.id)).toEqual(["new"]);
        expect(out.close).toEqual(["old"]);
    });
});

describe("startHandoffSystemNotifications", () => {
    beforeEach(() => {
        env.store.set(env.entriesAtom, []);
        env.requested.length = 0;
        lastHandoffSystemNotify.clear();
    });

    it("does nothing without the API (preview, tests)", () => {
        const stop = startHandoffSystemNotifications(null);
        stop();
    });

    it("asks main once per question, closes it once answered, and opens the panel on the question on click", async () => {
        const { api, calls } = fakeApi();
        env.store.set(env.entriesAtom, [entry("other", { key: "attention:x" })]);
        const stop = startHandoffSystemNotifications(api);
        expect(calls.notify).toEqual([]);

        env.store.set(env.entriesAtom, [entry("q1")]);
        env.store.set(env.entriesAtom, [entry("q1", { updated: 2 })]);
        expect(calls.notify).toEqual([
            { id: "q1", title: "Camille wants to hand work to Jules", body: "projecta → projectb" },
        ]);
        await Promise.resolve();
        expect(lastHandoffSystemNotify.get("q1")).toBe("shown");

        calls.click("q1");
        expect(env.requested).toEqual([["q1"]]);

        env.store.set(env.entriesAtom, [entry("q1", { resolved: 3 })]);
        expect(calls.close).toEqual(["q1"]);
        calls.click("q1");
        expect(env.requested).toHaveLength(1);

        stop();
        expect(calls.click).toBeNull();
    });
});
