// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
    setMeta: vi.fn(),
    readPending: vi.fn(),
    handlers: new Map<string, ((event: unknown) => void)[]>(),
}));

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    const { globalStore } = await import("@/app/store/jotaiStore");
    const settings = atom({} as Record<string, unknown>);
    const windowObject = atom({ meta: {} } as { meta: Record<string, unknown> });
    const workspaces = atom({} as Record<string, { name: string }>);
    return {
        globalStore,
        atoms: { uiContext: atom({ windowid: "w1" }) },
        getSettingsKeyAtom: (key: string) => atom((get) => get(settings)[key]),
        WOS: {
            makeORef: (type: string, id: string) => `${type}:${id}`,
            getObjectValue: (_oref: string, get: (a: unknown) => unknown) => get(windowObject),
            getWaveObjectAtom: (oref: string) => atom((get) => get(workspaces)[oref] ?? null),
        },
        TestAtoms: { settings, windowObject, workspaces },
    };
});
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: m.setMeta } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("@/app/store/wps", () => ({
    waveEventSubscribeSingle: (sub: { eventType: string; handler: (event: unknown) => void }) => {
        m.handlers.set(sub.eventType, [...(m.handlers.get(sub.eventType) ?? []), sub.handler]);
        return () => {
            m.handlers.set(
                sub.eventType,
                (m.handlers.get(sub.eventType) ?? []).filter((handler) => handler !== sub.handler)
            );
        };
    },
}));
vi.mock("../agent-handoff", () => ({
    AgentHandoffPendingEvent: "molten:agenthandoffpending",
    readPendingHandoffs: m.readPending,
    answerAgentHandoff: vi.fn(),
}));
vi.mock("../agent-state-store", async () => {
    const { atom } = await import("jotai");
    const dataAtom = atom({ states: {}, versions: {} });
    const loadedAtom = atom(false);
    return { AgentStates: { getInstance: () => ({ dataAtom, loadedAtom }) } };
});
vi.mock("../notifications-store", async () => {
    const { atom } = await import("jotai");
    const entriesAtom = atom([]);
    return { MoltentermNotifications: { getInstance: () => ({ entriesAtom, shownEntriesAtom: entriesAtom }) } };
});
vi.mock("../sessions/sessions-store", async () => {
    const { atom } = await import("jotai");
    const dataAtom = atom(null);
    return { DurableSessions: { getInstance: () => ({ dataAtom }) } };
});

import * as GlobalMock from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { PendingHandoff } from "../agent-handoff-types";
import { AgentStateInfo } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { SharedReviewsAnswersAtom } from "../reviews/reviews-state-atoms";
import { PendingHandoffs } from "./boss-handoffs";
import { BossBubbleModel, BossDom } from "./boss-store";

const { settings, workspaces } = (GlobalMock as any).TestAtoms;
const agents = AgentStates.getInstance();
const handoffs = PendingHandoffs.getInstance();
const model = BossBubbleModel.getInstance();

function fakeDom() {
    const listeners = new Map<string, Set<(e: any) => void>>();
    const dom = {
        addEventListener: (type: string, fn: (e: any) => void, _options?: unknown) => {
            listeners.set(type, (listeners.get(type) ?? new Set()).add(fn));
        },
        removeEventListener: (type: string, fn: (e: any) => void) => listeners.get(type)?.delete(fn),
        dispatch: (type: string, event: any = {}) => listeners.get(type)?.forEach((fn) => fn(event)),
        listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0),
        activeElement: null as unknown,
        hasFocus: () => true,
    };
    return dom satisfies BossDom & Record<string, unknown>;
}

function agentInfo(blockid: string, state: AgentStateInfo["state"]): AgentStateInfo {
    return { blockid, workspaceid: "w1", agent: "claude", state, version: 1 };
}

function setStates(...infos: AgentStateInfo[]) {
    globalStore.set(agents.dataAtom, {
        states: Object.fromEntries(infos.map((i) => [i.blockid, i])),
        versions: {},
    });
}

function pendingRequest(requestid: string): PendingHandoff {
    return { requestid, fromblockid: "bs", toblockid: "br", from: "Chloé", to: "Léa", goal: "A goal", createdat: 1 };
}

