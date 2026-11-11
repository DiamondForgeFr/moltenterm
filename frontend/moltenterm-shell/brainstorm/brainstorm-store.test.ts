// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from "vitest";

const hold = vi.fn();
const setMeta = vi.fn();
const toasts: any[] = [];
const gate = { allowed: true };

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    return {
        atoms: { uiContext: atom({ windowid: "w1" }) },
        getApi: () => ({ moltentermSystemNotifyHold: hold }),
    };
});
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: (...args: any[]) => setMeta(...args) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("../build/current-build", () => ({ currentBrainstormAllowed: () => gate.allowed }));
vi.mock("../i18n/i18n", () => ({
    t: (key: string, vars?: any) => (vars?.name ? `${key}(${vars.name})` : key),
    tCount: (key: string, count: number) => `${key}:${count}`,
}));
vi.mock("../notifications-model", () => ({ notificationTitle: (e: any) => e.title }));
vi.mock("../toast-store", () => ({ showToast: (input: any) => toasts.push(input) }));
vi.mock("../agent-state-store", async () => {
    const { atom } = await import("jotai");
    const dataAtom = atom({ states: {}, versions: {} });
    return { AgentStates: { getInstance: () => ({ dataAtom }) } };
});
vi.mock("../notifications-store", async () => {
    const { atom } = await import("jotai");
    const { globalStore } = await import("@/app/store/jotaiStore");
    const entriesAtom = atom([]);
    return {
        MoltentermNotifications: { getInstance: () => ({ entriesAtom, entries: () => globalStore.get(entriesAtom) }) },
    };
});
vi.mock("../tab-activity", async () => {
    const { atom } = await import("jotai");
    const onScreenAtom = atom(true);
    return { TabActivity: { getInstance: () => ({ onScreenAtom }) } };
});
vi.mock("../sidebar/sidebar-store", async () => {
    const { atom } = await import("jotai");
    const { globalStore } = await import("@/app/store/jotaiStore");
    const hiddenAtom = atom(false);
    const windowMetaAtom = atom({});
    return {
        SidebarModel: {
            getInstance: () => ({
                hiddenAtom,
                windowMetaAtom,
                isEnabled: () => true,
                isHidden: () => globalStore.get(hiddenAtom),
                setHidden: (hidden: boolean) => globalStore.set(hiddenAtom, hidden),
            }),
        },
    };
});
vi.mock("../boss/boss-store", async () => {
    const { atom } = await import("jotai");
    const { globalStore } = await import("@/app/store/jotaiStore");
    const cardOpenAtom = atom(false);
    const nameAtom = atom("Brokk");
    const boss = {
        cardOpenAtom,
        nameAtom,
        openCard: () => globalStore.set(cardOpenAtom, true),
        closeCard: () => globalStore.set(cardOpenAtom, false),
        pinCard: () => {},
        showPanel: vi.fn(),
    };
    return { BossBubbleModel: { getInstance: () => boss } };
});
vi.mock("../boss/brokk-session", async () => {
    const { atom } = await import("jotai");
    const speakingAtom = atom(false);
    const listeners = new Set<(a: any) => void>();
    const session = {
        speakingAtom,
        lines: [] as string[],
        lead: "",
        listenAnswers: (fn: (a: any) => void) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        tell: (a: any) => listeners.forEach((fn) => fn(a)),
        addLocalLine: (text: string) => session.lines.push(text),
        setLead: (lead: string) => {
            session.lead = lead;
        },
    };
    return { BrokkSession: { getInstance: () => session } };
});

import { globalStore } from "@/app/store/jotaiStore";
import { AgentStates } from "../agent-state-store";
import { BossBubbleModel } from "../boss/boss-store";
import { BrokkSession } from "../boss/brokk-session";
import { MoltentermNotifications } from "../notifications-store";
import { SidebarModel } from "../sidebar/sidebar-store";
import { brainstormHolds } from "./brainstorm-hold";
import {
    BrainstormModel,
    CloseCommand,
    OpenCommand,
    SidebarSlidMetaKey,
    StateCommand,
    TurnCommand,
} from "./brainstorm-store";

const session = BrokkSession.getInstance() as any;
const boss = BossBubbleModel.getInstance() as any;
const sidebar = SidebarModel.getInstance() as any;
const notifications = MoltentermNotifications.getInstance() as any;
const agents = AgentStates.getInstance() as any;

// A wavesrv of the test: the mode's state and the calls it got.
let calls: { command: string; data: any }[];
let server: { open: boolean; version: number; nodes: number };

