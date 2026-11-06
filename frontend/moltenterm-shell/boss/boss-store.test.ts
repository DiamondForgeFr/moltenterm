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
import { BossBubbleMetaKey } from "./boss-name";
import { DefaultBubbleState, DefaultPlace, Rect } from "./boss-place";
import { BossBubbleModel, BossDom, terminalBlockOf } from "./boss-store";

const { settings, windowObject, workspaces } = (GlobalMock as any).TestAtoms;
const agents = AgentStates.getInstance();
const handoffs = PendingHandoffs.getInstance();
const model = BossBubbleModel.getInstance();

const BubbleRect: Rect = { left: 900, top: 600, width: 44, height: 44 };
const UnderRect: Rect = { left: 500, top: 300, width: 500, height: 400 };
const AwayRect: Rect = { left: 0, top: 0, width: 400, height: 300 };

function block(blockId: string, rect: Rect) {
    return {
        getAttribute: (name: string) => (name === "data-blockid" ? blockId : null),
        getBoundingClientRect: () => rect,
    };
}

function terminalInput(blockId: string, rect: Rect) {
    const frame = block(blockId, rect);
    return { classList: { contains: (c: string) => c === "xterm-helper-textarea" }, closest: () => frame, frame };
}

function focusedIn(blockId: string) {
    const frame = block(blockId, UnderRect);
    return { closest: () => frame };
}

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

// The window's meta echoed the change and the bubble stopped waiting for it; the deadline only bounds a failing run.
const settled = () => vi.waitFor(() => expect(globalStore.get(model.pendingAtom)).toBeNull(), { timeout: 30000 });

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
    globalStore.set(windowObject, { meta: {} });
    globalStore.set(workspaces, {});
    globalStore.set(model.pendingAtom, null);
    globalStore.set(model.typingBlockAtom, null);
    globalStore.set(model.cueAtom, 0);
    globalStore.set(model.peekOpenAtom, false);
    globalStore.set(model.cardOpenAtom, false);
    globalStore.set(agents.loadedAtom, false);
    setStates();
    model.setRectSource(() => BubbleRect);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("the terminal a keystroke reaches (FR-BOSS-001, AC4)", () => {
    it("is the block frame of the terminal's input", () => {
        const input = terminalInput("blk-1", UnderRect);
        expect(terminalBlockOf(input)).toEqual({ blockId: "blk-1", rect: UnderRect });
    });

    it("is none for any other target", () => {
        expect(terminalBlockOf(null)).toBeNull();
        expect(terminalBlockOf({ classList: { contains: () => false } })).toBeNull();
        expect(terminalBlockOf({ classList: { contains: () => true }, closest: () => null })).toBeNull();
        expect(
            terminalBlockOf({ classList: { contains: () => true }, closest: () => block("", UnderRect) })
        ).toBeNull();
    });
});

