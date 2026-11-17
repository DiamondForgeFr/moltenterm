// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    channel: "gold" as string,
    registered: new Map<string, (args: any) => Promise<any>>(),
}));

vi.mock("../build/current-build", () => ({ currentChannel: () => state.channel, currentLogWatchOn: () => true }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));
vi.mock("../notifications-store", () => ({
    registerNotificationGesture: (name: string, gesture: (args: any) => Promise<any>) => {
        state.registered.set(name, gesture);
        return () => state.registered.delete(name);
    },
}));

import { gestureResult, registerLogWatchGestures } from "./logwatch-gestures";
import { LogWatchAskGesture, LogWatchDeps, LogWatchMuteGesture } from "./logwatch-model";

const Fake: LogWatchDeps = {
    on: () => true,
    ask: async () => ({ status: "noagent" }),
    mute: async () => {},
    pick: async () => "",
    word: () => "",
};

beforeEach(() => {
    state.registered.clear();
});

// FR-BOSS-012 AC1, acceptance 3: the card's actions exist on gold, dev and local builds; a release candidate, a public
// release and a channel that is not known register none.
describe("the log watch's gestures", () => {
    it.each([["gold"], ["dev"], ["local"]])("are registered on %s, and removed with the host", (channel) => {
        state.channel = channel;
        const off = registerLogWatchGestures(Fake);
        expect([...state.registered.keys()].sort()).toEqual([LogWatchAskGesture, LogWatchMuteGesture].sort());
        off();
        expect(state.registered.size).toBe(0);
    });

    it.each([["rc"], ["public"], ["unknown"], [null]])("are not registered on %s", (channel) => {
        state.channel = channel;
        registerLogWatchGestures(Fake);
        expect(state.registered.size).toBe(0);
    });

    it("words a reason in the interface language on the card", async () => {
        state.channel = "gold";
        registerLogWatchGestures(Fake);
        const result = await state.registered.get(LogWatchAskGesture)({ id: "abc" });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/agent/i);
        expect(gestureResult({ ok: true, resolve: true })).toEqual({ ok: true, resolve: true });
        expect(gestureResult({ ok: false, error: "raw" })).toEqual({ ok: false, resolve: undefined, error: "raw" });
    });
});
