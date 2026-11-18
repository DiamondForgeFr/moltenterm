// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ handlers: [] as ((event: any) => void)[] }));

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { workspace: atom({ oid: "ws-9" }), staticTabId: atom("tab-a") } };
});
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn() } }));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (sub: { handler: (event: any) => void }) => {
        m.handlers.push(sub.handler);
        return () => m.handlers.splice(m.handlers.indexOf(sub.handler), 1);
    },
}));
vi.mock("../tab-activity", () => ({
    TabActivity: { getInstance: () => ({ every: () => () => {} }) },
    whileShown: () => ({}),
}));
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

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { BrokkHubModel } from "./brokk-hub-store";
import {
    BrokkSession,
    itemsOf,
    PermitCommand,
    SessionCommand,
    SessionRouteId,
    TalkCommand,
    TalkEntry,
    TalkEvent,
    TalkOpCommand,
    TalkSayCommand,
    TalkView,
} from "./brokk-session";

const hub = BrokkHubModel.getInstance() as any;

// wavesrv's talk as the pages see it: one view, its revision raised by each change, a signal to every page.
let server: TalkView;
let calls: { command: string; data: any }[];
let sayState: any;

function view(over: Partial<TalkView> = {}): TalkView {
    return {
        rev: 1,
        instance: "w1",
        conversation: "main",
        main: [],
        brainstorm: [],
        state: { phase: "idle" },
        ...over,
    };
}

function change(over: Partial<TalkView>): void {
    server = { ...server, ...over, rev: server.rev + 1 };
    m.handlers.forEach((handler) => handler({ data: { rev: server.rev } }));
}

function page(): BrokkSession {
    const session = new (BrokkSession as any)() as BrokkSession;
    session.useCall(async (command, data) => {
        calls.push({ command, data });
        if (command === TalkCommand) {
            return server;
        }
        if (command === TalkSayCommand) {
            return sayState;
        }
        if (command === TalkOpCommand) {
            return { text: data.op === "take" ? "given back" : "", view: server };
        }
        if (command === PermitCommand) {
            return { status: "answered" };
        }
        if (command === SessionCommand) {
            return { status: "ready", blockid: "block-7" };
        }
        return null;
    });
    return session;
}

async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

const you = (id: string, text: string, origin = "tab-a"): TalkEntry => ({
    id,
    role: "you",
    text,
    at: 1,
    taken: true,
    origin,
});
const his = (id: string, markdown: string, final: boolean, origin = "tab-a"): TalkEntry => ({
    id,
    role: "brokk",
    markdown,
    turn: 3,
    at: 2,
    final,
    origin,
});

beforeEach(() => {
    m.handlers.splice(0);
    calls = [];
    server = view();
    sayState = { phase: "answering" };
    globalStore.set(atoms.staticTabId as any, "tab-a");
    globalStore.set(hub.sessionBlockAtom, null);
});

