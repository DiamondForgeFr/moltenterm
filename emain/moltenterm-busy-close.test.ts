// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BusyAskChannel, BusyAskTarget, makeAskOnce, makeBusyAsker } from "./moltenterm-busy-close";
import {
    BusyOutcomeCancel,
    BusyOutcomeClose,
    BusyOutcomeNoAnswer,
    BusyOutcomeNone,
    BusyOutcomeOff,
    fallsBackToElectron,
    isDeletedWhenLeft,
    switchStops,
    windowCloseStops,
} from "./moltenterm-busy-close-policy";

const Unsaved = { oid: "ws-1", name: "", icon: "", tabids: ["t1"] };
const Saved = { oid: "ws-2", name: "API", icon: "rocket", tabids: ["t1", "t2"] };

describe("what a window close stops", () => {
    it("asks for the unsaved workspace deleted with a window when another window remains", () => {
        const stops = windowCloseStops({
            numWindows: 2,
            saveLastWindow: true,
            platform: "darwin",
            numBuilders: 0,
            workspace: Unsaved,
        });
        expect(stops).toEqual({ stopworkspaceids: ["ws-1"], quit: false });
    });

    it("asks for an unsaved workspace with one tab, which window:confirmclose never asks about (AC7)", () => {
        const stops = windowCloseStops({
            numWindows: 3,
            saveLastWindow: true,
            platform: "darwin",
            numBuilders: 0,
            workspace: { ...Unsaved, tabids: ["only"] },
        });
        expect(stops?.stopworkspaceids).toEqual(["ws-1"]);
    });

    it("stops nothing when the workspace is saved or the last macOS window is kept", () => {
        expect(
            windowCloseStops({
                numWindows: 2,
                saveLastWindow: true,
                platform: "darwin",
                numBuilders: 0,
                workspace: Saved,
            })
        ).toBeNull();
        expect(
            windowCloseStops({
                numWindows: 1,
                saveLastWindow: true,
                platform: "darwin",
                numBuilders: 0,
                workspace: Unsaved,
            })
        ).toBeNull();
    });

    it("deletes the last window's unsaved workspace when window:savelastwindow is off", () => {
        const stops = windowCloseStops({
            numWindows: 1,
            saveLastWindow: false,
            platform: "darwin",
            numBuilders: 0,
            workspace: Unsaved,
        });
        expect(stops).toEqual({ stopworkspaceids: ["ws-1"], quit: false });
    });

    it("quits on Linux and Windows when the last window closes, unless a builder window remains", () => {
        for (const platform of ["linux", "win32"]) {
            expect(
                windowCloseStops({ numWindows: 1, saveLastWindow: true, platform, numBuilders: 0, workspace: Saved })
            ).toEqual({ stopworkspaceids: [], quit: true });
            expect(
                windowCloseStops({ numWindows: 1, saveLastWindow: false, platform, numBuilders: 0, workspace: Unsaved })
            ).toEqual({ stopworkspaceids: ["ws-1"], quit: true });
        }
        expect(
            windowCloseStops({
                numWindows: 1,
                saveLastWindow: true,
                platform: "linux",
                numBuilders: 1,
                workspace: Saved,
            })
        ).toBeNull();
    });

    it("follows wcore.DeleteWorkspace: a name without an icon is not saved", () => {
        expect(isDeletedWhenLeft({ name: "API", icon: "" })).toBe(true);
        expect(isDeletedWhenLeft({ name: "", icon: "rocket" })).toBe(true);
        expect(isDeletedWhenLeft(Saved)).toBe(false);
        expect(isDeletedWhenLeft(null)).toBe(false);
    });
});

describe("what a switch away stops (AC6)", () => {
    it("asks when the switch deletes the unsaved workspace left", () => {
        expect(switchStops(Unsaved, false)).toEqual({ stopworkspaceids: ["ws-1"], quit: false });
        expect(switchStops({ ...Unsaved, name: "API" }, false)).toEqual({ stopworkspaceids: ["ws-1"], quit: false });
    });

    it("stops nothing when the target has a window, the workspace is saved or opens a new window", () => {
        expect(switchStops(Unsaved, true)).toBeNull();
        expect(switchStops(Saved, false)).toBeNull();
        expect(switchStops({ ...Unsaved, tabids: ["a", "b"] }, false)).toBeNull();
        expect(switchStops(null, false)).toBeNull();
    });
});

