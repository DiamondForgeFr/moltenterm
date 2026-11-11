// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pushed: any[] = [];

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("./notifications-store", async () => {
    const { atom } = await import("jotai");
    const { globalStore } = await import("@/app/store/jotaiStore");
    const entriesAtom = atom([]);
    const model = {
        entriesAtom,
        entries: () => globalStore.get(entriesAtom),
        markRead: vi.fn(),
        open: vi.fn(),
        runAction: vi.fn(),
    };
    return { MoltentermNotifications: { getInstance: () => model } };
});
vi.mock("./toast-store", () => ({
    Toasts: { getInstance: () => ({ push: (t: any) => pushed.push(t), stack: () => [], dismiss: vi.fn() }) },
}));
vi.mock("./agent-seen", async () => {
    const { atom } = await import("jotai");
    return { makeSeenViewAtom: () => atom(null) };
});
vi.mock("./source-in-view", () => ({ notificationInView: () => false }));
vi.mock("./mission/trust-approval-model", () => ({ trustReviewAction: () => null }));

import { globalStore } from "@/app/store/jotaiStore";
import { setBrainstormHold } from "./brainstorm/brainstorm-hold";
import { startNotificationToasts } from "./notification-toasts";
import { ToastCoalesceMs } from "./notification-rules";
import { MoltentermNotifications } from "./notifications-store";

const model = MoltentermNotifications.getInstance() as any;

function entry(id: string, updated: number): any {
    return { id, source: "build", title: `Build ${id}`, kind: "info", time: updated, updated, read: false };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { visibilityState: "visible" });
    pushed.length = 0;
    globalStore.set(model.entriesAtom, []);
    setBrainstormHold(false);
});

afterEach(() => {
    setBrainstormHold(false);
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

// FR-BOSS-010 AC3 (#2246): the brainstorm mode holds the toasts; what arrived stays in the center, and is not toasted
// later either (no double): the mode's summary line says how many came.
describe("the toasts during the brainstorm mode", () => {
    it("holds what arrives while the mode is on, and toasts what comes after it", () => {
        const stop = startNotificationToasts();
        setBrainstormHold(true);
        globalStore.set(model.entriesAtom, [entry("a", 1)]);
        vi.advanceTimersByTime(ToastCoalesceMs + 10);
        expect(pushed).toEqual([]);
        setBrainstormHold(false);
        globalStore.set(model.entriesAtom, [entry("a", 1), entry("b", 2)]);
        vi.advanceTimersByTime(ToastCoalesceMs + 10);
        expect(pushed.map((t) => t.notificationId)).toEqual(["b"]);
        stop();
    });
});
