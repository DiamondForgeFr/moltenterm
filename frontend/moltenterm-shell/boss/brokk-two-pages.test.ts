// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Two workspaces are two pages: each loads its own modules (vi.resetModules between the two loads), so each has its own
// store, its own BossBubbleModel and its own BrokkMarks, as in the app. They share only the client's meta, written
// through each page's BrokkMarks and echoed to every page a moment later, as wavesrv does (FR-BOSS-009, AC105, AC106,
// #2391).

const m = vi.hoisted(() => ({
    meta: new Map<string, unknown>(),
    listeners: new Set<() => void>(),
    writes: 0,
}));

vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(async () => {}) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: () => () => {} }));
vi.mock("../agent-handoff", () => ({
    AgentHandoffPendingEvent: "molten:agenthandoffpending",
    readPendingHandoffs: vi.fn(async () => []),
    answerAgentHandoff: vi.fn(),
}));
vi.mock("../agent-state-store", async () => {
    const { atom } = await import("jotai");
    const dataAtom = atom({ states: {}, versions: {} });
    const loadedAtom = atom(true);
    return { AgentStates: { getInstance: () => ({ dataAtom, loadedAtom }) } };
});
vi.mock("../notifications-store", async () => {
    const { atom } = await import("jotai");
    const entriesAtom = atom([]);
    return {
        MoltentermNotifications: {
            getInstance: () => ({ entriesAtom, shownEntriesAtom: entriesAtom, clear: vi.fn() }),
        },
        registerNotificationGesture: vi.fn(),
    };
});
vi.mock("../sessions/sessions-store", async () => {
    const { atom } = await import("jotai");
    const dataAtom = atom(null);
    return { DurableSessions: { getInstance: () => ({ dataAtom }) } };
});

type AgentInfo = { blockid: string; workspaceid: string; agent: string; state: string; since: number; version: number };

async function loadPage() {
    vi.resetModules();
    // A store of its own, as each page has.
    const { atom, createStore } = await import("jotai");
    const pageStore = createStore();
    vi.doMock("@/app/store/jotaiStore", () => ({ globalStore: pageStore }));
    vi.doMock("@/app/store/global", () => ({
        globalStore: pageStore,
        atoms: { uiContext: atom({ windowid: "w1" }) },
        getSettingsKeyAtom: () => atom(undefined),
        WOS: {
            makeORef: (type: string, id: string) => `${type}:${id}`,
            getObjectValue: () => ({ meta: {} }),
            getWaveObjectAtom: () => atom(null),
        },
    }));
    const { globalStore } = await import("@/app/store/jotaiStore");
    const { BossBubbleModel } = await import("./boss-store");
    const { BrokkMarks } = await import("./brokk-marks-store");
    const { AgentStates } = await import("../agent-state-store");
    const model = BossBubbleModel.getInstance();
    const marks = BrokkMarks.getInstance();
    return {
        globalStore,
        model,
        marks,
        connect: () =>
            marks.useDeps({
                now: () => Date.now(),
                read: () => Object.fromEntries(m.meta),
                // wavesrv merges the meta key by key and tells every page a moment later.
                write: (patch) => {
                    m.writes++;
                    queueMicrotask(() => {
                        Object.entries(patch).forEach(([key, value]) => m.meta.set(key, value));
                        m.listeners.forEach((listener) => listener());
                    });
                },
                subscribe: (listener) => {
                    m.listeners.add(listener);
                    return () => m.listeners.delete(listener);
                },
            }),
        setAgents: (...infos: AgentInfo[]) =>
            globalStore.set(AgentStates.getInstance().dataAtom as any, {
                states: Object.fromEntries(infos.map((info) => [info.blockid, info])),
                versions: {},
            }),
        badge: () => globalStore.get(model.badgeAtom).count,
        rows: () => globalStore.get(model.toHandleAtom).items.map((item) => item.key),
    };
}

type Page = Awaited<ReturnType<typeof loadPage>>;

let a: Page;
let b: Page;

// Each page is a whole module graph: loaded once, before the tests, with time to spare.
beforeAll(async () => {
    a = await loadPage();
    b = await loadPage();
}, 60000);

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function waiting(blockid: string, since: number): AgentInfo {
    return { blockid, workspaceid: "w1", agent: "claude", state: "waiting", since, version: 1 };
}

let stops: (() => void)[] = [];

beforeEach(async () => {
    stops.forEach((stop) => stop());
    m.meta.clear();
    m.listeners.clear();
    for (const page of [a, b]) {
        page.connect();
        page.setAgents(waiting("x", 7), waiting("y", 9));
    }
    stops = [a.marks.start(), b.marks.start()];
    await settle();
});

describe("a gesture in one workspace shows in the other (FR-BOSS-009, AC105, AC106, #2391)", () => {
    it("are two pages with their own models", () => {
        expect(a.model).not.toBe(b.model);
        expect(a.globalStore).not.toBe(b.globalStore);
        expect(a.badge()).toBe(2);
        expect(b.badge()).toBe(2);
    });

    it("sets a row aside in page B when page A does, and gives it back when B opens his group", async () => {
        a.model.park("agent:x");
        expect(a.badge()).toBe(1);
        await settle();
        expect(b.rows()).toEqual(["agent:y"]);
        expect(b.badge()).toBe(1);
        b.model.heard();
        await settle();
        expect(a.rows().sort()).toEqual(["agent:x", "agent:y"]);
        expect(a.globalStore.get(a.marks.heardAtAtom)).toBe(b.globalStore.get(b.marks.heardAtAtom));
    });

    it("takes a row settled in page A out of page B", async () => {
        const stopA = a.model.attach({ addEventListener: () => {}, removeEventListener: () => {} });
        const stopB = b.model.attach({ addEventListener: () => {}, removeEventListener: () => {} });
        a.model.settleRow({ key: "agent:y", since: 9, tone: "waiting" });
        await settle();
        expect(b.rows()).toEqual(["agent:x"]);
        expect(b.badge()).toBe(a.badge());
        stopA();
        stopB();
    });

    it("keeps both rows set aside at the same moment in two pages: no mark is lost", async () => {
        a.model.park("agent:x");
        b.model.park("agent:y");
        await settle();
        await settle();
        expect(a.badge()).toBe(0);
        expect(b.badge()).toBe(0);
    });
});
