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
    const ownWaitingAtom = atom(false);
    const ownPromptBusyAtom = atom(false);
    return {
        BrokkHubModel: {
            getInstance: () => ({ sessionBlockAtom, ownWorkingAtom, ownWaitingAtom, ownPromptBusyAtom }),
        },
    };
});

import { globalStore } from "@/app/store/jotaiStore";
import { BrokkHubModel } from "./brokk-hub-store";
import { BrokkSession, PermitCommand, ReplyCommand, SayCommand, SessionCommand, SessionRouteId } from "./brokk-session";
import { FollowEveryMs, MaxQueueMs, QueueEveryMs, TalkState } from "./brokk-talk-model";

const hub = BrokkHubModel.getInstance() as any;
let calls: { command: string; data: any; timeout: number }[] = [];
let found: any;
let said: any;
// replies: one per reading, the last one repeats; working: his agent works at each reading.
let replies: any[];
let working: boolean[];
// waiting: his agent's state says it waits for the developer at each reading (a fake agent state, #2155).
let waiting: boolean[];
let readings = 0;

function nextReply(): any {
    const i = Math.min(readings, replies.length - 1);
    globalStore.set(hub.ownWorkingAtom, working[Math.min(readings, working.length - 1)]);
    globalStore.set(hub.ownWaitingAtom, waiting[Math.min(readings, waiting.length - 1)]);
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
    waiting = [false];
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
    globalStore.set(hub.ownWaitingAtom, false);
    globalStore.set(hub.ownPromptBusyAtom, false);
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
            // The first try's phase: the later ones are the tries of a queued message (#2257).
            phaseDuring ||= globalStore.get(session.stateAtom).phase;
            return { status: "busy", reason: "notready" };
        };
        session.useCall(call);
        // The queued message's tries wait for ever here: only the first try is looked at.
        session.useWait(() => new Promise<void>(() => {}));
        await session.say("hello");
        expect(phaseDuring).toBe("sending");
        expect(globalStore.get(session.stateAtom)).toMatchObject({ phase: "queued", reason: "notready" });

        session.cancelQueued();
        found = { status: "none" };
        phaseDuring = "";
        await session.say("hello");
        expect(phaseDuring).toBe("starting");
        session.cancelQueued();
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
// #2257: his agent's permission requests, read with his answer, answered for that request alone.
describe("his agent's permission requests (#2257)", () => {
    const ask = { id: "req-7", blockid: "block-9", tool: "Bash", kind: "command", subject: "npm test", at: 5 };

    it("shows the request his agent waits on, and the approvals made without asking, each once", async () => {
        const session = BrokkSession.getInstance();
        replies = [
            { status: "waiting", permission: ask, approved: [{ id: "a1", kind: "command", subject: "ls", at: 1 }] },
            { status: "waiting", approved: [{ id: "a1", kind: "command", subject: "ls", at: 1 }] },
            { status: "answer", markdown: "Done." },
        ];
        working = [true, true, false];
        const seen: string[] = [];
        const stop = globalStore.sub(session.permissionAtom, () => {
            seen.push(globalStore.get(session.permissionAtom)?.id ?? "none");
        });
        await session.say("run the tests");
        await settled(session, ["answered"]);
        stop();
        expect(seen).toEqual(["req-7", "none"]);
        expect(globalStore.get(session.approvedAtom).map((a) => a.id)).toEqual(["a1"]);
    });

    it("sends the answer with the request's id and terminal, and says when it came too late", async () => {
        const session = BrokkSession.getInstance();
        const permits: any[] = [];
        let status = "answered";
        session.useCall(async (command, data) => {
            calls.push({ command, data, timeout: 0 });
            if (command === PermitCommand) {
                permits.push(data);
                return { status };
            }
            return found;
        });
        globalStore.set(session.permissionAtom, ask as any);
        expect(await session.permit(ask as any, "allow")).toBe("answered");
        expect(permits[0]).toEqual({ id: "req-7", blockid: "block-9", decision: "allow" });
        expect(globalStore.get(session.permissionAtom)).toBeNull();
        expect(globalStore.get(session.permissionGoneAtom)).toBe(false);
        status = "gone";
        globalStore.set(session.permissionAtom, ask as any);
        expect(await session.permit(ask as any, "deny")).toBe("gone");
        expect(globalStore.get(session.permissionGoneAtom)).toBe(true);
    });
});

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

    // #2155: his agent stopped on a permission prompt in his hidden terminal. A fake agent state, never a real agent.
    it("says he needs the developer's answer when his agent waits on a prompt, then reads his answer once it goes on", async () => {
        replies = [{ status: "waiting" }];
        working = [false];
        waiting = [true];
        const session = BrokkSession.getInstance();
        await session.say("clean the old branches");
        const blocked = await settled(session, ["needsanswer", "answered", "noreply", "unread", "failed"]);
        expect(blocked.phase).toBe("needsanswer");
        expect(blocked.where).toEqual({ workspaceid: "ws-9", tabid: "tab-9", blockid: "block-9" });

        // The developer answered in his terminal: the agent works, then answers.
        readings = 0;
        replies = [{ status: "waiting" }, { status: "answer", markdown: "Done." }];
        working = [true, false];
        waiting = [false];
        const state = await settled(session, ["answered", "noreply", "unread", "failed"]);
        expect(state).toMatchObject({ phase: "answered", reply: "Done." });
    });
});