function state(): any {
    return {
        allowed: true,
        open: server.open,
        version: server.version,
        graph: { schema: 1, rev: server.nodes, centre: "c", nodes: [], links: [] },
    };
}

async function fakeCall(command: string, data: any): Promise<any> {
    calls.push({ command, data });
    if (command === OpenCommand) {
        server.open = true;
        server.version++;
    }
    if (command === CloseCommand && server.open) {
        server.open = false;
        server.version++;
    }
    if (command === TurnCommand) {
        if (!server.open && data.block != null) {
            server.open = true;
        }
        server.nodes++;
        server.version++;
        return { state: state(), applied: true };
    }
    return state();
}

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve();
    }
}

const opening =
    'Let\'s put it on the anvil.\n\n```brokk-graph\n{"v":1,"talk":"project","ops":[{"op":"centre","id":"c","text":"An idea"}]}\n```';

beforeEach(async () => {
    BrainstormModel.resetInstance();
    calls = [];
    server = { open: false, version: 1, nodes: 0 };
    toasts.length = 0;
    hold.mockClear();
    setMeta.mockClear();
    gate.allowed = true;
    session.lines.length = 0;
    session.lead = "";
    globalStore.set(boss.cardOpenAtom, false);
    globalStore.set(sidebar.hiddenAtom, false);
    globalStore.set(sidebar.windowMetaAtom, {});
    globalStore.set(notifications.entriesAtom, []);
    globalStore.set(agents.dataAtom, { states: {}, versions: {} });
});

function startModel(): BrainstormModel {
    const model = BrainstormModel.getInstance();
    model.useCall(fakeCall);
    model.start();
    return model;
}