describe("the collapse while typing (AC4)", () => {
    it("folds the bubble into the pennant at the first keystroke into a terminal under it", () => {
        model.noteKeyDown({ target: terminalInput("blk-1", UnderRect), key: "a" });
        expect(globalStore.get(model.typingBlockAtom)).toBe("blk-1");
        expect(globalStore.get(model.collapsedAtom)).toBe(true);
        expect(m.setMeta).not.toHaveBeenCalled();
    });

    it("leaves the bubble when the terminal lies elsewhere", () => {
        model.noteKeyDown({ target: terminalInput("blk-1", AwayRect), key: "a" });
        expect(globalStore.get(model.collapsedAtom)).toBe(false);
    });

    it("leaves the bubble for a key that reaches no terminal, a modifier, or a shortcut", () => {
        model.noteKeyDown({ target: { classList: { contains: () => false } }, key: "a" });
        model.noteKeyDown({ target: terminalInput("blk-1", UnderRect), key: "Shift" });
        model.noteKeyDown({ target: terminalInput("blk-1", UnderRect), key: "k", metaKey: true });
        expect(globalStore.get(model.collapsedAtom)).toBe(false);
    });

    it("never collapses by itself when Settings turned it off", () => {
        globalStore.set(settings, { "boss:collapseontype": false });
        model.noteKeyDown({ target: terminalInput("blk-1", UnderRect), key: "a" });
        expect(globalStore.get(model.collapsedAtom)).toBe(false);
    });

    it("changes nothing over a manual collapse", () => {
        globalStore.set(windowObject, {
            meta: { [BossBubbleMetaKey]: { corner: "br", dx: 16, dy: 16, collapsed: true } },
        });
        model.noteKeyDown({ target: terminalInput("blk-1", UnderRect), key: "a" });
        expect(globalStore.get(model.typingBlockAtom)).toBeNull();
        expect(globalStore.get(model.collapsedAtom)).toBe(true);
    });

    it("measures nothing and stops nothing: the keystroke goes where it was going", () => {
        const stop = vi.fn();
        const event = {
            target: terminalInput("blk-1", UnderRect),
            key: "a",
            preventDefault: stop,
            stopPropagation: stop,
        };
        model.noteKeyDown(event);
        expect(stop).not.toHaveBeenCalled();
    });

    it("closes the peek it folds", () => {
        globalStore.set(model.peekOpenAtom, true);
        model.noteKeyDown({ target: terminalInput("blk-1", UnderRect), key: "a" });
        expect(globalStore.get(model.peekOpenAtom)).toBe(false);
    });

    it("comes back when the focus leaves that terminal, not before", () => {
        const dom = fakeDom();
        model.noteKeyDown({ target: terminalInput("blk-1", UnderRect), key: "a" });
        dom.activeElement = focusedIn("blk-1");
        model.noteFocusLeft(dom);
        expect(globalStore.get(model.typingBlockAtom)).toBe("blk-1");
        dom.activeElement = focusedIn("blk-2");
        model.noteFocusLeft(dom);
        expect(globalStore.get(model.typingBlockAtom)).toBeNull();
        expect(globalStore.get(model.collapsedAtom)).toBe(false);
    });

    it("stays folded while the window itself lost the system's focus", () => {
        const dom = fakeDom();
        dom.hasFocus = () => false;
        dom.activeElement = null;
        model.noteKeyDown({ target: terminalInput("blk-1", UnderRect), key: "a" });
        model.noteFocusLeft(dom);
        expect(globalStore.get(model.typingBlockAtom)).toBe("blk-1");
    });

    it("comes back when the terminal is gone and the focus fell to the page", () => {
        const dom = fakeDom();
        model.noteKeyDown({ target: terminalInput("blk-1", UnderRect), key: "a" });
        dom.activeElement = { closest: () => null };
        model.noteFocusLeft(dom);
        expect(globalStore.get(model.typingBlockAtom)).toBeNull();
    });

    it("listens in the capture phase without stopping anything, and stops listening when detached", () => {
        vi.useFakeTimers();
        const dom = fakeDom();
        const addSpy = vi.spyOn(dom, "addEventListener");
        const detach = model.attach(dom);
        expect(addSpy.mock.calls.map((c) => c[0]).sort()).toEqual(["focusin", "focusout", "keydown"]);
        for (const call of addSpy.mock.calls) {
            expect(call[2]).toMatchObject({ capture: true, passive: true });
        }

        dom.dispatch("keydown", { target: terminalInput("blk-1", UnderRect), key: "x" });
        expect(globalStore.get(model.collapsedAtom)).toBe(true);
        dom.activeElement = focusedIn("blk-2");
        dom.dispatch("focusout", {});
        expect(globalStore.get(model.collapsedAtom)).toBe(true);
        vi.advanceTimersByTime(0);
        expect(globalStore.get(model.collapsedAtom)).toBe(false);

        detach();
        expect(dom.listenerCount()).toBe(0);
        expect(globalStore.get(model.peekOpenAtom)).toBe(false);
    });
});

