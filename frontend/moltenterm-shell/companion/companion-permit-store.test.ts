// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PermitWatchEveryMs, PermitRoute } from "./companion-permit-model";
import { PermitModel, startPermitWatch } from "./companion-permit-store";

const m = vi.hoisted(() => ({
    rpc: vi.fn(),
    handler: null as () => void,
    unsubscribe: vi.fn(),
}));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: ({ handler }: any) => {
        m.handler = handler;
        return m.unsubscribe;
    },
}));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: m.rpc } }));
vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));

const Session = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
    vi.useFakeTimers();
    m.rpc.mockReset();
    m.unsubscribe.mockReset();
    vi.stubGlobal("window", { addEventListener: vi.fn() });
    PermitModel.resetInstance();
});
afterEach(() => {
    PermitModel.resetInstance();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

function calls(command: string) {
    return m.rpc.mock.calls.filter((c) => c[0] === command);
}

describe("the windows' copy of the permission gate", () => {
    it("reads the state at start and again on each event, only from the windows-only route", async () => {
        m.rpc.mockResolvedValue({ version: 1, requests: [], autonomy: [] });
        const model = PermitModel.getInstance();
        await vi.advanceTimersByTimeAsync(0);
        expect(calls("agentpermitstate")).toHaveLength(1);
        expect(m.rpc.mock.calls[0][2]).toMatchObject({ route: PermitRoute });
        expect(globalStore.get(model.stateAtom).version).toBe(1);

        m.rpc.mockResolvedValue({
            version: 2,
            requests: [{ id: "r1", blockid: "b1", tool: "Bash", at: 1, state: "held" }],
            autonomy: [],
        });
        m.handler();
        m.handler();
        await vi.advanceTimersByTimeAsync(100);
        expect(calls("agentpermitstate")).toHaveLength(2);
        expect(globalStore.get(model.stateAtom).requests).toHaveLength(1);
    });

    it("keeps the newer state when a read comes back late", async () => {
        m.rpc.mockResolvedValue({ version: 5, requests: [], autonomy: [] });
        const model = PermitModel.getInstance();
        await vi.advanceTimersByTimeAsync(0);
        model.apply({ version: 4, requests: [{ id: "old", blockid: "b1", tool: "Bash", at: 1, state: "held" }], autonomy: [] });
        expect(globalStore.get(model.stateAtom).requests).toEqual([]);
    });

    it("sends the developer's click bound to the request, and reads the state again", async () => {
        m.rpc.mockResolvedValue({ version: 1, requests: [], autonomy: [] });
        const model = PermitModel.getInstance();
        await vi.advanceTimersByTimeAsync(0);
        m.rpc.mockReset();
        m.rpc.mockResolvedValue({ status: "answered" });
        const result = await model.answer({ id: "r1", blockid: "b1" }, "allow");
        expect(result.status).toBe("answered");
        expect(calls("agentpermitanswer")).toHaveLength(1);
        expect(calls("agentpermitanswer")[0][1]).toEqual({ id: "r1", blockid: "b1", decision: "allow" });
        expect(calls("agentpermitanswer")[0][2]).toMatchObject({ route: PermitRoute });
        await vi.advanceTimersByTimeAsync(100);
        expect(calls("agentpermitstate").length).toBeGreaterThan(0);

        m.rpc.mockResolvedValue({ status: "gone" });
        expect((await model.answer({ id: "r1", blockid: "b1" }, "terminal")).status).toBe("gone");
        expect(calls("agentpermitanswer")[1][1].decision).toBe("terminal");
    });

    it("sends a period only with the mode that has one", async () => {
        m.rpc.mockResolvedValue({ version: 1, requests: [], autonomy: [] });
        const model = PermitModel.getInstance();
        await vi.advanceTimersByTimeAsync(0);
        m.rpc.mockReset();
        m.rpc.mockResolvedValue({ status: "set" });
        await model.setMode("b1", Session, "for", "4h");
        await model.setMode("b1", Session, "always", "4h");
        await model.setMode("b1", Session, "ask");
        const sent = calls("agentpermitmode").map((c) => c[1]);
        expect(sent).toEqual([
            { blockid: "b1", sessionid: Session, mode: "for", period: "4h" },
            { blockid: "b1", sessionid: Session, mode: "always", period: undefined },
            { blockid: "b1", sessionid: Session, mode: "ask", period: undefined },
        ]);
    });

    it("keeps what wavesrv says a terminal's session can do", async () => {
        m.rpc.mockResolvedValue({ version: 1, requests: [], autonomy: [] });
        const model = PermitModel.getInstance();
        await vi.advanceTimersByTimeAsync(0);
        m.rpc.mockReset();
        m.rpc.mockResolvedValue({ blockid: "b1", available: true, holds: true });
        await model.watch("b1");
        expect(globalStore.get(model.watchesAtom).b1).toEqual({ blockid: "b1", available: true, holds: true });
        expect(calls("agentpermitwatch")[0][1]).toEqual({ blockid: "b1" });
        m.rpc.mockResolvedValue({ blockid: "b1", available: false, holds: false, reason: "started outside" });
        await model.watch("b1");
        expect(globalStore.get(model.watchesAtom).b1.reason).toBe("started outside");
    });
});

describe("the word that a window shows the companion", () => {
    function document(visibility: "visible" | "hidden") {
        const listeners: (() => void)[] = [];
        return {
            visibilityState: visibility as DocumentVisibilityState,
            addEventListener: vi.fn((_: string, fn: () => void) => listeners.push(fn)),
            removeEventListener: vi.fn(),
            fire: () => listeners.forEach((fn) => fn()),
        };
    }

    it("is said at once and renewed while the window can be seen, and ends with the companion", async () => {
        m.rpc.mockResolvedValue({ version: 1, requests: [], autonomy: [] });
        const model = PermitModel.getInstance();
        await vi.advanceTimersByTimeAsync(0);
        m.rpc.mockReset();
        m.rpc.mockResolvedValue({ blockid: "b1", available: true, holds: true });
        const doc = document("visible");
        const stop = startPermitWatch(model, "b1", doc);
        expect(calls("agentpermitwatch")).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(PermitWatchEveryMs * 3);
        expect(calls("agentpermitwatch")).toHaveLength(4);
        stop();
        await vi.advanceTimersByTimeAsync(PermitWatchEveryMs * 3);
        expect(calls("agentpermitwatch")).toHaveLength(4);
        expect(doc.removeEventListener).toHaveBeenCalledTimes(1);
    });

    it("is not said by a window that cannot be seen, and is said again when it can", async () => {
        m.rpc.mockResolvedValue({ version: 1, requests: [], autonomy: [] });
        const model = PermitModel.getInstance();
        await vi.advanceTimersByTimeAsync(0);
        m.rpc.mockReset();
        m.rpc.mockResolvedValue({ blockid: "b1", available: true, holds: true });
        const doc = document("hidden");
        const stop = startPermitWatch(model, "b1", doc);
        await vi.advanceTimersByTimeAsync(PermitWatchEveryMs * 3);
        expect(calls("agentpermitwatch")).toHaveLength(0);
        (doc as any).visibilityState = "visible";
        doc.fire();
        expect(calls("agentpermitwatch")).toHaveLength(1);
        stop();
    });

    it("survives a failing call", async () => {
        m.rpc.mockResolvedValue({ version: 1, requests: [], autonomy: [] });
        const model = PermitModel.getInstance();
        await vi.advanceTimersByTimeAsync(0);
        m.rpc.mockReset();
        m.rpc.mockRejectedValue(new Error("offline"));
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const stop = startPermitWatch(model, "b1", document("visible"));
        await vi.advanceTimersByTimeAsync(PermitWatchEveryMs);
        expect(calls("agentpermitwatch")).toHaveLength(2);
        stop();
        log.mockRestore();
    });
});