// wavesrv says the list of requests changed.
function publishPending() {
    m.handlers.get("molten:agenthandoffpending")?.forEach((handler) => handler({}));
}

beforeEach(() => {
    m.setMeta.mockReset();
    m.setMeta.mockResolvedValue(undefined);
    m.readPending.mockReset();
    m.readPending.mockResolvedValue([]);
    m.handlers.clear();
    globalStore.set(handoffs.dataAtom, []);
    globalStore.set(handoffs.loadedAtom, false);
    globalStore.set(settings, {});
    globalStore.set(workspaces, {});
    globalStore.set(model.cueAtom, 0);
    globalStore.set(model.cardOpenAtom, false);
    globalStore.set(model.tabRequestAtom, null);
    globalStore.set(agents.loadedAtom, false);
    setStates();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("the one cue when the badge rises (AC6; FR-BOSS-007, AC3)", () => {
    // The first readings are in: the agents (set by the test) and the hand-off requests (read when the host attaches).
    async function attachedAndRead() {
        globalStore.set(agents.loadedAtom, true);
        const detach = model.attach(fakeDom());
        await vi.waitFor(() => expect(globalStore.get(handoffs.loadedAtom)).toBe(true), { timeout: 30000 });
        return detach;
    }

    it("plays when an agent starts waiting, not for the states a starting window loads", async () => {
        setStates(agentInfo("a", "waiting"));
        const detach = await attachedAndRead();
        expect(globalStore.get(model.cueAtom)).toBe(0);
        setStates(agentInfo("a", "waiting"), agentInfo("b", "error"));
        expect(globalStore.get(model.cueAtom)).toBe(1);
        setStates(agentInfo("a", "waiting"), agentInfo("b", "error"), agentInfo("c", "waiting"));
        expect(globalStore.get(model.cueAtom)).toBe(2);
        detach();
    });

    it("waits for every first reading before it judges: a window starting is not news", async () => {
        const detach = model.attach(fakeDom());
        setStates(agentInfo("a", "waiting"));
        expect(globalStore.get(model.cueAtom)).toBe(0);
        globalStore.set(agents.loadedAtom, true);
        await vi.waitFor(() => expect(globalStore.get(handoffs.loadedAtom)).toBe(true), { timeout: 30000 });
        expect(globalStore.get(model.cueAtom)).toBe(0);
        setStates(agentInfo("a", "waiting"), agentInfo("b", "waiting"));
        expect(globalStore.get(model.cueAtom)).toBe(1);
        detach();
    });

    it("stays still when the count holds or falls", async () => {
        setStates(agentInfo("a", "waiting"), agentInfo("b", "waiting"));
        const detach = await attachedAndRead();
        setStates(agentInfo("a", "waiting"));
        setStates();
        expect(globalStore.get(model.cueAtom)).toBe(0);
        detach();
    });

    it("stays still when a row comes back from Later: it was already known", async () => {
        setStates(agentInfo("a", "waiting"), agentInfo("b", "waiting"));
        const detach = await attachedAndRead();
        model.park("agent:b");
        expect(globalStore.get(model.badgeAtom).count).toBe(1);
        globalStore.set(model.parkedAtom, {});
        expect(globalStore.get(model.badgeAtom).count).toBe(2);
        expect(globalStore.get(model.cueAtom)).toBe(0);
        detach();
    });

    it("plays for a failing CI or a ready pull request, not for the project the Integration panel reads first", async () => {
        const failing = {
            number: 7,
            title: "PR 7",
            url: "https://example.test/pull/7",
            branch: "feature/7-x",
            base: "develop",
            createdat: "2026-11-01T10:00:00Z",
            updatedat: "2026-11-01T10:00:00Z",
            draft: false,
            merge: "clean",
            ci: { state: "failure", success: 0, failure: 1, pending: 0, checks: [] },
            report: { state: "present" },
            unpublished: 0,
        };
        const detach = await attachedAndRead();
        globalStore.set(SharedReviewsAnswersAtom, {
            "/work/x": { dir: "/work/x", state: "ok", ready: [failing], drafts: [] } as any,
        });
        expect(globalStore.get(model.toHandleAtom).items.map((item) => item.key)).toEqual(["ci:/work/x:7"]);
        expect(globalStore.get(model.cueAtom)).toBe(0);
        globalStore.set(SharedReviewsAnswersAtom, {
            "/work/x": { dir: "/work/x", state: "ok", ready: [failing, { ...failing, number: 8 }], drafts: [] } as any,
        });
        expect(globalStore.get(model.cueAtom)).toBe(1);
        expect(globalStore.get(model.badgeAtom)).toMatchObject({ count: 2, tone: "error" });
        detach();
        globalStore.set(SharedReviewsAnswersAtom, {});
    });

    it("plays when a hand-off request arrives, not for the ones a starting window loads, and the badge counts it", async () => {
        m.readPending.mockResolvedValue([pendingRequest("r1")]);
        globalStore.set(agents.loadedAtom, true);
        const detach = model.attach(fakeDom());
        await vi.waitFor(() => expect(globalStore.get(handoffs.loadedAtom)).toBe(true), { timeout: 30000 });
        expect(globalStore.get(model.cueAtom)).toBe(0);
        expect(globalStore.get(model.badgeAtom)).toMatchObject({ count: 1, text: "1", tone: "waiting" });

        m.readPending.mockResolvedValue([pendingRequest("r1"), pendingRequest("r2")]);
        publishPending();
        await vi.waitFor(() => expect(globalStore.get(handoffs.dataAtom)).toHaveLength(2), { timeout: 30000 });
        expect(globalStore.get(model.cueAtom)).toBe(1);
        expect(globalStore.get(model.badgeAtom).count).toBe(2);

        m.readPending.mockResolvedValue([pendingRequest("r2")]);
        publishPending();
        await vi.waitFor(() => expect(globalStore.get(handoffs.dataAtom)).toHaveLength(1), { timeout: 30000 });
        expect(globalStore.get(model.cueAtom)).toBe(1);
        expect(globalStore.get(model.badgeAtom).count).toBe(1);
        detach();
    });

    it("plays for a hand-off request even while an agent already waits", async () => {
        setStates(agentInfo("a", "waiting"));
        const detach = await attachedAndRead();
        expect(globalStore.get(model.cueAtom)).toBe(0);

        m.readPending.mockResolvedValue([pendingRequest("r1")]);
        publishPending();
        await vi.waitFor(() => expect(globalStore.get(handoffs.dataAtom)).toHaveLength(1), { timeout: 30000 });
        expect(globalStore.get(model.cueAtom)).toBe(1);
        expect(globalStore.get(model.badgeAtom).count).toBe(2);
        detach();
    });

    it("listens for the requests only while the host is on screen", async () => {
        const detach = model.attach(fakeDom());
        expect(m.handlers.get("molten:agenthandoffpending")).toHaveLength(1);
        await vi.waitFor(() => expect(globalStore.get(handoffs.loadedAtom)).toBe(true), { timeout: 30000 });
        detach();
        expect(m.handlers.get("molten:agenthandoffpending")).toHaveLength(0);
        expect(globalStore.get(handoffs.loadedAtom)).toBe(false);
    });

    it("counts the agents that wait or failed and no other", () => {
        setStates(
            agentInfo("a", "waiting"),
            agentInfo("b", "error"),
            agentInfo("c", "working"),
            agentInfo("d", "done")
        );
        const badge = globalStore.get(model.badgeAtom);
        expect(badge).toMatchObject({ count: 2, text: "2", tone: "error" });
    });
});

describe("the peek (AC7)", () => {
    it("names the workspace of each agent from the workspace objects, as they load", () => {
        setStates({ ...agentInfo("a", "waiting"), workspaceid: "w2", firstname: "Léa" });
        expect(globalStore.get(model.peekAtom).waiting[0]).toMatchObject({ name: "Léa", workspace: "" });
        globalStore.set(workspaces, { "workspace:w2": { name: "Beta" } });
        expect(globalStore.get(model.peekAtom).waiting[0]).toMatchObject({ name: "Léa", workspace: "Beta" });
    });

    it("changes with the agents, with no other call", () => {
        setStates();
        expect(globalStore.get(model.peekAtom).waiting).toEqual([]);
        setStates(agentInfo("a", "error"));
        expect(globalStore.get(model.peekAtom).waiting).toHaveLength(1);
        expect(m.setMeta).not.toHaveBeenCalled();
    });

    it("lists as many rows as the badge counts, hand-off requests included (#1959)", async () => {
        m.readPending.mockResolvedValue([pendingRequest("r1"), pendingRequest("r2")]);
        setStates(agentInfo("a", "waiting"), agentInfo("b", "error"));
        const detach = model.attach(fakeDom());
        await vi.waitFor(() => expect(globalStore.get(handoffs.dataAtom)).toHaveLength(2), { timeout: 30000 });
        const badge = globalStore.get(model.badgeAtom);
        const peek = globalStore.get(model.peekAtom);
        expect(badge.count).toBe(4);
        expect(peek.waiting.length + peek.waitingMore).toBe(badge.count);
        // The failure comes first, as it does in the card and in the caption; three rows are listed, then "and 1 more".
        expect(peek.waiting.map((row) => row.id)).toEqual(["agent:b", "handoff:r1", "handoff:r2"]);
        expect(peek.waiting[0]).toMatchObject({ tone: "error" });
        expect(peek.waitingMore).toBe(1);
        detach();
    });

    it("lists a hand-off request when it is the only thing that waits", async () => {
        m.readPending.mockResolvedValue([pendingRequest("r1")]);
        const detach = model.attach(fakeDom());
        await vi.waitFor(() => expect(globalStore.get(handoffs.dataAtom)).toHaveLength(1), { timeout: 30000 });
        expect(globalStore.get(model.peekAtom).waiting).toEqual([
            expect.objectContaining({ id: "handoff:r1", name: "Chloé", tone: "waiting", line: "A goal" }),
        ]);
        detach();
    });
});

describe("the Sessions card (FR-BOSS-002, AC1, AC5)", () => {
    // An element that can hold the focus, as the page's are for the model.
    function focusable() {
        return { focus: vi.fn(), isConnected: true, closest: () => null };
    }

    function attached(active: unknown = null) {
        const dom = fakeDom() as ReturnType<typeof fakeDom> & { body: object };
        dom.body = { body: true };
        dom.activeElement = active;
        const detach = model.attach(dom);
        return { dom, detach };
    }

    it("shows only when asked, and says so in its atom", () => {
        const { detach } = attached();
        expect(globalStore.get(model.cardOpenAtom)).toBe(false);
        model.openCard();
        expect(globalStore.get(model.cardOpenAtom)).toBe(true);
        detach();
    });

    it("does not show for an avatar that Settings hides: there is nothing to anchor it to", () => {
        const { detach } = attached();
        globalStore.set(settings, { "boss:show": false });
        model.openCard();
        expect(globalStore.get(model.cardOpenAtom)).toBe(false);
        detach();
    });

    it("opens on a section for the developer's gesture even with Brokk turned off, so the notifications and downloads stay reachable (#2003)", () => {
        const { detach } = attached();
        globalStore.set(settings, { "boss:show": false });
        model.showPanel("downloads");
        expect(globalStore.get(model.cardOpenAtom)).toBe(true);
        expect(globalStore.get(model.tabRequestAtom)).toMatchObject({ tab: "downloads", highlight: [] });
        detach();
    });

    it("goes to the asked tab when the panel is open already, and tells two requests for one tab apart", () => {
        const { detach } = attached();
        model.openCard();
        expect(globalStore.get(model.tabRequestAtom)).toBeNull();
        model.showPanel("notifications", ["n1"]);
        const first = globalStore.get(model.tabRequestAtom);
        expect(first).toMatchObject({ tab: "notifications", highlight: ["n1"] });
        model.showPanel("notifications");
        expect(globalStore.get(model.tabRequestAtom).seq).toBeGreaterThan(first.seq);
        detach();
    });

    it("never opens the panel for a source that has no gesture: a notification asking for attention only shows in an open one", () => {
        const { detach } = attached();
        model.showInOpenPanel("notifications", ["n1"]);
        expect(globalStore.get(model.cardOpenAtom)).toBe(false);
        expect(globalStore.get(model.tabRequestAtom)).toBeNull();
        model.openCard();
        model.showInOpenPanel("notifications", ["n1"]);
        expect(globalStore.get(model.tabRequestAtom)).toMatchObject({ tab: "notifications", highlight: ["n1"] });
        detach();
    });

    it("forgets the asked tab when the panel hides, so that a plain opening reads the badge", () => {
        const { detach } = attached();
        model.showPanel("usage");
        model.closeCard();
        expect(globalStore.get(model.tabRequestAtom)).toBeNull();
        model.openCard();
        expect(globalStore.get(model.tabRequestAtom)).toBeNull();
        detach();
    });

    it("toggles: a second call hides it again", () => {
        const { detach } = attached();
        model.toggleCard();
        expect(globalStore.get(model.cardOpenAtom)).toBe(true);
        model.toggleCard();
        expect(globalStore.get(model.cardOpenAtom)).toBe(false);
        detach();
    });

    it("gives the focus back to where it was, once the card is gone", () => {
        vi.useFakeTimers();
        const terminal = focusable();
        const { dom, detach } = attached(terminal);
        model.openCard();
        dom.activeElement = dom.body;
        model.closeCard();
        expect(globalStore.get(model.cardOpenAtom)).toBe(false);
        expect(terminal.focus).not.toHaveBeenCalled();
        vi.runAllTimers();
        expect(terminal.focus).toHaveBeenCalledTimes(1);
        detach();
    });

    it("gives it back even when the card, which held it, has not left the page yet", () => {
        vi.useFakeTimers();
        const terminal = focusable();
        const { dom, detach } = attached(terminal);
        model.openCard();
        dom.activeElement = { closest: (selector: string) => (selector === "[data-boss-card]" ? {} : null) };
        model.closeCard();
        vi.runAllTimers();
        expect(terminal.focus).toHaveBeenCalledTimes(1);
        detach();
    });

    it("leaves the focus where the developer put it meanwhile (a click outside)", () => {
        vi.useFakeTimers();
        const terminal = focusable();
        const { dom, detach } = attached(terminal);
        model.openCard();
        model.closeCard();
        dom.activeElement = focusable();
        vi.runAllTimers();
        expect(terminal.focus).not.toHaveBeenCalled();
        detach();
    });

    it("gives no focus back when the developer went somewhere (Go to, the full view, a new terminal)", () => {
        vi.useFakeTimers();
        const terminal = focusable();
        const { dom, detach } = attached(terminal);
        model.openCard();
        dom.activeElement = dom.body;
        model.closeCard({ restoreFocus: false });
        vi.runAllTimers();
        expect(terminal.focus).not.toHaveBeenCalled();
        detach();
    });

    it("gives the focus back to the target the caller named (the palette's origin pane)", () => {
        vi.useFakeTimers();
        const origin = focusable();
        const { dom, detach } = attached(focusable());
        model.openCard(origin);
        dom.activeElement = dom.body;
        model.closeCard();
        vi.runAllTimers();
        expect(origin.focus).toHaveBeenCalledTimes(1);
        detach();
    });

    it("asks nothing of a page that held no focus", () => {
        vi.useFakeTimers();
        const { dom, detach } = attached(null);
        model.openCard();
        dom.activeElement = dom.body;
        model.closeCard();
        expect(() => vi.runAllTimers()).not.toThrow();
        detach();
    });

    it("hides with the host when the window stops drawing it", () => {
        const { detach } = attached();
        model.openCard();
        detach();
        expect(globalStore.get(model.cardOpenAtom)).toBe(false);
    });

    it("sends nothing to wavesrv and writes nothing to the window: the app stays as it was", () => {
        const { detach } = attached();
        model.openCard();
        model.closeCard();
        expect(m.setMeta).not.toHaveBeenCalled();
        detach();
    });
});

describe("the rows settled or ignored (FR-BOSS-009, AC16, #2026)", () => {
    const store = new Map<string, string>();
    const fakeStorage = {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
    };
    const waiting = { key: "agent:a", since: 7, tone: "waiting" };

    beforeEach(() => {
        store.clear();
        vi.stubGlobal("localStorage", fakeStorage);
        globalStore.set(model.handledAtom, {});
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("takes a settled row out of the list and the badge, and shares the mark with the other views", () => {
        setStates(agentInfo("a", "waiting"), agentInfo("b", "waiting"));
        globalStore.set(agents.dataAtom, {
            states: { a: { ...agentInfo("a", "waiting"), since: 7 }, b: { ...agentInfo("b", "waiting"), since: 9 } },
            versions: {},
        });
        expect(globalStore.get(model.badgeAtom).count).toBe(2);
        model.settleRow(waiting);
        expect(globalStore.get(model.toHandleAtom).items.map((item) => item.key)).toEqual(["agent:b"]);
        expect(globalStore.get(model.badgeAtom).count).toBe(1);
        expect(JSON.parse(store.get("moltenterm:brokk-handled"))["agent:a"].episode).toBe("7:waiting");
    });

    it("brings the row back when the agent waits again", () => {
        globalStore.set(agents.dataAtom, { states: { a: { ...agentInfo("a", "waiting"), since: 7 } }, versions: {} });
        model.settleRow(waiting);
        expect(globalStore.get(model.badgeAtom).count).toBe(0);
        globalStore.set(agents.dataAtom, { states: { a: { ...agentInfo("a", "waiting"), since: 20 } }, versions: {} });
        expect(globalStore.get(model.badgeAtom).count).toBe(1);
    });

    it("takes the marks another window wrote, and keeps them when it writes its own", () => {
        globalStore.set(agents.dataAtom, {
            states: { a: { ...agentInfo("a", "waiting"), since: 7 }, b: { ...agentInfo("b", "error"), since: 9 } },
            versions: {},
        });
        const elsewhere = { "agent:b": { episode: "9:error", at: Date.now() } };
        store.set("moltenterm:brokk-handled", JSON.stringify(elsewhere));
        model.handledChanged(JSON.stringify(elsewhere));
        expect(globalStore.get(model.toHandleAtom).items.map((item) => item.key)).toEqual(["agent:a"]);

        const written = { ...elsewhere, "ci:/p:1": { episode: "1:error", at: Date.now() } };
        store.set("moltenterm:brokk-handled", JSON.stringify(written));
        model.settleRow(waiting);
        expect(Object.keys(JSON.parse(store.get("moltenterm:brokk-handled"))).sort()).toEqual([
            "agent:a",
            "agent:b",
            "ci:/p:1",
        ]);
    });

    it("reads the marks when the host attaches, and listens to the other views while it is on screen", () => {
        store.set("moltenterm:brokk-handled", JSON.stringify({ "agent:a": { episode: "7:waiting", at: Date.now() } }));
        const added: string[] = [];
        const removed: string[] = [];
        vi.stubGlobal("addEventListener", (type: string) => added.push(type));
        vi.stubGlobal("removeEventListener", (type: string) => removed.push(type));
        const detach = model.attach(fakeDom());
        expect(Object.keys(globalStore.get(model.handledAtom))).toEqual(["agent:a"]);
        expect(added).toContain("storage");
        detach();
        expect(removed).toContain("storage");
    });
});

describe("the settings (AC8, AC9)", () => {
    it("shows the avatar unless turned off", () => {
        expect(globalStore.get(model.showAtom)).toBe(true);
        globalStore.set(settings, { "boss:show": false });
        expect(globalStore.get(model.showAtom)).toBe(false);
    });

    it("calls the foreman Brokk until he is renamed", () => {
        expect(globalStore.get(model.nameAtom)).toBe("Brokk");
        globalStore.set(settings, { "boss:name": "  Léa " });
        expect(globalStore.get(model.nameAtom)).toBe("Léa");
        globalStore.set(settings, { "boss:name": "x".repeat(40) });
        expect(globalStore.get(model.nameAtom)).toBe("x".repeat(24));
    });
});
