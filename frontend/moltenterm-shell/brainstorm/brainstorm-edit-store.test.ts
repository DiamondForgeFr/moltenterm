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
import { BrainstormModel, EditCommand, StateCommand, ToldCommand, UndoCommand } from "./brainstorm-store";

const session = BrokkSession.getInstance() as any;

// A wavesrv of the test: one open brainstorm, its graph's revision and its history; it applies the developer's
// changes and undoes, as pkg/molten/brainstorm does, in short.
let calls: { command: string; data: any }[];
let server: { version: number; rev: number; swap: number; open: boolean; history: HistoryNote[]; fail?: string };

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
        if (data.swap !== server.swap) {
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
        server.history = server.history.map((n) => (n.by === "you" && n.seq <= data.seq ? { ...n, told: true } : n));
        server.version++;
        return state();
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
        expect(calls[0]).toEqual({ command: EditCommand, data: { ops: [{ op: "remove", id: "ages" }], swap: 3 } });
        const bar = globalStore.get(model.undoBarAtom);
        expect(bar).toMatchObject({ kind: "offer", note: { seq: 3, by: "you", op: "remove" } });
        expect(await model.undo(3)).toBe(true);
        expect(calls[1]).toEqual({ command: UndoCommand, data: { seq: 3, swap: 3 } });
        expect(globalStore.get(model.undoBarAtom)).toBeNull();
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
        expect(calls.at(-1)).toEqual({ command: UndoCommand, data: { seq: 3, swap: 3 } });
        expect(await model.undoLast()).toBe(false);
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
        expect(calls.filter((c) => c.command === ToldCommand)).toEqual([{ command: ToldCommand, data: { seq: 4 } }]);
        expect(session.lead).toBe("");
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
