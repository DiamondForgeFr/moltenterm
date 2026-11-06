// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));

const Mocks = vi.hoisted(() => ({
    reduced: false,
    noteOpen: vi.fn(),
    models: null as any,
}));
vi.mock("../molten-motion", () => ({ prefersReducedMotion: () => Mocks.reduced }));
vi.mock("./developer-away", () => ({ useDeveloperAway: () => false, InputEvents: [] }));
vi.mock("../agent-state-store", async () => {
    const { atom } = await import("jotai");
    const dataAtom = atom({ states: {}, versions: {} });
    return { AgentStates: { getInstance: () => ({ dataAtom }) } };
});
vi.mock("./boss-store", async () => {
    const { atom } = await import("jotai");
    const model = {
        workingCountAtom: atom(0),
        badgeAtom: atom({ count: 0, text: "", tone: "waiting" }),
        toHandleAtom: atom({ items: [], info: [], parked: 0 }),
    };
    return { BossBubbleModel: { getInstance: () => model } };
});
vi.mock("./brokk-expressions", async () => {
    const { atom } = await import("jotai");
    const { EmptyMood } = await import("./brokk-mood");
    const model = {
        askedAtom: atom(null),
        moodAtom: atom(EmptyMood),
        lastKeyAtAtom: atom(null),
        noteOpen: Mocks.noteOpen,
    };
    return { BrokkExpressionsModel: { getInstance: () => model } };
});

import { globalStore } from "@/app/store/jotaiStore";
import type { BossPeek } from "./boss-overview";
import { BossBubbleModel } from "./boss-store";
import type { ToHandleItem } from "./boss-to-handle-model";
import { BrokkExpressionsModel } from "./brokk-expressions";
import type { BrokkLiveProps } from "./brokk-live";
import type { BrokkScene } from "./brokk-scene";
import { useBrokkScene, useBrokkSituation, useBubbleLive, useCardLive } from "./use-brokk-live";

const bubble = BossBubbleModel.getInstance() as any;
const expressions = BrokkExpressionsModel.getInstance() as any;

const NoPeek: BossPeek = { waiting: [], waitingMore: 0, working: [], workingMore: 0, usage: [], latest: null };

function row(key: string, extra: Partial<ToHandleItem> = {}): ToHandleItem {
    return {
        key,
        tone: "waiting",
        notice: null,
        lineFromNotice: false,
        name: "Olivia",
        line: { key: "boss.todo.agentWaiting", vars: { name: "Olivia" } },
        place: "",
        since: 0,
        rank: 1,
        seen: false,
        actions: [],
        ...extra,
    };
}

// Runs a hook in a component and hands back what it returned.
function hook<T>(use: () => T): T {
    let value: T;
    function Probe() {
        value = use();
        return null;
    }
    renderToStaticMarkup(<Probe />);
    return value;
}

beforeEach(() => {
    Mocks.reduced = false;
    Mocks.noteOpen.mockReset();
    globalStore.set(bubble.workingCountAtom, 0);
    globalStore.set(bubble.badgeAtom, { count: 0, text: "", tone: "waiting" });
    globalStore.set(bubble.toHandleAtom, { items: [], info: [], parked: 0 });
    globalStore.set(expressions.askedAtom, null);
});

describe("the card's header while the comm screen stands beside it (FR-BOSS-007, AC8, #1959)", () => {
    it("shows his animated portrait when no screen stands beside the card, and the still when one does", () => {
        expect(hook(() => useCardLive(false))).toMatchObject({ rhythm: "normal" });
        expect(hook(() => useCardLive(true))).toBeNull();
    });

    it("shows the still whatever happens when motion is reduced", () => {
        Mocks.reduced = true;
        expect(hook(() => useCardLive(false))).toBeNull();
    });
});