// #2382 (AC99): there is one Brokk. Each tab is a page of its own, and every page shows wavesrv's one talk: a message
// sent from the page of one workspace shows, with its answer, in the page of another, and so do the state and the
// question his agent waits on.
describe("one conversation in every page (AC99, #2382)", () => {
    it("shows the same exchange, state and question in two pages", async () => {
        const a = page();
        const b = page();
        const stops = [a.start(), b.start()];
        await settle();
        expect(await a.say("which projects use the toolkit?")).toMatchObject({ phase: "answering" });
        const say = calls.find((c) => c.command === TalkSayCommand);
        expect(say.data).toEqual({
            text: "which projects use the toolkit?",
            workspaceid: "ws-9",
            name: "Brokk",
            origin: "tab-a",
        });
        const question = {
            id: "q-1",
            blockid: "block-9",
            tool: "AskUserQuestion",
            kind: "question",
            subject: "Where?",
            at: 5,
            questions: [{ question: "Where?", options: [{ label: "Documents" }] }],
        } as any;
        change({
            main: [you("m1", "which projects use the toolkit?"), his("m1", "Two projects", false)],
            state: { phase: "needsanswer", where: { workspaceid: "ws-9", tabid: "tab-9", blockid: "block-9" } },
            permission: question,
            blockid: "block-9",
        });
        await settle();
        for (const p of [a, b]) {
            expect(globalStore.get(p.exchangeAtom).map((i) => `${i.role}:${i.text}`)).toEqual([
                "you:which projects use the toolkit?",
                "brokk:Two projects",
            ]);
            expect(globalStore.get(p.stateAtom)).toMatchObject({ phase: "needsanswer", where: { blockid: "block-9" } });
            expect(globalStore.get(p.permissionAtom)?.id).toBe("q-1");
        }
        expect(globalStore.get(hub.sessionBlockAtom)).toBe("block-9");
        // The question answered in page B is gone from page A too.
        expect(await b.answer(question, { "Where?": "Documents" })).toBe("answered");
        expect(calls.find((c) => c.command === PermitCommand).data).toEqual({
            id: "q-1",
            blockid: "block-9",
            decision: "answer",
            answers: { "Where?": "Documents" },
        });
        change({ permission: undefined, state: { phase: "answering" } });
        await settle();
        expect(globalStore.get(a.permissionAtom)).toBeNull();
        stops.forEach((stop) => stop());
        expect(m.handlers).toEqual([]);
        expect(SessionRouteId).toBe("molten:brokk");
        expect(TalkEvent).toBe("molten:brokktalk");
    });

    it("drops an older reading, and starts over with a restarted wavesrv", () => {
        const a = page();
        a.apply(view({ rev: 5, main: [you("m1", "newer")] }));
        a.apply(view({ rev: 4, main: [you("m0", "older")] }));
        expect(globalStore.get(a.exchangeAtom).map((i) => i.text)).toEqual(["newer"]);
        a.apply(view({ rev: 1, instance: "w2", main: [you("m9", "after a restart")] }));
        expect(globalStore.get(a.exchangeAtom).map((i) => i.text)).toEqual(["after a restart"]);
    });

    it("shows the waiting message, the text given back and the line under his square of the conversation on screen", async () => {
        const a = page();
        a.apply(
            view({
                waiting: [
                    { text: "first", since: 4, conversation: "main" },
                    { text: "idea", since: 5, conversation: "brainstorm" },
                ],
                returned: { brainstorm: "kept" },
                unseen: "m1",
                approved: [{ id: "a1", kind: "command", subject: "ls", at: 1 }],
                state: { phase: "queued" },
            })
        );
        expect(globalStore.get(a.queuedAtom)).toEqual({ text: "first", since: 4 });
        expect(globalStore.get(a.returnedAtom)).toBeNull();
        expect(globalStore.get(a.unseenIdAtom)).toBe("m1");
        expect(globalStore.get(a.approvedAtom).map((x) => x.id)).toEqual(["a1"]);
        a.apply(
            view({ rev: 2, conversation: "brainstorm", returned: { brainstorm: "kept" }, inflight: ["brainstorm"] })
        );
        expect(globalStore.get(a.conversationAtom)).toBe("brainstorm");
        expect(globalStore.get(a.returnedAtom)).toBe("kept");
        expect(a.hasInFlight("brainstorm")).toBe(true);
        expect(a.hasInFlight("main")).toBe(false);
        expect(await a.takeReturned()).toBe("given back");
    });
});

// The brainstorm (FR-BOSS-010, #2246, #2284): the page that sent a message alone hears its answers and that his agent
// took it, as before the talk moved to wavesrv; another page only shows them.
describe("the listeners of the page that sent the message", () => {
    it("tells each change of an answer to the page that sent it, never to another, and nothing of what was there before", () => {
        const a = page();
        const heard: string[] = [];
        const taken: string[] = [];
        a.listenAnswers((answer) => heard.push(`${answer.id}:${answer.you}:${answer.markdown}:${answer.final}`));
        a.listenTaken((id, conversation) => taken.push(`${id}:${conversation}`));
        a.apply(view({ rev: 1, main: [you("m0", "before"), his("m0", "old", true)] }));
        expect(heard).toEqual([]);
        a.apply(view({ rev: 2, main: [you("m0", "before"), his("m0", "old", true), you("m1", "mine")] }));
        a.apply(
            view({
                rev: 3,
                main: [you("m0", "before"), his("m0", "old", true), you("m1", "mine"), his("m1", "Two", false)],
            })
        );
        a.apply(
            view({
                rev: 4,
                main: [you("m0", "before"), his("m0", "old", true), you("m1", "mine"), his("m1", "Two", false)],
            })
        );
        a.apply(
            view({
                rev: 5,
                main: [you("m0", "before"), his("m0", "old", true), you("m1", "mine"), his("m1", "Two.", true)],
            })
        );
        a.apply(view({ rev: 6, main: [you("m2", "theirs", "tab-b"), his("m2", "Not mine", true, "tab-b")] }));
        expect(taken).toEqual(["m1:main"]);
        expect(heard).toEqual(["m1:mine:Two:false", "m1:mine:Two.:true"]);
    });
});

