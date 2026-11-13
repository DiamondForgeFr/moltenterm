// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The living graph in a view (FR-BOSS-010 AC27, AC28, #2247): the developer's changes go to wavesrv with the
// brainstorm they were made on, the layer's bar offers Undo after a removal or a merge, and the note of their changes
// goes before their next message until his answer to it comes. Synthetic data only.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return { atoms: { uiContext: atom({ windowid: "w1" }) }, getApi: () => ({ moltentermSystemNotifyHold: () => {} }) };
});
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: () => {} } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("../build/current-build", () => ({ currentBrainstormAllowed: () => true }));
vi.mock("../toast-store", () => ({ showToast: () => {} }));
vi.mock("../notifications-model", () => ({ notificationTitle: (e: any) => e.title }));
vi.mock("../agent-state-store", async () => {
    const { atom } = await import("jotai");
    const dataAtom = atom({ states: {}, versions: {} });
    return { AgentStates: { getInstance: () => ({ dataAtom }) } };
});
vi.mock("../notifications-store", async () => {
    const { atom } = await import("jotai");
    const entriesAtom = atom([]);
    return { MoltentermNotifications: { getInstance: () => ({ entriesAtom, entries: () => [] }) } };
});
vi.mock("../tab-activity", async () => {
    const { atom } = await import("jotai");
    const onScreenAtom = atom(false);
    return { TabActivity: { getInstance: () => ({ onScreenAtom }) } };
});
vi.mock("../sidebar/sidebar-store", async () => {
    const { atom } = await import("jotai");
    return {
        SidebarModel: {
            getInstance: () => ({
                windowMetaAtom: atom({}),
                isEnabled: () => false,
                isHidden: () => true,
                setHidden: () => {},
            }),
        },
    };
});
vi.mock("../boss/boss-store", async () => {
    const { atom } = await import("jotai");
    const cardOpenAtom = atom(true);
    const boss = { cardOpenAtom, nameAtom: atom("Brokk"), openCard: () => {}, closeCard: () => {}, pinCard: () => {} };
    return { BossBubbleModel: { getInstance: () => boss } };
});
vi.mock("../boss/brokk-session", async () => {
    const answerListeners = new Set<(a: any) => void>();
    const session = {
        lead: "",
        setLead: (lead: string) => {
            session.lead = lead;
        },
        leadOf: () => session.lead,
        listenAnswers: (fn: (a: any) => void) => {
            answerListeners.add(fn);
            return () => answerListeners.delete(fn);
        },
        tell: (a: any) => answerListeners.forEach((fn) => fn(a)),
        listenTaken: () => () => {},
        addLocalLine: () => {},
        showConversation: () => {},
        stopFollowing: () => {},
    };
    return { BrokkSession: { getInstance: () => session } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { BrokkSession } from "../boss/brokk-session";
import type { HistoryNote } from "./brainstorm-boot";
import {
    BrainstormModel,
    CloseCommand,
    EditCommand,
    LoadCommand,
    StateCommand,
    ToldCommand,
    UndoCommand,
} from "./brainstorm-store";

const session = BrokkSession.getInstance() as any;

// A wavesrv of the test: one open brainstorm, its graph's revision and its history; it applies the developer's
// changes and undoes, as pkg/molten/brainstorm does, in short.
let calls: { command: string; data: any }[];
let server: {
    version: number;
    rev: number;
    swap: number;
    open: boolean;
    history: HistoryNote[];
    fail?: string;
    id?: string;
    // The other folders' histories, by id, for a Load.
    saved?: Record<string, HistoryNote[]>;
};

const currentId = () => server.id ?? "id-kids-video";

// A change named for another brainstorm than the open one: wavesrv refuses it.
const otherBrainstorm = (data: any) => data.swap !== server.swap || (data.id !== "" && data.id !== currentId());

const line = (
    seq: number,
    by: "you" | "brokk",
    op: string,
    id: string,
    more: Partial<HistoryNote> = {}
): HistoryNote => ({
    seq,
    at: seq,
    by,
    op,
    nodes: [{ id, text: `Text of ${id}` }],
    undoable: true,
    ...more,
});

function state(): any {
    return {
        allowed: true,
        open: server.open,
        version: server.version,
        swap: server.swap,
        brainstorm: { id: currentId(), slug: currentId().replace(/^id-/, ""), title: "A safe video app" },
        graph: {
            schema: 1,
            rev: server.rev,
            centre: "kids-video",
            nodes: [{ id: "ages", text: "For which ages?" }],
            links: [],
        },
        history: server.history,
    };
}

function changed(): any {
    server.version++;
    server.rev++;
    return state();
}

async function fakeCall(command: string, data: any): Promise<any> {
    calls.push({ command, data });
    if (command === EditCommand) {
        if (otherBrainstorm(data)) {
            return { state: state(), stale: true };
        }
        if (server.fail) {
            return { state: state(), error: server.fail };
        }
        const seqs = data.ops.map((op: any) => {
            const seq = server.history.length + 1;
            server.history = [...server.history, line(seq, "you", op.op, op.id ?? op.a)];
            return seq;
        });
        return { state: changed(), seqs };
    }
    if (command === UndoCommand) {
        if (otherBrainstorm(data)) {
            return { state: state(), stale: true };
        }
        if (server.fail) {
            return { state: state(), error: server.fail };
        }
        const target = server.history.find((n) => n.seq === data.seq);
        server.history = server.history.map((n) =>
            n.seq === data.seq ? { ...n, undone: true, undoable: false, told: n.told || n.by === "you" } : n
        );
        const seq = server.history.length + 1;
        server.history = [
            ...server.history,
            line(seq, "you", "undo", target.nodes[0].id, {
                refop: target.op,
                ref: target.seq,
                told: target.by === "you" && !target.told,
            }),
        ];
        return { state: changed(), seqs: [seq] };
    }
    if (command === ToldCommand) {
        if (otherBrainstorm(data) || !data.id) {
            return state();
        }
        server.history = server.history.map((n) => (n.by === "you" && n.seq <= data.seq ? { ...n, told: true } : n));
        server.version++;
        return state();
    }
    if (command === CloseCommand) {
        server.open = false;
        server.version++;
        return state();
    }
    if (command === LoadCommand) {
        const id = `id-${data.slug}`;
        // The brainstorm just left opens again with no swap (#2284); another one swaps in, its own history with it.
        if (server.open || id !== currentId()) {
            server.saved = { ...server.saved, [currentId()]: server.history };
            server.history = server.saved[id] ?? [];
            server.id = id;
            server.swap++;
        }
        server.open = true;
        server.version++;
        return { state: state(), turns: [], resumebrief: true };
    }
    return state();
}

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

function commands(): string[] {
    return calls.map((c) => c.command);
}

// The brainstorm open in the view, as wavesrv first tells it: its past lines are not offered.
async function openModel(
    history: HistoryNote[] = [line(1, "brokk", "centre", "kids-video"), line(2, "brokk", "remove", "old")]
) {
    server = { version: 1, rev: 1, swap: 3, open: true, history };
    const model = BrainstormModel.getInstance();
    model.useCall(fakeCall);
    model.start();
    await settle();
    expect(commands()).toContain(StateCommand);
    calls = [];
    return model;
}

// Brokk's answer grows or prunes the graph: wavesrv's next state.
function brokk(model: BrainstormModel, op: string, id: string): void {
    server.history = [...server.history, line(server.history.length + 1, "brokk", op, id)];
    model.apply(changed());
}

beforeEach(() => {
    BrainstormModel.resetInstance();
    calls = [];
    session.lead = "";
});

describe("the developer edits the graph (FR-BOSS-010 AC27, #2247)", () => {
    it("sends the change with the brainstorm it was made on, and offers Undo for a removal", async () => {
        const model = await openModel();
        expect(globalStore.get(model.undoBarAtom)).toBeNull();
        expect(await model.remove("ages")).toBe(true);
        expect(calls[0]).toEqual({
            command: EditCommand,
            data: { ops: [{ op: "remove", id: "ages" }], swap: 3, id: "id-kids-video" },
        });
        const bar = globalStore.get(model.undoBarAtom);
        expect(bar).toMatchObject({ kind: "offer", note: { seq: 3, by: "you", op: "remove" } });
        expect(await model.undo(3)).toBe(true);
        expect(calls[1]).toEqual({ command: UndoCommand, data: { seq: 3, swap: 3, id: "id-kids-video" } });
        expect(globalStore.get(model.undoBarAtom)).toBeNull();
    });

    // Review of #2247: a new idea of Brokk's is another folder in the same swap; a change the view made on the one
    // before is refused, never applied to the new one.
    it("names the brainstorm a change was made on: one made on a folder since replaced is stale", async () => {
        const model = await openModel();
        server.id = "id-budget";
        server.history = [line(1, "brokk", "centre", "budget"), line(2, "brokk", "remove", "rent")];
        expect(await model.undo(2)).toBe(false);
        expect(calls.at(-1)).toMatchObject({ command: UndoCommand, data: { seq: 2, swap: 3, id: "id-kids-video" } });
        // The refusal brought the view the new brainstorm; another new idea replaces it before the next change.
        server.id = "id-garden";
        server.history = [line(1, "brokk", "centre", "garden")];
        expect(await model.remove("ages")).toBe(false);
        expect(calls.at(-1)).toMatchObject({ command: EditCommand, data: { swap: 3, id: "id-budget" } });
        expect(server.history).toHaveLength(1);
    });

    it("offers Undo for Brokk's removal or merge, never for his growth, nor for the past of a brainstorm", async () => {
        const model = await openModel();
        brokk(model, "add", "devices");
        expect(globalStore.get(model.undoBarAtom)).toBeNull();
        brokk(model, "merge", "parents-list");
        expect(globalStore.get(model.undoBarAtom)).toMatchObject({ kind: "offer", note: { by: "brokk", op: "merge" } });
        // Another brainstorm swaps in with removals in its history: none is offered.
        server.swap++;
        server.history = [line(1, "brokk", "remove", "elsewhere")];
        model.apply(changed());
        expect(globalStore.get(model.undoBarAtom)).toBeNull();
    });

    // His new idea starts a brainstorm of its own in the same view (the swap stays): its history counts from 1 again.
    it("follows a new idea of his: its first state offers nothing, its later removals are offered", async () => {
        const model = await openModel();
        for (let i = 0; i < 6; i++) {
            brokk(model, "add", `idea-${i}`);
        }
        server.id = "id-budget";
        server.history = [line(1, "brokk", "centre", "budget"), line(2, "brokk", "remove", "budget-old")];
        model.apply(changed());
        expect(globalStore.get(model.undoBarAtom)).toBeNull();
        brokk(model, "remove", "rent");
        expect(globalStore.get(model.undoBarAtom)).toMatchObject({ note: { seq: 3, op: "remove" } });
    });

    it("lets an offer go once its change is put back, here or in another view", async () => {
        const model = await openModel();
        brokk(model, "remove", "approved");
        const seq = server.history.length;
        expect(globalStore.get(model.undoBarAtom)).toMatchObject({ note: { seq } });
        server.history = server.history.map((n) => (n.seq === seq ? { ...n, undone: true, undoable: false } : n));
        model.apply(changed());
        expect(globalStore.get(model.undoBarAtom)).toBeNull();
    });

    it("never moves the camera for the developer's own change; Brokk's growth does", async () => {
        const model = await openModel();
        globalStore.set(model.talkAtAtom, 0);
        await model.retype("ages", "decision");
        expect(globalStore.get(model.talkAtAtom)).toBe(0);
        brokk(model, "add", "devices");
        expect(globalStore.get(model.talkAtAtom)).toBeGreaterThan(0);
    });

    it("says why a change or an undo did not go, in the bar", async () => {
        const model = await openModel();
        server.fail = "conflict";
        expect(await model.undo(2)).toBe(false);
        expect(globalStore.get(model.undoBarAtom)).toMatchObject({ kind: "failed", reason: "conflict" });
        server.fail = "invalid";
        expect(await model.remove("kids-video")).toBe(false);
        expect(globalStore.get(model.undoBarAtom)).toMatchObject({ kind: "failed", reason: "invalid" });
    });

    it("refuses nothing silently: a change on a brainstorm left meanwhile is dropped as stale", async () => {
        const model = await openModel();
        server.swap = 9;
        expect(await model.remove("ages")).toBe(false);
        expect(server.history.some((n) => n.by === "you")).toBe(false);
    });

    it("ties two plates with Link to… and a click on the other one", async () => {
        const model = await openModel();
        model.startLink("ages");
        expect(globalStore.get(model.linkingAtom)).toBe("ages");
        expect(await model.linkTo("ages")).toBe(false);
        model.startLink("ages");
        expect(await model.linkTo("three-ten")).toBe(true);
        expect(calls.at(-1).data.ops).toEqual([{ op: "link", a: "ages", b: "three-ten" }]);
        expect(globalStore.get(model.linkingAtom)).toBeNull();
    });

    it("saves an edited text only when it changed, as one plain line", async () => {
        const model = await openModel();
        model.startEdit("ages");
        expect(globalStore.get(model.editingAtom)).toBe("ages");
        expect(await model.saveText("ages", " For which ages? ")).toBe(false);
        expect(globalStore.get(model.editingAtom)).toBeNull();
        expect(commands()).not.toContain(EditCommand);
        expect(await model.saveText("ages", "Which\nages?")).toBe(true);
        expect(calls.at(-1).data.ops).toEqual([{ op: "edit", id: "ages", text: "Which ages?" }]);
        expect(await model.saveText("ages", "   ")).toBe(false);
    });

    it("puts back the developer's last change with Ctrl/⌘ + Z, never Brokk's", async () => {
        const model = await openModel();
        await model.remove("ages");
        brokk(model, "remove", "approved");
        expect(await model.undoLast()).toBe(true);
        expect(calls.at(-1)).toEqual({ command: UndoCommand, data: { seq: 3, swap: 3, id: "id-kids-video" } });
        expect(await model.undoLast()).toBe(false);
    });

    // Review of #2247: whose change it was is read from the lines a state added, not from the newest line alone.
    it("follows a block of Brokk's that changed the graph after a change of the developer's", async () => {
        const model = await openModel();
        await model.remove("ages");
        globalStore.set(model.talkAtAtom, 0);
        // His block: the graph's revision moves on with no line of its own (a link he unlinked was gone already).
        model.apply(changed());
        expect(globalStore.get(model.talkAtAtom)).toBeGreaterThan(0);
        globalStore.set(model.talkAtAtom, 0);
        // One state with a change of the developer's and a block of his.
        server.history = [...server.history, line(4, "you", "retype", "ages"), line(5, "brokk", "add", "devices")];
        model.apply(changed());
        expect(globalStore.get(model.talkAtAtom)).toBeGreaterThan(0);
    });
});

describe("Brokk hears of the developer's changes with their next message (AC27)", () => {
    it("puts the note after the brainstorm's lead, and marks the changes told once his answer to it comes", async () => {
        const model = await openModel();
        session.lead = "Brainstorm:";
        await model.remove("ages");
        expect(session.lead).toBe("Brainstorm: [My changes to the graph: removed “Text of ages” (ages).]");
        await model.retype("ages", "decision");
        expect(session.lead).toMatch(/^Brainstorm: \[My changes to the graph: removed .*; .* is now: .*\.\]$/);
        const sent = `${session.lead} And for teenagers?`;
        session.lead = "";
        session.tell({ id: "m7", you: sent, markdown: "Noted.", turn: 9, final: false });
        session.tell({ id: "m7", you: sent, markdown: "Noted, and…", turn: 9, final: false });
        await settle();
        expect(calls.filter((c) => c.command === ToldCommand)).toEqual([
            { command: ToldCommand, data: { seq: 4, swap: 3, id: "id-kids-video" } },
        ]);
        expect(session.lead).toBe("");
    });

    // Review of #2247: Leave, then Resume: the brainstorm's resume lead must not wipe the note of untold changes.
    it("keeps the note of untold changes through Leave and Resume, after the resume's lead", async () => {
        const model = await openModel();
        await model.remove("ages");
        server.open = false;
        model.apply(changed());
        expect(session.lead).toBe("");
        expect(await model.load("kids-video")).toBe(true);
        expect(server.swap).toBe(3);
        expect(session.lead).toBe(
            "Brainstorm resumed: “A safe video app”. [My changes to the graph: removed “Text of ages” (ages).]"
        );
        session.tell({ id: "m8", you: `${session.lead} Go on.`, markdown: "Going on.", turn: 10, final: false });
        await settle();
        expect(calls.filter((c) => c.command === ToldCommand).map((c) => c.data)).toEqual([
            { seq: 3, swap: 3, id: "id-kids-video" },
        ]);
    });

    // Review of #2247: a switch to another brainstorm inside the mode takes the note of the one left off the next
    // message, and an answer to a message sent before the switch marks nothing of the new one told.
    it("moves the note with a switch, and never tells a change across it", async () => {
        const model = await openModel();
        server.saved = { "id-budget": [line(1, "brokk", "centre", "budget"), line(2, "you", "remove", "rent")] };
        await model.remove("ages");
        const sent = `${session.lead} Go on.`;
        expect(sent).toContain("(ages)");
        expect(await model.load("budget")).toBe(true);
        expect(server.swap).toBe(4);
        // The budget's own untold change rides after its resume lead; the kids' one is gone.
        expect(session.lead).toBe(
            "Brainstorm resumed: “A safe video app”. [My changes to the graph: removed “Text of rent” (rent).]"
        );
        session.tell({ id: "m9", you: sent, markdown: "Going on.", turn: 11, final: false });
        await settle();
        expect(calls.filter((c) => c.command === ToldCommand)).toEqual([]);
        expect(server.history.find((n) => n.seq === 2)?.told).toBeFalsy();
    });

    it("tells nothing of a change undone before the message", async () => {
        const model = await openModel();
        await model.remove("ages");
        expect(session.lead).not.toBe("");
        await model.undo(3);
        expect(session.lead).toBe("");
    });

    it("takes the note off the next message when the brainstorm ends, and lets go of what it held", async () => {
        const model = await openModel();
        session.lead = "Brainstorm:";
        await model.remove("ages");
        model.startLink("ages");
        server.open = false;
        model.apply(changed());
        expect(session.lead).toBe("Brainstorm:");
        expect(globalStore.get(model.linkingAtom)).toBeNull();
        expect(globalStore.get(model.undoBarAtom)).toBeNull();
    });
});