describe("when the bubble asks for his animated portrait (FR-BOSS-007, AC3 and AC4)", () => {
    function live(options: { collapsed?: boolean; screenOpen?: boolean; cardOpen?: boolean }): BrokkLiveProps {
        return hook(() => {
            const situation = useBrokkSituation(options.cardOpen === true, false);
            return useBubbleLive({
                collapsed: options.collapsed === true,
                screenOpen: options.screenOpen === true,
                situation,
                speaks: false,
                rhythm: "calm",
            });
        });
    }

    it("asks for it for an open screen, with the rhythm the scene wants and the opening to tell", () => {
        const props = live({ screenOpen: true });
        expect(props).toMatchObject({ opened: true, rhythm: "calm", speaks: false });
        props.onOpened();
        expect(Mocks.noteOpen).toHaveBeenCalledTimes(1);
    });

    it("asks for nothing at rest, when folded, or with reduced motion", () => {
        expect(live({})).toBeNull();
        expect(live({ screenOpen: true, collapsed: true })).toBeNull();
        Mocks.reduced = true;
        expect(live({ screenOpen: true })).toBeNull();
    });

    it("does not play a call that was asked before the round was drawn: it was told to a round that was not showing", () => {
        globalStore.set(expressions.askedAtom, { expression: "call", cue: 1, at: Date.now() });
        expect(live({})).toBeNull();
    });
});

describe("the scene the bubble draws (FR-BOSS-007, AC10 and AC11, #1959)", () => {
    function scene(
        options: { cardOpen?: boolean; pinned?: boolean; peek?: BossPeek; speaks?: boolean } = {}
    ): BrokkScene {
        return hook(() => {
            const situation = useBrokkSituation(options.cardOpen === true, false);
            return useBrokkScene({
                pinned: options.pinned === true,
                peek: options.peek ?? NoPeek,
                situation,
                speaks: options.speaks === true,
            });
        });
    }

    it("is calm with nothing going on", () => {
        const s = scene();
        expect(s.face).toBe("listening");
        expect(s.caption.status).toEqual({ key: "boss.screen.quiet" });
    });

    it("says the one row's own sentence, in the app's language, where the badge counts it", () => {
        globalStore.set(bubble.badgeAtom, { count: 1, text: "1", tone: "waiting" });
        globalStore.set(bubble.toHandleAtom, { items: [row("agent:a")], info: [], parked: 0 });
        const s = scene();
        expect(s.caption.status).toEqual({ text: "Olivia waits for you" });
        expect(s.card.status).toEqual(s.caption.status);
        expect(s.round).toMatchObject({ count: 1, text: "1" });
    });

    it("leaves out the rows the developer has already acted on, as the badge does", () => {
        globalStore.set(bubble.badgeAtom, { count: 1, text: "1", tone: "waiting" });
        globalStore.set(bubble.toHandleAtom, {
            items: [row("notif:n", { seen: true, name: "Seen" }), row("agent:a")],
            info: [],
            parked: 0,
        });
        expect(scene().caption.status).toEqual({ text: "Olivia waits for you" });
    });

    it("names the one agent at work, and shows the plan reading from the warning level, with no gesture", () => {
        globalStore.set(bubble.workingCountAtom, 1);
        const peek: BossPeek = {
            ...NoPeek,
            working: [{ workspace: "Forge", names: ["Arthur"], more: 0 }],
            usage: [
                { agent: "Claude Code", label: "5-hour", percent: "86 % used", resets: "", level: "warning" },
                { agent: "Codex", label: "5-hour", percent: "3 % used", resets: "", level: "normal" },
            ],
        };
        const working = scene({ peek });
        expect(working.caption.status).toEqual({ key: "boss.screen.working", vars: { name: "Arthur" } });
        expect(working.loader).toBe(true);
        globalStore.set(bubble.workingCountAtom, 0);
        const calm = scene({ peek });
        expect(calm.caption.detail).toEqual({
            key: "boss.peek.usage",
            vars: { agent: "Claude Code", label: "5-hour", used: "86 % used" },
        });
        expect(calm.gesture).toBeNull();
    });

    it("looks up when the card opens, even while agents work, and says so in the header", () => {
        globalStore.set(bubble.workingCountAtom, 2);
        expect(scene().face).toBe("thinking");
        const open = scene({ cardOpen: true, pinned: true });
        expect(open.face).toBe("listening");
        expect(open.headerStill).toBe(true);
        expect(scene({ cardOpen: true, pinned: false }).headerStill).toBe(false);
    });

    it("shows the gesture the queue started while its clip lasts, and none with reduced motion", () => {
        globalStore.set(expressions.askedAtom, { expression: "smile", cue: 1, at: Date.now() });
        expect(scene().gesture).toBe("smile");
        Mocks.reduced = true;
        expect(scene().gesture).toBeNull();
    });
});
