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
import { SpeakingHoldMs } from "./brokk-exchange-model";
import { BrokkHubModel } from "./brokk-hub-store";
import { BrokkSession, ReplyCommand, SayCommand, SessionCommand, SessionRouteId } from "./brokk-session";
import { FollowEveryMs, TalkState } from "./brokk-talk-model";

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
        replies = [
            { status: "waiting" },
            { status: "answer", markdown: "Two agents" },
            { status: "answer", markdown: "Two agents run now." },
        ];
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
});

// #2033: the exchange. The follow loop and the hold of his speech wait on gates the test releases one by one.
describe("the exchange follows each answer (FR-BOSS-009, AC23, #2033)", () => {
    let waits: { ms: number; release: () => void }[];
    let sayAnswers: any[];
    let read: (data: any) => any;
    let sayCalls: number;

    async function flush() {
        for (let i = 0; i < 20; i++) {
            await Promise.resolve();
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }

    function release(ms: number) {
        const i = waits.findIndex((w) => w.ms === ms);
        expect(i, `a wait of ${ms} ms is pending`).toBeGreaterThanOrEqual(0);
        waits.splice(i, 1)[0].release();
    }

    // One reading of the answer being followed. The loops of earlier messages are stopped: they wake and end.
    async function reading() {
        await flush();
        for (const wait of waits.filter((w) => w.ms === FollowEveryMs)) {
            waits.splice(waits.indexOf(wait), 1);
            wait.release();
        }
        await flush();
    }

    const answer = (index: number, markdown: string, at = 10 + index) => ({ status: "answer", index, markdown, at });
    const exchange = () => globalStore.get(BrokkSession.getInstance().exchangeAtom);
    const shape = () => exchange().map((i) => `${i.role}:${i.text}`);

    beforeEach(() => {
        waits = [];
        sayCalls = 0;
        sayAnswers = [said];
        read = () => ({ status: "waiting" });
        const session = BrokkSession.getInstance();
        session.useCall(async (command, data, timeout) => {
            calls.push({ command, data, timeout });
            if (command === SessionCommand) {
                return found;
            }
            if (command === SayCommand) {
                return sayAnswers[Math.min(sayCalls++, sayAnswers.length - 1)];
            }
            return read(data);
        });
        session.useWait((ms) => new Promise<void>((resolve) => waits.push({ ms, release: resolve })));
    });

    it("shows the message once his agent has it, and his answer after it, read by its turn", async () => {
        const session = BrokkSession.getInstance();
        read = () => answer(3, "Two agents run now.");
        globalStore.set(hub.ownWorkingAtom, false);
        await session.say("how many agents run?");
        expect(shape()).toEqual(["you:how many agents run?"]);
        await reading();
        expect(shape()).toEqual(["you:how many agents run?", "brokk:Two agents run now."]);
        await reading();
        expect(globalStore.get(session.stateAtom).phase).toBe("answered");
        expect(exchange()[1]).toMatchObject({ role: "brokk", turn: 3, final: true });
        // Once its turn is known the answer is read by it, whatever turn comes after.
        const reads = calls.filter((c) => c.command === ReplyCommand);
        expect(reads[0].data.index).toBe(0);
        expect(reads[reads.length - 1].data.index).toBe(3);
    });

    it("keeps a message his agent could not take out of the exchange, and its text with the developer", async () => {
        const session = BrokkSession.getInstance();
        sayAnswers = [{ status: "busy", reason: "notready" }];
        await session.say("are you there?");
        expect(exchange()).toEqual([]);
        expect(globalStore.get(session.stateAtom)).toMatchObject({ phase: "busy" });
    });

    it("keeps each answer apart over several messages, in order", async () => {
        const session = BrokkSession.getInstance();
        globalStore.set(hub.ownWorkingAtom, false);
        read = () => answer(3, "Two.");
        await session.say("how many agents run?");
        await reading();
        await reading();
        read = () => answer(4, "One, Olivia.");
        await session.say("and who is blocked?");
        await reading();
        await reading();
        expect(shape()).toEqual([
            "you:how many agents run?",
            "brokk:Two.",
            "you:and who is blocked?",
            "brokk:One, Olivia.",
        ]);
        expect(exchange().map((i) => i.role === "brokk" && i.turn)).toEqual([false, 3, false, 4]);
    });

    it("does not lose the first answer when his agent cannot take a second message yet", async () => {
        const session = BrokkSession.getInstance();
        globalStore.set(hub.ownWorkingAtom, true);
        read = () => answer(3, "Two agents");
        await session.say("first");
        await reading();
        expect(shape()).toEqual(["you:first", "brokk:Two agents"]);

        sayAnswers = [said, { status: "busy", reason: "notready" }];
        await session.say("second");
        expect(globalStore.get(session.stateAtom).phase).toBe("busy");
        expect(shape()).toEqual(["you:first", "brokk:Two agents"]);

        // The first answer keeps coming in, and the note of the refused message stays until the developer writes.
        read = () => answer(3, "Two agents run now.");
        globalStore.set(hub.ownWorkingAtom, false);
        await reading();
        await reading();
        expect(shape()).toEqual(["you:first", "brokk:Two agents run now."]);
        expect(exchange()[1]).toMatchObject({ final: true });
        expect(globalStore.get(session.stateAtom).phase).toBe("busy");

        // Writing again clears the note and leaves the answers alone.
        session.clearNote();
        expect(globalStore.get(session.stateAtom).phase).toBe("idle");
        expect(shape()).toEqual(["you:first", "brokk:Two agents run now."]);
    });

    it("reads the first answer to its end, by its turn, when a second message is taken while it comes in", async () => {
        const session = BrokkSession.getInstance();
        globalStore.set(hub.ownWorkingAtom, true);
        read = () => answer(3, "Two agents");
        await session.say("first");
        await reading();

        // His agent took the second message: the first answer was finished meanwhile, and the newer turn has begun.
        read = (data) => (data.index === 3 ? answer(3, "Two agents run now.") : { status: "waiting" });
        await session.say("second");
        expect(shape()).toEqual(["you:first", "brokk:Two agents run now.", "you:second"]);
        expect(exchange()[1]).toMatchObject({ role: "brokk", turn: 3, final: true });
        const settling = calls.filter((c) => c.command === ReplyCommand).pop();
        expect(settling.data.index).toBe(3);

        read = (data) => (data.index === 3 ? answer(3, "Two agents run now.") : answer(4, "One blocked."));
        globalStore.set(hub.ownWorkingAtom, false);
        await reading();
        await reading();
        expect(shape()).toEqual(["you:first", "brokk:Two agents run now.", "you:second", "brokk:One blocked."]);
    });

    it("tells the first answer is over even when the second message came before any text of it", async () => {
        const session = BrokkSession.getInstance();
        await session.say("first");
        await session.say("second");
        expect(shape()).toEqual(["you:first", "you:second"]);
    });

    it("speaks while his answer comes in and a moment after it last changed", async () => {
        const session = BrokkSession.getInstance();
        globalStore.set(hub.ownWorkingAtom, true);
        read = () => answer(3, "Two");
        await session.say("hello");
        expect(globalStore.get(session.speakingAtom)).toBe(false);
        await reading();
        expect(globalStore.get(session.speakingAtom)).toBe(true);

        // It changes again: the first hold ending does not end the speech.
        read = () => answer(3, "Two agents");
        await reading();
        expect(waits.filter((w) => w.ms === SpeakingHoldMs)).toHaveLength(2);
        release(SpeakingHoldMs);
        await flush();
        expect(globalStore.get(session.speakingAtom)).toBe(true);
        release(SpeakingHoldMs);
        await flush();
        expect(globalStore.get(session.speakingAtom)).toBe(false);
    });

    it("does not speak again for an answer that did not change", async () => {
        const session = BrokkSession.getInstance();
        globalStore.set(hub.ownWorkingAtom, true);
        read = () => answer(3, "Two");
        await session.say("hello");
        await reading();
        await reading();
        expect(waits.filter((w) => w.ms === SpeakingHoldMs)).toHaveLength(1);
    });

    it("keeps what he said while the window was folded as his line until the developer looks", async () => {
        const session = BrokkSession.getInstance();
        globalStore.set(hub.ownWorkingAtom, true);
        read = () => answer(3, "Two agents run now.");
        session.setWindowOpen(true);
        await session.say("hello");
        await reading();
        expect(globalStore.get(session.unseenIdAtom)).toBeNull();

        session.setWindowOpen(false);
        read = () => answer(3, "Two agents run now. Olivia waits.");
        await reading();
        const unseen = globalStore.get(session.unseenIdAtom);
        expect(unseen).not.toBeNull();
        expect(exchange().find((i) => i.role === "brokk" && i.id === unseen)).toMatchObject({
            text: "Two agents run now. Olivia waits.",
        });

        session.setWindowOpen(true);
        expect(globalStore.get(session.unseenIdAtom)).toBeNull();
    });

    it("keeps the exchange when the window folds and opens again", async () => {
        const session = BrokkSession.getInstance();
        read = () => answer(3, "Two.");
        globalStore.set(hub.ownWorkingAtom, false);
        await session.say("hello");
        await reading();
        session.setWindowOpen(true);
        session.setWindowOpen(false);
        session.setWindowOpen(true);
        expect(shape()).toEqual(["you:hello", "brokk:Two."]);
    });
});