describe("the brainstorm mode in a view (FR-BOSS-010, #2246)", () => {
    it("does nothing on a release channel", async () => {
        gate.allowed = false;
        const model = startModel();
        await settle();
        session.tell({ id: "m1", you: "An idea", markdown: opening, turn: 3, final: true });
        await model.begin();
        await settle();
        expect(calls).toEqual([]);
        expect(globalStore.get(model.stateAtom)).toBeNull();
    });

    // AC2: his answer opens it; the pause holds (AC3); the sidebar slides in.
    it("opens with his central idea, holds the notifications and slides the sidebar in", async () => {
        const model = startModel();
        await settle();
        session.tell({ id: "m1", you: "I have an idea", markdown: opening, turn: 3, final: false });
        session.tell({ id: "m1", you: "I have an idea", markdown: opening, turn: 3, final: true });
        await settle();
        const turns = calls.filter((c) => c.command === TurnCommand);
        expect(turns).toHaveLength(1);
        expect(turns[0].data).toMatchObject({ you: "I have an idea", brokk: "Let's put it on the anvil." });
        expect(turns[0].data.block.ops[0]).toMatchObject({ op: "centre", id: "c" });
        expect(model.isOpen()).toBe(true);
        expect(brainstormHolds()).toBe(true);
        expect(hold).toHaveBeenLastCalledWith(true);
        expect(globalStore.get(boss.cardOpenAtom)).toBe(true);
        expect(sidebar.isHidden()).toBe(true);
        expect(setMeta).toHaveBeenCalledWith({}, { oref: "window:w1", meta: { [SidebarSlidMetaKey]: true } });
    });

    // AC2: the developer starts it from his menu; he says so, and the next message says it is a brainstorm.
    it("starts on the developer's demand with his opening line", async () => {
        const model = startModel();
        await settle();
        await model.begin();
        expect(calls.map((c) => c.command)).toContain(OpenCommand);
        expect(calls.find((c) => c.command === OpenCommand).data).toEqual({ by: "you" });
        expect(session.lines).toEqual(["boss.brainstorm.opening(Brokk)"]);
        expect(session.lead).toBe("boss.brainstorm.lead");
        expect(model.isOpen()).toBe(true);
    });

    // #2257: `/brainstorm <idea>` in his field opens the mode at once; the idea is the next message, so he says no
    // opening line of his own, and the message tells his session it is a brainstorm.
    it("starts with the developer's idea, without his opening line", async () => {
        const model = startModel();
        await settle();
        await model.begin(true);
        expect(calls.find((c) => c.command === OpenCommand).data).toEqual({ by: "you" });
        expect(session.lines).toEqual([]);
        expect(session.lead).toBe("boss.brainstorm.lead");
        expect(model.isOpen()).toBe(true);
    });

    // AC2, AC3: closing his card ends it; one summary line for what arrived, the critical one broke through at the edge.
    it("ends with his card, says once how many things arrived, and brings the sidebar back", async () => {
        const model = startModel();
        await settle();
        await model.begin();
        globalStore.set(sidebar.windowMetaAtom, { [SidebarSlidMetaKey]: true });
        globalStore.set(notifications.entriesAtom, [
            { id: "a", source: "build", kind: "info", title: "Build done", time: 2, updated: 2, read: false },
            {
                id: "b",
                source: "trust",
                kind: "warning",
                title: "A run waits for your trust",
                time: 3,
                updated: 3,
                read: false,
            },
        ]);
        expect(globalStore.get(model.breakthroughAtom)).toMatchObject({
            kind: "trust",
            text: "A run waits for your trust",
        });
        globalStore.set(agents.dataAtom, {
            states: { blk: { blockid: "blk", state: "error", firstname: "Léa" } },
            versions: {},
        });
        expect(globalStore.get(model.breakthroughAtom)).toMatchObject({
            kind: "crash",
            text: "boss.brainstorm.crashedNamed(Léa)",
        });
        expect(toasts).toEqual([]);
        boss.closeCard();
        await settle();
        expect(calls.map((c) => c.command)).toContain(CloseCommand);
        expect(model.isOpen()).toBe(false);
        expect(brainstormHolds()).toBe(false);
        expect(hold).toHaveBeenLastCalledWith(false);
        expect(toasts).toHaveLength(1);
        expect(toasts[0].title).toBe("boss.brainstorm.summary:2");
        expect(sidebar.isHidden()).toBe(false);
        expect(globalStore.get(model.breakthroughAtom)).toBeNull();
    });

    it("sends the words of each turn of the mode once, with no block when he drew nothing", async () => {
        const model = startModel();
        await settle();
        await model.begin();
        session.tell({ id: "m2", you: "Brainstorm: an app", markdown: "What does it do?", turn: 4, final: false });
        session.tell({ id: "m2", you: "Brainstorm: an app", markdown: "What does it do?", turn: 4, final: true });
        session.tell({ id: "m2", you: "Brainstorm: an app", markdown: "What does it do?", turn: 4, final: true });
        await settle();
        const turns = calls.filter((c) => c.command === TurnCommand);
        expect(turns).toHaveLength(1);
        expect(turns[0].data).toMatchObject({ brokk: "What does it do?", block: null });
    });

    it("takes a brainstorm up where it was when the developer starts one after a restart", async () => {
        const model = startModel();
        await settle();
        model.useCall(async (command, data) => {
            const rtn = await fakeCall(command, data);
            return command === OpenCommand
                ? { ...rtn, brainstorm: { slug: "forge-notes", title: "Forge notes" } }
                : rtn;
        });
        await model.begin();
        expect(session.lines).toEqual(["boss.brainstorm.resume"]);
    });

    // AC2: a tab switch keeps the mode; the view switched to opens his card, and closes it when the mode ends elsewhere.
    it("opens his card in the view switched to, and closes it with the mode", async () => {
        const activity = (await import("../tab-activity")).TabActivity.getInstance() as any;
        globalStore.set(activity.onScreenAtom, false);
        const model = startModel();
        await settle();
        model.apply({ allowed: true, open: true, version: 5 });
        expect(globalStore.get(boss.cardOpenAtom)).toBe(false);
        globalStore.set(activity.onScreenAtom, true);
        expect(globalStore.get(boss.cardOpenAtom)).toBe(true);
        model.apply({ allowed: true, open: false, version: 6 });
        expect(globalStore.get(boss.cardOpenAtom)).toBe(false);
        expect(calls.filter((c) => c.command === CloseCommand)).toHaveLength(0);
    });

    it("drops a state older than the one it has", async () => {
        const model = startModel();
        await settle();
        model.apply({ allowed: true, open: true, session: "s1", version: 9 });
        model.apply({ allowed: true, open: false, session: "s1", version: 4 });
        expect(model.isOpen()).toBe(true);
        expect(calls.filter((c) => c.command === StateCommand)).toHaveLength(1);
    });

    it("takes the states of a restarted wavesrv, which counts from 0 again", async () => {
        const model = startModel();
        await settle();
        model.apply({ allowed: true, open: true, session: "s1", version: 9 });
        model.apply({ allowed: true, open: false, session: "s2", version: 1 });
        expect(model.isOpen()).toBe(false);
        model.apply({ allowed: true, open: true, session: "s2", version: 0 });
        expect(model.isOpen()).toBe(false);
    });
});
