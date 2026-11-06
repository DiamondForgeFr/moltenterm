// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom({ oid: "ws-9" }) } };
});
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));
vi.mock("./boss-store", async () => {
    const { atom } = await import("jotai");
    const nameAtom = atom("Brokk");
    return { BossBubbleModel: { getInstance: () => ({ nameAtom }) } };
});
vi.mock("./brokk-hub-store", async () => {
    const { atom } = await import("jotai");
    const sessionBlockAtom = atom(null);
    return { BrokkHubModel: { getInstance: () => ({ sessionBlockAtom }) } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { BrokkHubModel } from "./brokk-hub-store";
import { BrokkSession, SayCommand, SessionCommand, SessionRouteId } from "./brokk-session";

const hub = BrokkHubModel.getInstance() as any;
let calls: { command: string; data: any; timeout: number }[] = [];
let answer: any = { status: "sent" };

beforeEach(() => {
    calls = [];
    answer = { status: "sent" };
    BrokkSession.resetInstance();
    BrokkSession.getInstance().useCall(async (command, data, timeout) => {
        calls.push({ command, data, timeout });
        return answer;
    });
    globalStore.set(hub.sessionBlockAtom, null);
});

describe("the talk field goes to Brokk's session (FR-BOSS-009, AC15)", () => {
    it("gives the message, the workspace and his name to wavesrv's route for his session", async () => {
        const state = await BrokkSession.getInstance().say("what waits?");
        expect(calls).toHaveLength(1);
        expect(calls[0].command).toBe(SayCommand);
        expect(calls[0].data).toEqual({ workspaceid: "ws-9", name: "Brokk", text: "what waits?" });
        expect(state.phase).toBe("sent");
        expect(SessionRouteId).toBe("molten:brokk");
    });

    it("keeps the block of his session, so that the ring turns while it works", async () => {
        answer = { status: "sent", blockid: "block-7", started: true };
        const state = await BrokkSession.getInstance().say("hello");
        expect(globalStore.get(hub.sessionBlockAtom)).toBe("block-7");
        expect(state.started).toBe(true);
    });

    it("says the message is on its way while it waits, then what came of it", async () => {
        const session = BrokkSession.getInstance();
        let phaseDuring = "";
        session.useCall(async () => {
            phaseDuring = globalStore.get(session.stateAtom).phase;
            return { status: "busy", reason: "notready" };
        });
        await session.say("hello");
        expect(phaseDuring).toBe("sending");
        expect(globalStore.get(session.stateAtom)).toMatchObject({ phase: "busy", reason: "notready" });
    });

    it("tells a failure of the call as a failure, and leaves the ring alone", async () => {
        const session = BrokkSession.getInstance();
        session.useCall(async () => {
            throw new Error("no route");
        });
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const state = await session.say("hello");
        expect(state.phase).toBe("failed");
        expect(globalStore.get(hub.sessionBlockAtom)).toBeNull();
    });

    it("finds the session a restart left without starting anything", async () => {
        answer = { status: "ready", blockid: "block-3" };
        await BrokkSession.getInstance().find();
        expect(calls.map((c) => c.command)).toEqual([SessionCommand]);
        expect(globalStore.get(hub.sessionBlockAtom)).toBe("block-3");
    });

    it("leaves the ring alone when there is no session to find", async () => {
        answer = { status: "none" };
        await BrokkSession.getInstance().find();
        expect(globalStore.get(hub.sessionBlockAtom)).toBeNull();
    });
});
