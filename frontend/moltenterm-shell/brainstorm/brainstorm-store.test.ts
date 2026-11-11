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
    const listeners = new Set<(a: any) => void>();
    const session = {
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
        shown: null as any[],
        showConversation: (turns: any[]) => {
            session.shown = turns;
        },
        said: [] as { text: string; lead: string }[],
        say: async (text: string) => {
            session.said.push({ text, lead: session.lead });
            return { phase: "answering" };
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
    DeleteCommand,
    FindCommand,
    ForkCommand,
    ListCommand,
    LoadCommand,
    NewCommand,
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

// A wavesrv of the test: the mode's state, the synthetic folders it holds, and the calls it got.
let calls: { command: string; data: any }[];
let server: { open: boolean; version: number; nodes: number; current: any; folders: any[] };

const folder = (slug: string, title: string, updated: number) => ({
    id: `id-${slug}`,
    slug,
    title,
    dir: `/synthetic/Brainstorms/${slug}`,
    created: 1,
    updated,
    state: "open",
    turns: 0,
});

function state(): any {
    return {
        allowed: true,
        open: server.open,
        version: server.version,
        brainstorm: server.current ?? undefined,
        graph: { schema: 1, rev: server.nodes, centre: "c", nodes: [], links: [] },
    };
}

async function fakeCall(command: string, data: any): Promise<any> {
    calls.push({ command, data });
    if (command === ListCommand) {
        return { brainstorms: server.folders };
    }
    if (command === FindCommand) {
        const match = server.folders.find((f) => f.title.toLowerCase() === String(data.title).toLowerCase());
        return match != null ? { match } : {};
    }
    if (command === LoadCommand) {
        const match = server.folders.find((f) => f.slug === data.slug);
        if (match == null) {
            return { state: state(), turns: [], error: "unknown" };
        }
        server.open = true;
        server.current = match;
        server.version++;
        return {
            state: state(),
            turns: [
                { turn: 1, at: 1, role: "you", text: `About ${match.title}` },
                { turn: 1, at: 1, role: "brokk", text: "Where were we?" },
            ],
        };
    }
    if (command === NewCommand) {
        server.open = true;
        server.current = null;
        server.version++;
        return { state: state() };
    }
    if (command === DeleteCommand) {
        const match = server.folders.find((f) => f.slug === data.slug);
        server.folders = server.folders.filter((f) => f.slug !== data.slug);
        server.version++;
        return { state: state(), summary: match, trashed: true };
    }
    if (command === ForkCommand) {
        server.current = folder("parental-control", data.title, 9);
        server.folders = [server.current, ...server.folders];
        server.version++;
        return { state: state(), turns: [] };
    }
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
    server = { open: false, version: 1, nodes: 0, current: null, folders: [] };
    toasts.length = 0;
    hold.mockClear();
    setMeta.mockClear();
    gate.allowed = true;
    session.lines.length = 0;
    session.lead = "";
    session.shown = null;
    session.said.length = 0;
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
    // #2259: the camera follows his words from each reading of his answer, the session holding no speaking flag.
    it("marks that he spoke at each reading of his answer", async () => {
        const model = startModel();
        await settle();
        globalStore.set(model.talkAtAtom, 0);
        session.tell({ id: "m1", you: "Hello", markdown: "Hello there.", turn: 3, final: false });
        expect(globalStore.get(model.talkAtAtom)).toBeGreaterThan(0);
    });

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
        expect(await model.begin("A garden planner")).toBe(true);
        expect(calls.find((c) => c.command === OpenCommand).data).toEqual({ by: "you" });
        expect(calls.find((c) => c.command === FindCommand).data).toEqual({ title: "A garden planner" });
        expect(session.lines).toEqual([]);
        expect(session.lead).toBe("boss.brainstorm.lead");
        expect(model.isOpen()).toBe(true);
        expect(globalStore.get(model.promptAtom)).toBeNull();
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

const graphAnswer = (line: string, ops: any[]) =>
    `${line}\n\n\`\`\`brokk-graph\n${JSON.stringify({ v: 1, talk: "project", ops })}\n\`\`\``;

const commands = () => calls.map((c) => c.command);

describe("the brainstorm folders (FR-BOSS-010 AC10a to AC10d, AC11, #2248)", () => {
    // AC10a: the developer's start offers the three most recent, a new idea and all of them; nothing is resumed yet.
    it("opens on a picker of the saved brainstorms, and resumes the one picked", async () => {
        server.folders = [
            folder("family-budget", "A family budget", 40),
            folder("kids-video", "A safe video app for children", 30),
            folder("forge-notes", "Forge notes", 20),
            folder("garden", "A garden planner", 10),
        ];
        const model = startModel();
        await settle();
        expect(await model.begin()).toBe(false);
        const prompt: any = globalStore.get(model.promptAtom);
        expect(prompt.kind).toBe("picker");
        expect(prompt.recent.map((f: any) => f.slug)).toEqual(["family-budget", "kids-video", "forge-notes"]);
        expect(prompt.total).toBe(4);
        expect(session.lines).toEqual([]);
        expect(commands()).not.toContain(LoadCommand);
        expect(model.isOpen()).toBe(true);

        expect(await model.load("kids-video")).toBe(true);
        expect(calls.find((c) => c.command === LoadCommand).data).toEqual({ slug: "kids-video" });
        expect(globalStore.get(model.promptAtom)).toBeNull();
        expect(session.shown.map((turn: any) => turn.text)).toEqual([
            "About A safe video app for children",
            "Where were we?",
        ]);
        expect(session.lines).toEqual(["boss.brainstorm.resume"]);
        expect(session.lead).toBe("boss.brainstorm.resumedLead");
        expect(globalStore.get(model.stateAtom).brainstorm.slug).toBe("kids-video");
    });

    it("says his opening line when nothing is saved yet", async () => {
        const model = startModel();
        await settle();
        await model.begin();
        expect(globalStore.get(model.promptAtom)).toBeNull();
        expect(session.lines).toEqual(["boss.brainstorm.opening(Brokk)"]);
    });

    it("unfolds the widget for all brainstorms, and starts a new idea over", async () => {
        server.folders = [folder("forge-notes", "Forge notes", 20)];
        const model = startModel();
        await settle();
        await model.begin();
        model.showAll();
        expect(globalStore.get(model.widgetOpenAtom)).toBe(true);
        expect(globalStore.get(model.promptAtom)).toBeNull();
        await model.newIdea();
        expect(commands()).toContain(NewCommand);
        expect(session.shown).toEqual([]);
        expect(session.lines).toEqual(["boss.brainstorm.opening(Brokk)"]);
        expect(session.lead).toBe("boss.brainstorm.lead");
        expect(globalStore.get(model.widgetOpenAtom)).toBe(false);
    });

    // AC10a: `/brainstorm <idea>` of a title already saved asks first, and the idea goes only on Start fresh.
    it("asks before a near-duplicate idea, and sends it only on Start fresh", async () => {
        server.folders = [folder("kids-video", "A safe video app for children", 30)];
        const model = startModel();
        await settle();
        expect(await model.begin("a safe video app for children")).toBe(false);
        const prompt: any = globalStore.get(model.promptAtom);
        expect(prompt).toMatchObject({
            kind: "duplicate",
            idea: "a safe video app for children",
            match: { slug: "kids-video" },
        });
        expect(session.said).toEqual([]);
        expect(session.lead).toBe("");
        await model.startFresh(prompt.idea);
        expect(commands()).toContain(NewCommand);
        expect(commands()).not.toContain(LoadCommand);
        expect(session.said).toEqual([{ text: "a safe video app for children", lead: "boss.brainstorm.lead" }]);
    });

    // AC10b: his offer to resume one never opens it; only Resume does, and Not now leaves everything as it was.
    it("turns his resume offer into a question, and never loads by itself", async () => {
        server.folders = [folder("forge-notes", "Forge notes", 20)];
        const model = startModel();
        await settle();
        const offer = graphAnswer("Shall we pick up Forge notes?", [{ op: "resume", title: "Forge notes" }]);
        session.tell({ id: "m1", you: "Remember my notes idea?", markdown: offer, turn: 7, final: false });
        await settle();
        expect(globalStore.get(model.promptAtom)).toBeNull();
        session.tell({ id: "m1", you: "Remember my notes idea?", markdown: offer, turn: 7, final: true });
        session.tell({ id: "m1", you: "Remember my notes idea?", markdown: offer, turn: 7, final: true });
        await settle();
        expect(globalStore.get(model.promptAtom)).toMatchObject({ kind: "resume", match: { slug: "forge-notes" } });
        expect(calls.filter((c) => c.command === FindCommand)).toHaveLength(1);
        expect(commands()).not.toContain(LoadCommand);
        expect(commands()).not.toContain(TurnCommand);
        expect(model.isOpen()).toBe(false);
        model.dismissPrompt();
        expect(globalStore.get(model.promptAtom)).toBeNull();
        expect(model.isOpen()).toBe(false);
        // A title nothing is saved under asks nothing.
        const unknown = graphAnswer("Shall we?", [{ op: "resume", title: "A rocket" }]);
        session.tell({ id: "m2", you: "Rockets?", markdown: unknown, turn: 8, final: true });
        await settle();
        expect(globalStore.get(model.promptAtom)).toBeNull();
    });

    // AC10c: a switch from the widget moves without leaving the mode; the conversation swaps.
    it("switches to another brainstorm without leaving the mode", async () => {
        server.folders = [
            folder("forge-notes", "Forge notes", 20),
            folder("kids-video", "A safe video app for children", 30),
        ];
        const model = startModel();
        await settle();
        await model.load("kids-video");
        globalStore.set(model.widgetOpenAtom, true);
        await model.load("forge-notes");
        expect(model.isOpen()).toBe(true);
        expect(commands()).not.toContain(CloseCommand);
        expect(globalStore.get(model.stateAtom).brainstorm.slug).toBe("forge-notes");
        expect(session.shown[0].text).toBe("About Forge notes");
        expect(globalStore.get(model.widgetOpenAtom)).toBe(false);
        expect(await model.load("gone")).toBe(false);
        expect(globalStore.get(model.noticeAtom)).toEqual({ kind: "failed", failure: "unknown" });
    });

    // AC10d: his forget is a question; the folder goes only on the developer's confirmation.
    it("forgets a brainstorm only after the developer confirms", async () => {
        server.folders = [folder("family-budget", "A family budget", 40)];
        const model = startModel();
        await settle();
        const forget = graphAnswer("MoltenTerm asks you to confirm.", [{ op: "forget", title: "A family budget" }]);
        session.tell({ id: "m1", you: "Forget the family budget idea", markdown: forget, turn: 9, final: true });
        await settle();
        expect(globalStore.get(model.promptAtom)).toMatchObject({ kind: "forget", match: { slug: "family-budget" } });
        expect(commands()).not.toContain(DeleteCommand);
        model.dismissPrompt();
        expect(commands()).not.toContain(DeleteCommand);
        expect(server.folders).toHaveLength(1);

        session.tell({ id: "m2", you: "Forget it, really", markdown: forget, turn: 10, final: true });
        await settle();
        expect(await model.forgetFolder("family-budget")).toBe(true);
        expect(calls.filter((c) => c.command === DeleteCommand).map((c) => c.data)).toEqual([
            { slug: "family-budget" },
        ]);
        expect(globalStore.get(model.promptAtom)).toBeNull();
        expect(session.lines).toEqual(["boss.brainstorm.forgotTrash"]);
        expect(server.folders).toEqual([]);
    });

    // AC11: his fork asks in the widget; No changes nothing, Yes makes the folder and moves to it.
    it("asks about another project, and forks only on Yes", async () => {
        server.folders = [folder("kids-video", "A safe video app for children", 30)];
        const model = startModel();
        await settle();
        await model.load("kids-video");
        const fork = graphAnswer("Another project?", [
            { op: "fork", title: "Parental control for games", reason: "another product" },
        ]);
        session.tell({ id: "m1", you: "And games?", markdown: fork, turn: 11, final: true });
        await settle();
        expect(globalStore.get(model.forkAtom)).toMatchObject({
            title: "Parental control for games",
            reason: "another product",
        });
        model.forkNo();
        expect(globalStore.get(model.forkAtom)).toBeNull();
        expect(commands()).not.toContain(ForkCommand);

        session.tell({ id: "m2", you: "Games again", markdown: fork, turn: 12, final: true });
        await settle();
        expect(await model.forkYes()).toBe(true);
        expect(calls.find((c) => c.command === ForkCommand).data).toEqual({
            title: "Parental control for games",
            reason: "another product",
        });
        expect(globalStore.get(model.stateAtom).brainstorm.slug).toBe("parental-control");
        expect(session.shown).toEqual([]);
        expect(session.lead).toBe("boss.brainstorm.resumedLead");
    });

    it("asks nothing on a release channel", async () => {
        gate.allowed = false;
        server.folders = [folder("forge-notes", "Forge notes", 20)];
        const model = startModel();
        await settle();
        const offer = graphAnswer("Shall we?", [{ op: "resume", title: "Forge notes" }]);
        session.tell({ id: "m1", you: "Notes?", markdown: offer, turn: 7, final: true });
        await settle();
        expect(await model.load("forge-notes")).toBe(false);
        expect(await model.forgetFolder("forge-notes")).toBe(false);
        expect(calls).toEqual([]);
        expect(globalStore.get(model.promptAtom)).toBeNull();
    });
});