describe("the one cue when the badge rises (AC6; FR-BOSS-007, AC3)", () => {
    // The first readings are in: the agents (set by the test) and the hand-off requests (read when the bubble attaches).
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

    it("listens for the requests only while a bubble is on screen", async () => {
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

describe("the bubble in the window's meta (AC2, AC3)", () => {
    function echoMeta() {
        m.setMeta.mockImplementation(async (_client, data: { meta: Record<string, unknown> }) => {
            const held = globalStore.get(windowObject) as { meta: Record<string, unknown> };
            globalStore.set(windowObject, { meta: { ...held.meta, ...data.meta } });
        });
    }

    it("starts at the bottom right, expanded", () => {
        expect(globalStore.get(model.stateAtom)).toEqual(DefaultBubbleState);
    });

    it("keeps a manual collapse, and shows it at once", async () => {
        echoMeta();
        model.collapse();
        expect(globalStore.get(model.collapsedAtom)).toBe(true);
        await settled();
        expect(m.setMeta).toHaveBeenCalledOnce();
        expect(m.setMeta.mock.calls[0][1]).toEqual({
            oref: "window:w1",
            meta: { [BossBubbleMetaKey]: { corner: "br", dx: 16, dy: 16, collapsed: true } },
        });
        expect(globalStore.get(model.collapsedAtom)).toBe(true);
    });

    it("brings the bubble back from the pennant, whoever folded it", async () => {
        echoMeta();
        model.collapse();
        await settled();
        globalStore.set(model.typingBlockAtom, "blk-1");
        model.expand();
        expect(globalStore.get(model.typingBlockAtom)).toBeNull();
        expect(globalStore.get(model.collapsedAtom)).toBe(false);
        await settled();
        expect(globalStore.get(model.collapsedAtom)).toBe(false);
    });

    it("keeps the place it was dropped at, as an offset from the nearest corner", async () => {
        echoMeta();
        model.drop({ left: 30, top: 40, width: 44, height: 44 }, { width: 1000, height: 700 });
        await settled();
        expect(globalStore.get(model.stateAtom).place).toEqual({ corner: "tl", dx: 30, dy: 40 });
    });

    it("resets its position and keeps its collapse", async () => {
        echoMeta();
        model.drop({ left: 30, top: 40, width: 44, height: 44 }, { width: 1000, height: 700 });
        await settled();
        model.collapse();
        await settled();
        model.resetPosition();
        await settled();
        expect(globalStore.get(model.stateAtom)).toEqual({ place: DefaultPlace, collapsed: true });
    });

    it("writes nothing for a change that changes nothing", () => {
        model.resetPosition();
        model.expand();
        expect(m.setMeta).not.toHaveBeenCalled();
    });

    it("shows the last of two quick changes", async () => {
        echoMeta();
        model.collapse();
        model.expand();
        await settled();
        expect(globalStore.get(model.collapsedAtom)).toBe(false);
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

    it("takes the peek's place: the peek goes when the card shows", () => {
        const { detach } = attached();
        globalStore.set(model.peekOpenAtom, true);
        model.openCard();
        expect(globalStore.get(model.peekOpenAtom)).toBe(false);
        detach();
    });

    it("does not show for a bubble that Settings hides: there is nothing to anchor it to", () => {
        const { detach } = attached();
        globalStore.set(settings, { "boss:show": false });
        model.openCard();
        expect(globalStore.get(model.cardOpenAtom)).toBe(false);
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

    it("keeps the bubble folded under it: typing elsewhere does not fold it, the focus leaving does not bring it back", () => {
        const { dom, detach } = attached();
        model.noteKeyDown({ target: terminalInput("blk-1", UnderRect), key: "a" });
        expect(globalStore.get(model.collapsedAtom)).toBe(true);
        model.openCard();
        dom.activeElement = focusedIn("blk-2");
        model.noteFocusLeft(dom);
        expect(globalStore.get(model.typingBlockAtom)).toBe("blk-1");
        model.closeCard({ restoreFocus: false });
        model.noteFocusLeft(dom);
        expect(globalStore.get(model.typingBlockAtom)).toBeNull();
        detach();
    });

    it("does not fold the bubble for a keystroke while the card shows", () => {
        const { detach } = attached();
        model.openCard();
        model.noteKeyDown({ target: terminalInput("blk-1", UnderRect), key: "a" });
        expect(globalStore.get(model.typingBlockAtom)).toBeNull();
        detach();
    });

    it("hides with the bubble when the window stops drawing it", () => {
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

describe("the settings (AC8, AC9)", () => {
    it("shows the bubble and collapses on typing unless turned off", () => {
        expect(globalStore.get(model.showAtom)).toBe(true);
        expect(globalStore.get(model.collapseOnTypeAtom)).toBe(true);
        globalStore.set(settings, { "boss:show": false, "boss:collapseontype": false });
        expect(globalStore.get(model.showAtom)).toBe(false);
        expect(globalStore.get(model.collapseOnTypeAtom)).toBe(false);
    });

    it("listens to no keystroke for a bubble that Settings hides", () => {
        globalStore.set(settings, { "boss:show": false });
        model.noteKeyDown({ target: terminalInput("blk-1", UnderRect), key: "a" });
        expect(globalStore.get(model.typingBlockAtom)).toBeNull();
    });

    it("calls the foreman Brokk until he is renamed", () => {
        expect(globalStore.get(model.nameAtom)).toBe("Brokk");
        globalStore.set(settings, { "boss:name": "  Léa " });
        expect(globalStore.get(model.nameAtom)).toBe("Léa");
        globalStore.set(settings, { "boss:name": "x".repeat(40) });
        expect(globalStore.get(model.nameAtom)).toBe("x".repeat(24));
    });
});
