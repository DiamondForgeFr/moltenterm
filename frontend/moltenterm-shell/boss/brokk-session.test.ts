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
    const ownWorkingAtom = atom(false);
    return { BrokkHubModel: { getInstance: () => ({ sessionBlockAtom, ownWorkingAtom }) } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { BrokkHubModel } from "./brokk-hub-store";
import { BrokkSession, ReplyCommand, SayCommand, SessionCommand, SessionRouteId } from "./brokk-session";
import { TalkState } from "./brokk-talk-model";

const hub = BrokkHubModel.getInstance() as any;
let calls: { command: string; data: any; timeout: number }[] = [];
let found: any;
let said: any;
// replies: one per reading, the last one repeats; working: his agent works at each reading.
let replies: any[];
let working: boolean[];
let readings = 0;

function nextReply(): any {
    const i = Math.min(readings, replies.length - 1);
    globalStore.set(hub.ownWorkingAtom, working[Math.min(readings, working.length - 1)]);
    readings++;
    return replies[i];
}

async function settled(session: BrokkSession, phases: string[]): Promise<TalkState> {
    for (let i = 0; i < 1000; i++) {
        const state = globalStore.get(session.stateAtom);
        if (phases.includes(state.phase)) {
            return state;
        }
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return globalStore.get(session.stateAtom);
}

beforeEach(() => {
    calls = [];
    found = { status: "ready", blockid: "block-9", tabid: "tab-9", workspaceid: "ws-9" };
    said = { status: "sent", blockid: "block-9", tabid: "tab-9", workspaceid: "ws-9" };
    replies = [{ status: "waiting" }];
    working = [true];
    readings = 0;
    BrokkSession.resetInstance();
    const session = BrokkSession.getInstance();
    session.useCall(async (command, data, timeout) => {
        calls.push({ command, data, timeout });
        if (command === SessionCommand) {
            return found;
        }
        if (command === SayCommand) {
            return said;
        }
        return nextReply();
    });
    session.useWait(async () => {});
    globalStore.set(hub.sessionBlockAtom, null);
    globalStore.set(hub.ownWorkingAtom, false);
});

describe("the talk field goes to Brokk's session (FR-BOSS-009, AC15)", () => {
    it("gives the message, the workspace and his name to wavesrv's route for his session", async () => {
        replies = [{ status: "answer", markdown: "ok" }];
        working = [false];
        const state = await BrokkSession.getInstance().say("what waits?");
        const say = calls.find((c) => c.command === SayCommand);
        expect(say.data).toEqual({ workspaceid: "ws-9", name: "Brokk", text: "what waits?" });
        expect(state.phase).toBe("answering");
        expect(SessionRouteId).toBe("molten:brokk");
    });

    it("keeps the block of his session, so that the ring turns while it works", async () => {
        found = { status: "none" };
        said = { status: "sent", blockid: "block-7", tabid: "tab-7", started: true };
        replies = [{ status: "answer", markdown: "ok" }];
        working = [false];
        const state = await BrokkSession.getInstance().say("hello");
        expect(globalStore.get(hub.sessionBlockAtom)).toBe("block-7");
        expect(state.started).toBe(true);
    });

    it("says he settles in when the message starts his session, and that it is on its way otherwise", async () => {
        const session = BrokkSession.getInstance();
        let phaseDuring = "";
        const call = async (command: string) => {
            if (command === SessionCommand) {
                return found;
            }
            phaseDuring = globalStore.get(session.stateAtom).phase;
            return { status: "busy", reason: "notready" };
        };
        session.useCall(call);
        await session.say("hello");
        expect(phaseDuring).toBe("sending");
        expect(globalStore.get(session.stateAtom)).toMatchObject({ phase: "busy", reason: "notready" });

        found = { status: "none" };
        await session.say("hello");
        expect(phaseDuring).toBe("starting");
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
        found = { status: "ready", blockid: "block-3" };
        await BrokkSession.getInstance().find();
        expect(calls.map((c) => c.command)).toEqual([SessionCommand]);
        expect(globalStore.get(hub.sessionBlockAtom)).toBe("block-3");
    });

    it("leaves the ring alone when there is no session to find", async () => {
        found = { status: "none" };
        await BrokkSession.getInstance().find();
        expect(globalStore.get(hub.sessionBlockAtom)).toBeNull();
    });
});

// #2028: his session answered in its hidden tab, and nothing came back to the panel.
describe("his answer comes back under the field (#2028)", () => {
    it("reads his answer to this message until his agent is done, and shows it", async () => {
        replies = [{ status: "waiting" }, { status: "answer", markdown: "Two agents" }, { status: "answer", markdown: "Two agents run now." }];
        working = [true, true, false];
        const session = BrokkSession.getInstance();
        const before = Date.now();
        await session.say("how many agents run?");
        const state = await settled(session, ["answered", "noreply", "unread", "failed"]);
        expect(state).toMatchObject({ phase: "answered", reply: "Two agents run now." });
        const reads = calls.filter((c) => c.command === ReplyCommand);
        expect(reads.length).toBeGreaterThanOrEqual(3);
        expect(reads[0].data.after).toBeLessThanOrEqual(before);
        expect(reads[0].data.after).toBeGreaterThan(before - 60000);
    });

    it("points to his terminal when his answer cannot be read", async () => {
        replies = [{ status: "unread", blockid: "block-9", tabid: "tab-9", workspaceid: "ws-9" }];
        working = [true, false];
        const session = BrokkSession.getInstance();
        await session.say("hello");
        const state = await settled(session, ["answered", "noreply", "unread", "failed"]);
        expect(state.phase).toBe("unread");
        expect(state.where).toEqual({ workspaceid: "ws-9", tabid: "tab-9", blockid: "block-9" });
    });

    it("stops following the answer once the developer sends another message", async () => {
        const session = BrokkSession.getInstance();
        let release: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        session.useWait(() => held);
        await session.say("first");
        replies = [{ status: "answer", markdown: "to the second" }];
        working = [false];
        session.useWait(async () => {});
        await session.say("second");
        release();
        const state = await settled(session, ["answered"]);
        expect(state.reply).toBe("to the second");
    });
});