describe("the page's moves on the talk", () => {
    it("makes the brainstorm's moves in order, and its message after them", async () => {
        const a = page();
        a.setLead("[brainstorm]");
        expect(a.leadOf()).toBe("[brainstorm]");
        a.switchConversation("brainstorm", { carry: "m1", fresh: true });
        a.showConversation([{ role: "you", text: "kept", at: 1 }]);
        a.addLocalLine("Here we go.");
        a.replayStep("s1", "idea", "A line", 1, false);
        a.stopFollowing();
        a.returnWaiting("brainstorm");
        await a.say("for teens");
        const ops = calls.filter((c) => c.command === TalkOpCommand || c.command === TalkSayCommand);
        expect(ops.map((c) => c.data.op ?? "say")).toEqual([
            "lead",
            "switch",
            "show",
            "local",
            "replay",
            "stop",
            "return",
            "say",
        ]);
        expect(ops[1].data).toMatchObject({ conversation: "brainstorm", carry: "m1", fresh: true });
        expect(ops[4].data).toMatchObject({
            key: "s1",
            you: "idea",
            markdown: "A line",
            turn: 1,
            final: false,
            origin: "tab-a",
        });
    });

    it("says the message is on its way at once, and a call that failed as a failure", async () => {
        const a = page();
        let release: (value: any) => void;
        a.useCall((command) => {
            if (command === TalkSayCommand) {
                return new Promise((resolve) => (release = resolve));
            }
            return Promise.reject(new Error("no route"));
        });
        const said = a.say("hello", { clearPrompt: true });
        await settle();
        expect(globalStore.get(a.stateAtom).phase).toBe("sending");
        release({ phase: "queued" });
        expect((await said).phase).toBe("queued");
        a.useCall(() => Promise.reject(new Error("no route")));
        expect(await a.say("again")).toMatchObject({ phase: "failed", reason: "unreachable" });
        expect(globalStore.get(a.stateAtom)).toMatchObject({ phase: "failed", reason: "unreachable" });
    });

    it("sends a permission's answer to that request alone, and says when it came too late", async () => {
        const a = page();
        const ask = {
            id: "req-7",
            blockid: "block-9",
            tool: "Bash",
            kind: "command",
            subject: "npm test",
            at: 5,
        } as any;
        let status = "answered";
        a.useCall(async (command, data) => {
            calls.push({ command, data });
            if (command !== PermitCommand) {
                return server;
            }
            // wavesrv's talk says it too, in every page.
            server = { ...server, rev: server.rev + 1, permissiongone: status !== "answered" };
            return { status };
        });
        globalStore.set(a.permissionAtom, ask);
        expect(await a.permit(ask, "allow")).toBe("answered");
        expect(calls[0].data).toEqual({ id: "req-7", blockid: "block-9", decision: "allow" });
        expect(globalStore.get(a.permissionAtom)).toBeNull();
        expect(globalStore.get(a.permissionGoneAtom)).toBe(false);
        status = "gone";
        globalStore.set(a.permissionAtom, ask);
        expect(await a.permit(ask, "deny")).toBe("gone");
        expect(globalStore.get(a.permissionGoneAtom)).toBe(true);
    });

    it("tells wavesrv when its talk window opens and folds, and finds the session a restart left", async () => {
        const a = page();
        a.setWindowOpen(true);
        a.setWindowOpen(true);
        a.setWindowOpen(false);
        await settle();
        const windows = calls.filter((c) => c.data?.op === "window").map((c) => c.data);
        expect(windows).toEqual([
            { op: "window", origin: "tab-a", open: true },
            { op: "window", origin: "tab-a", open: false },
        ]);
        await a.find();
        expect(globalStore.get(hub.sessionBlockAtom)).toBe("block-7");
    });
});

describe("the exchange the window shows", () => {
    it("keeps each item as it was while its entry does not change, and offers replies only once an answer is complete", () => {
        const offer = 'Shall I?\n\n```brokk-actions\n["Yes", "No"]\n```';
        const first = itemsOf([you("m1", "go"), his("m1", offer, false)], []);
        expect(first[1]).toMatchObject({ role: "brokk", text: "Shall I?", actions: [], final: false, turn: 3 });
        const same = itemsOf([you("m1", "go"), his("m1", offer, false)], first);
        expect(same).toBe(first);
        const done = itemsOf([you("m1", "go"), his("m1", offer, true)], first);
        expect(done[0]).toBe(first[0]);
        expect((done[1] as any).actions.map((a: any) => a.label)).toEqual(["Yes", "No"]);
        const kept = itemsOf([{ ...his("s1", offer, true), still: true }], []);
        expect((kept[0] as any).actions).toEqual([]);
    });
});