// #2248: a brainstorm the developer moves to brings its conversation into his talk window, in place of the one before.
describe("a brainstorm's conversation comes back (FR-BOSS-010 AC10c, #2248)", () => {
    it("shows the kept turns, each answer under its message, offering nothing", () => {
        const session = BrokkSession.getInstance();
        session.addLocalLine("An earlier line");
        session.showConversation([
            { role: "you", text: "A video app for kids", at: 1 },
            { role: "brokk", text: 'For which ages?\n\n```brokk-actions\n["3 to 10"]\n```', at: 2 },
            { role: "brokk", text: "And who picks?", at: 3 },
            { role: "you", text: "The parents", at: 4 },
        ]);
        const items = globalStore.get(session.exchangeAtom);
        expect(items.map((item) => [item.role, item.text])).toEqual([
            ["you", "A video app for kids"],
            ["brokk", "For which ages?"],
            ["brokk", "And who picks?"],
            ["you", "The parents"],
        ]);
        expect(items[0].id).toBe(items[1].id);
        expect(items[2].id).not.toBe(items[1].id);
        expect(items.every((item) => item.role !== "brokk" || (item.final && item.actions.length === 0))).toBe(true);
        session.showConversation([]);
        expect(globalStore.get(session.exchangeAtom)).toEqual([]);
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

    it("keeps a message his agent could not take out of the exchange, waiting in his talk window", async () => {
        const session = BrokkSession.getInstance();
        sayAnswers = [{ status: "busy", reason: "notready" }];
        const state = await session.say("are you there?");
        expect(exchange()).toEqual([]);
        expect(state.phase).toBe("queued");
        expect(globalStore.get(session.stateAtom)).toMatchObject({ phase: "queued" });
        expect(globalStore.get(session.queuedAtom)).toMatchObject({ text: "are you there?" });
    });

    // #2257, #2284: a message his agent was too busy to take leaves the field at once, waits in his talk window and goes
    // by itself once his prompt is free: no retry click.
    it("sends a queued message by itself once his prompt is free", async () => {
        const session = BrokkSession.getInstance();
        sayAnswers = [{ status: "busy", reason: "notready" }, said];
        globalStore.set(hub.ownPromptBusyAtom, true);
        const first = await session.say("an idea");
        expect(first.phase).toBe("queued");
        expect(sayCalls).toBe(1);
        // Still busy: the next try waits, and nothing is typed.
        release(QueueEveryMs);
        await flush();
        expect(sayCalls).toBe(1);
        globalStore.set(hub.ownPromptBusyAtom, false);
        release(QueueEveryMs);
        await flush();
        expect(sayCalls).toBe(2);
        expect(globalStore.get(session.queuedAtom)).toBeNull();
        expect(globalStore.get(session.stateAtom).phase).toBe("answering");
        expect(shape()).toEqual(["you:an idea"]);
    });

    // FR-BOSS-010 AC24 (#2285): a message queued in the brainstorm goes, once he is free, as a brainstorm message: with
    // its lead and into the brainstorm's conversation, even when the developer left it meanwhile.
    it("sends a message queued in the brainstorm into its conversation, with its lead, after the developer left", async () => {
        const session = BrokkSession.getInstance();
        session.switchConversation("brainstorm", { fresh: true });
        session.setLead("Brainstorm:");
        sayAnswers = [{ status: "busy", reason: "notready" }, said];
        globalStore.set(hub.ownPromptBusyAtom, true);
        expect((await session.say("a garden planner")).phase).toBe("queued");
        session.switchConversation("main");
        session.setLead("");
        globalStore.set(hub.ownPromptBusyAtom, false);
        release(QueueEveryMs);
        await flush();
        const says = calls.filter((c) => c.command === SayCommand);
        expect(says[says.length - 1].data.text).toBe("Brainstorm: a garden planner");
        expect(exchange()).toEqual([]);
        session.switchConversation("brainstorm");
        expect(shape()).toEqual(["you:Brainstorm: a garden planner"]);
    });

    // #2284: a long turn of his never turns the waiting message into "busy, try again": while his own state says his
    // turn runs, the wait has no limit.
    it("waits with no limit while his turn runs", async () => {
        const session = BrokkSession.getInstance();
        sayAnswers = [{ status: "busy", reason: "notready" }, said];
        globalStore.set(hub.ownPromptBusyAtom, true);
        await session.say("look in my projects");
        // Past the bound of a free agent that refuses: the time his turn runs never counts.
        const tries = MaxQueueMs / QueueEveryMs + 10;
        for (let i = 0; i < tries; i++) {
            for (let j = 0; j < 50 && !waits.some((w) => w.ms === QueueEveryMs); j++) {
                await Promise.resolve();
            }
            release(QueueEveryMs);
        }
        await flush();
        expect(sayCalls).toBe(1);
        expect(globalStore.get(session.stateAtom).phase).toBe("queued");
        expect(globalStore.get(session.queuedAtom)).toMatchObject({ text: "look in my projects" });
        globalStore.set(hub.ownPromptBusyAtom, false);
        release(QueueEveryMs);
        await flush();
        expect(sayCalls).toBe(2);
        expect(shape()).toEqual(["you:look in my projects"]);
    });

    // #2284: the field is free while a message waits: what is sent meanwhile joins it, and both go in one turn.
    it("joins a message sent while one waits, and sends them together", async () => {
        const session = BrokkSession.getInstance();
        sayAnswers = [{ status: "busy", reason: "notready" }, said];
        await session.say("first");
        session.clearNote();
        await session.say("second");
        expect(sayCalls).toBe(1);
        expect(globalStore.get(session.queuedAtom).text).toBe("first\n\nsecond");
        release(QueueEveryMs);
        await flush();
        expect(sayCalls).toBe(2);
        expect(calls.filter((c) => c.command === SayCommand)[1].data.text).toBe("first\n\nsecond");
        expect(shape()).toEqual(["you:first\n\nsecond"]);
    });

    // #2284: Cancel stops the waiting message and gives its text back to the field.
    it("cancels a waiting message, which goes back to the field", async () => {
        const session = BrokkSession.getInstance();
        sayAnswers = [{ status: "busy", reason: "notready" }, said];
        await session.say("an idea");
        session.cancelQueued();
        expect(globalStore.get(session.queuedAtom)).toBeNull();
        expect(globalStore.get(session.stateAtom).phase).toBe("idle");
        expect(session.takeReturned()).toBe("an idea");
        expect(session.takeReturned()).toBeNull();
        release(QueueEveryMs);
        await flush();
        expect(sayCalls).toBe(1);
        expect(exchange()).toEqual([]);
    });

    // #2284: a real failure while it waits gives the text back to the field, and the note says what happened.
    it("gives the text back with what happened when a try fails", async () => {
        const session = BrokkSession.getInstance();
        sayAnswers = [
            { status: "busy", reason: "notready" },
            { status: "failed", reason: "humandraft" },
        ];
        await session.say("an idea");
        release(QueueEveryMs);
        await flush();
        expect(globalStore.get(session.queuedAtom)).toBeNull();
        expect(globalStore.get(session.stateAtom)).toMatchObject({ phase: "failed", reason: "humandraft" });
        expect(session.takeReturned()).toBe("an idea");
    });

    // Review of #2257: the developer writes again while a queued try is on its way. If his agent took it, it went: it
    // shows in the exchange (and the field keeps the new text, fieldAfterSend).
    it("shows a queued message his agent took while the developer wrote again", async () => {
        const session = BrokkSession.getInstance();
        let answerTry: (value: any) => void = null;
        sayAnswers = [{ status: "busy", reason: "notready" }];
        session.useCall(async (command, data, timeout) => {
            calls.push({ command, data, timeout });
            if (command === SessionCommand) {
                return found;
            }
            if (command === SayCommand) {
                sayCalls++;
                if (sayCalls === 1) {
                    return sayAnswers[0];
                }
                return new Promise((resolve) => (answerTry = resolve));
            }
            return read(data);
        });
        void session.say("an idea");
        await flush();
        release(QueueEveryMs);
        await flush();
        expect(sayCalls).toBe(2);
        session.clearNote();
        answerTry(said);
        await flush();
        expect(shape()).toEqual(["you:an idea"]);
    });

    // #2257: the developer's own click empties his prompt: the call says so, on every try.
    it("passes the developer's clear of his prompt", async () => {
        const session = BrokkSession.getInstance();
        void session.say("an idea", { clearPrompt: true });
        await flush();
        const say = calls.find((c) => c.command === SayCommand);
        expect(say.data).toMatchObject({ text: "an idea", clearprompt: true });
        void session.say("another");
        await flush();
        expect(calls.filter((c) => c.command === SayCommand)[1].data.clearprompt).toBeUndefined();
    });

    // #2284: only an agent that seems free and keeps refusing is a failure: past the bound, the text goes back to the
    // field and the note says so.
    it("gives the field back when he seems free and keeps refusing too long", async () => {
        const session = BrokkSession.getInstance();
        session.useWait(async () => {});
        sayAnswers = [{ status: "busy", reason: "notready" }];
        globalStore.set(hub.ownPromptBusyAtom, false);
        await session.say("an idea");
        const state = await settled(session, ["busy"]);
        expect(state.phase).toBe("busy");
        expect(sayCalls).toBe(MaxQueueMs / QueueEveryMs + 1);
        expect(globalStore.get(session.queuedAtom)).toBeNull();
        expect(session.takeReturned()).toBe("an idea");
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
        void session.say("second");
        await flush();
        expect(globalStore.get(session.stateAtom).phase).toBe("queued");
        expect(shape()).toEqual(["you:first", "brokk:Two agents"]);

        // The first answer keeps coming in, and the note of the refused message stays until the developer writes.
        read = () => answer(3, "Two agents run now.");
        globalStore.set(hub.ownWorkingAtom, false);
        await reading();
        await reading();
        expect(shape()).toEqual(["you:first", "brokk:Two agents run now."]);
        expect(exchange()[1]).toMatchObject({ final: true });
        expect(globalStore.get(session.stateAtom).phase).toBe("queued");

        // Writing again leaves the waiting message alone; Cancel stops it and leaves the answers alone.
        session.clearNote();
        expect(globalStore.get(session.stateAtom).phase).toBe("queued");
        session.cancelQueued();
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

    // #2259: his face speaks as his answer is revealed (brokk-speech.ts): the session only tells what changed.
    it("tells each change of his answer, and not a reading that did not change", async () => {
        const session = BrokkSession.getInstance();
        const told: string[] = [];
        const stop = session.listenAnswers((a) => told.push(a.markdown));
        globalStore.set(hub.ownWorkingAtom, true);
        read = () => answer(3, "Two");
        await session.say("hello");
        await reading();
        await reading();
        expect(told).toEqual(["Two"]);
        read = () => answer(3, "Two agents");
        await reading();
        expect(told).toEqual(["Two", "Two agents"]);
        stop();
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

    // FR-BOSS-010 AC24 (#2285): the brainstorm's exchanges are its own conversation. His ordinary one comes back as it
    // was, and an answer of the brainstorm that ends after the developer left is written in the brainstorm's, unseen.
    it("keeps a brainstorm's exchanges out of his ordinary conversation, even an answer that ends after leaving", async () => {
        const session = BrokkSession.getInstance();
        globalStore.set(hub.ownWorkingAtom, false);
        read = () => answer(3, "Hello.");
        await session.say("hi");
        await reading();
        await reading();
        expect(globalStore.get(session.stateAtom).phase).toBe("answered");
        session.switchConversation("brainstorm", { fresh: true });
        expect(globalStore.get(session.conversationAtom)).toBe("brainstorm");
        expect(exchange()).toEqual([]);
        globalStore.set(hub.ownWorkingAtom, true);
        read = () => answer(4, "An idea");
        await session.say("my idea");
        await reading();
        expect(shape()).toEqual(["you:my idea", "brokk:An idea"]);

        session.switchConversation("main");
        expect(shape()).toEqual(["you:hi", "brokk:Hello."]);
        read = () => answer(4, "An idea, grown.");
        await reading();
        expect(shape()).toEqual(["you:hi", "brokk:Hello."]);
        expect(globalStore.get(session.unseenIdAtom)).toBeNull();

        session.switchConversation("brainstorm");
        expect(shape()).toEqual(["you:my idea", "brokk:An idea, grown."]);
        session.switchConversation("main");
        session.switchConversation("brainstorm", { fresh: true });
        expect(exchange()).toEqual([]);
    });

    // AC24: the message whose answer opened the brainstorm goes into its conversation, and its answer goes on there.
    it("carries the message whose answer opened the brainstorm, and follows its answer there", async () => {
        const session = BrokkSession.getInstance();
        globalStore.set(hub.ownWorkingAtom, true);
        read = () => answer(3, "Let's put it on the anvil.");
        await session.say("I have an idea");
        await reading();
        const id = exchange()[0].id;
        session.switchConversation("brainstorm", { fresh: true, carry: id });
        expect(shape()).toEqual(["you:I have an idea", "brokk:Let's put it on the anvil."]);
        read = () => answer(3, "Let's put it on the anvil. Who is it for?");
        await reading();
        expect(shape()).toEqual(["you:I have an idea", "brokk:Let's put it on the anvil. Who is it for?"]);
        session.switchConversation("main");
        expect(exchange()).toEqual([]);
    });
});