describe("the fallback to Electron's confirmation (AC5)", () => {
    it("falls back when off, idle or unanswered, never after an answer", () => {
        expect(fallsBackToElectron(BusyOutcomeOff)).toBe(true);
        expect(fallsBackToElectron(BusyOutcomeNone)).toBe(true);
        expect(fallsBackToElectron(BusyOutcomeNoAnswer)).toBe(true);
        expect(fallsBackToElectron(BusyOutcomeClose)).toBe(false);
        expect(fallsBackToElectron(BusyOutcomeCancel)).toBe(false);
    });
});

type FakeTarget = BusyAskTarget & { sent: any[]; listeners: Map<string, (...args: any[]) => void>; destroyed: boolean };

function makeTarget(id = 7): FakeTarget {
    const target: FakeTarget = {
        id,
        sent: [],
        listeners: new Map(),
        destroyed: false,
        isDestroyed: () => target.destroyed,
        send: (channel, request) => target.sent.push({ channel, request }),
        once: (event, listener) => target.listeners.set(event, listener),
        removeListener: (event) => target.listeners.delete(event),
    };
    return target;
}

describe("asking the renderer", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("sends the request and resolves with the renderer's answer", async () => {
        const asker = makeBusyAsker(1500);
        const target = makeTarget();
        const result = asker.ask(target, "quit", { stopworkspaceids: [], quit: true }, { name: "MoltenTerm" });
        expect(target.sent).toHaveLength(1);
        const request = target.sent[0].request;
        expect(target.sent[0].channel).toBe(BusyAskChannel);
        expect(request).toMatchObject({ kind: "quit", quit: true, stopworkspaceids: [], name: "MoltenTerm" });
        asker.handleReply(7, { requestid: request.requestid, phase: "ack" });
        vi.advanceTimersByTime(60000);
        asker.handleReply(7, { requestid: request.requestid, phase: "result", outcome: "close" });
        await expect(result).resolves.toBe(BusyOutcomeClose);
        expect(asker.pendingCount()).toBe(0);
        expect(target.listeners.size).toBe(0);
    });

    it("falls back when no ack comes within the timeout", async () => {
        const asker = makeBusyAsker(1500);
        const result = asker.ask(makeTarget(), "window", { stopworkspaceids: ["ws-1"], quit: false });
        vi.advanceTimersByTime(1500);
        await expect(result).resolves.toBe(BusyOutcomeNoAnswer);
    });

    it("ignores answers from another renderer and unknown outcomes fall back", async () => {
        const asker = makeBusyAsker(1500);
        const target = makeTarget(7);
        const result = asker.ask(target, "delete", { stopworkspaceids: ["ws-1"], quit: false });
        const { requestid } = target.sent[0].request;
        asker.handleReply(8, { requestid, phase: "result", outcome: "close" });
        expect(asker.pendingCount()).toBe(1);
        asker.handleReply(7, { requestid, phase: "result", outcome: "error" });
        await expect(result).resolves.toBe(BusyOutcomeNoAnswer);
    });

    it("tells main when the renderer starts asking, and a renderer that goes falls back", async () => {
        const asker = makeBusyAsker(1500);
        const target = makeTarget();
        const onAsking = vi.fn();
        const result = asker.ask(target, "switch", { stopworkspaceids: ["ws-1"], quit: false }, { onAsking });
        const { requestid } = target.sent[0].request;
        asker.handleReply(7, { requestid, phase: "asking" });
        expect(onAsking).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(5000);
        target.listeners.get("destroyed")();
        await expect(result).resolves.toBe(BusyOutcomeNoAnswer);
    });

    it("does not ask a missing or destroyed renderer", async () => {
        const asker = makeBusyAsker(1500);
        await expect(asker.ask(null, "quit", { stopworkspaceids: [], quit: true })).resolves.toBe(BusyOutcomeNoAnswer);
        const gone = makeTarget();
        gone.destroyed = true;
        await expect(asker.ask(gone, "quit", { stopworkspaceids: [], quit: true })).resolves.toBe(BusyOutcomeNoAnswer);
        expect(gone.sent).toHaveLength(0);
    });
});

describe("one dialog per action", () => {
    it("drops a second ask for the same action while the first is open, as a cancel", async () => {
        const askOnce = makeAskOnce();
        let release: (v: string) => void;
        const first = askOnce("quit", () => new Promise<string>((resolve) => (release = resolve)));
        await expect(askOnce("quit", async () => BusyOutcomeClose)).resolves.toBe(BusyOutcomeCancel);
        await expect(askOnce("window:w1", async () => BusyOutcomeNone)).resolves.toBe(BusyOutcomeNone);
        release(BusyOutcomeClose);
        await expect(first).resolves.toBe(BusyOutcomeClose);
        await expect(askOnce("quit", async () => BusyOutcomeNone)).resolves.toBe(BusyOutcomeNone);
    });
});
