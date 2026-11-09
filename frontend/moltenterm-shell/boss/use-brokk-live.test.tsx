// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
        peekAtom: atom({ waiting: [], waitingMore: 0, working: [], workingMore: 0, usage: [], latest: null }),
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
import { TabActivity } from "../tab-activity";
import type { BossPeek } from "./boss-overview";
import { BossBubbleModel } from "./boss-store";
import type { ToHandleItem } from "./boss-to-handle-model";
import { BrokkExpressionsModel } from "./brokk-expressions";
import type { BrokkScene } from "./brokk-scene";
import { useGroupCaption } from "./use-brokk-caption";
import {
    faceVisibleIn,
    useBrokkScene,
    useBrokkSituation,
    useCardLive,
    useFaceVisible,
    useMotionAllowed,
} from "./use-brokk-live";

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

afterEach(() => {
    vi.useRealTimers();
});

beforeEach(() => {
    // Local noon in any time zone: at night the scene speaks of the late hour instead (#2035).
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 5, 15, 12) });
    Mocks.reduced = false;
    Mocks.noteOpen.mockReset();
    globalStore.set(bubble.workingCountAtom, 0);
    globalStore.set(bubble.badgeAtom, { count: 0, text: "", tone: "waiting" });
    globalStore.set(bubble.toHandleAtom, { items: [], info: [], parked: 0 });
    globalStore.set(expressions.askedAtom, null);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("the card's header (FR-BOSS-007, AC8, #1959; FR-BOSS-009)", () => {
    it("shows his animated portrait while the card shows: the avatar that opened it has emptied its face", () => {
        expect(hook(() => useCardLive())).toMatchObject({ rhythm: "normal" });
    });

    it("shows the still whatever happens when motion is reduced", () => {
        Mocks.reduced = true;
        expect(hook(() => useCardLive())).toBeNull();
    });
});

describe("where his face can be seen (#2154)", () => {
    afterEach(() => {
        TabActivity.resetInstance();
    });

    it("is where the page is visible and the tab view is on screen, whether or not the window has the focus", () => {
        expect(faceVisibleIn(true, "active")).toBe(true);
        expect(faceVisibleIn(true, "visible")).toBe(true);
        expect(faceVisibleIn(true, "hidden")).toBe(false);
        expect(faceVisibleIn(true, "minimized")).toBe(false);
        expect(faceVisibleIn(false, "active")).toBe(false);
    });

    it("keeps him animated in a view that shows in a window without the focus", () => {
        const activity = TabActivity.getInstance();
        globalStore.set(activity.documentFocusedAtom, false);
        expect(globalStore.get(activity.stateAtom)).toBe("visible");
        expect(hook(() => useCardLive())).toMatchObject({ rhythm: "normal" });
        expect(hook(() => useMotionAllowed())).toBe(true);
    });

    it("mounts nothing in a tab view that is not on screen, nor in a minimised window", () => {
        const activity = TabActivity.getInstance();
        globalStore.set(activity.documentVisibleAtom, false);
        expect(globalStore.get(activity.stateAtom)).toBe("hidden");
        expect(hook(() => useCardLive())).toBeNull();
        expect(hook(() => useFaceVisible())).toBe(false);
        globalStore.set(activity.documentVisibleAtom, true);
        globalStore.set(activity.windowAtom, { focused: false, minimized: true, shown: true });
        expect(globalStore.get(activity.stateAtom)).toBe("minimized");
        expect(hook(() => useCardLive())).toBeNull();
        expect(hook(() => useMotionAllowed())).toBe(false);
    });

    it("plays again once the view is on screen again", () => {
        const activity = TabActivity.getInstance();
        globalStore.set(activity.documentVisibleAtom, false);
        expect(hook(() => useCardLive())).toBeNull();
        globalStore.set(activity.documentVisibleAtom, true);
        expect(hook(() => useCardLive())).not.toBeNull();
    });
});

describe("the scene the tooltip reads (FR-BOSS-007, AC10 and AC11, #1959)", () => {
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

    // At night he is tired and says so instead of the plan reading: the clock is fixed to the afternoon so the test does
    // not depend on the hour it runs at.
    it("names the one agent at work, and shows the plan reading from the warning level, with no gesture", () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(2026, 10, 7, 14, 0, 0));
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

// His square in the floating group is his living portrait, driven by the models of the #2003 panel and of the visit, not by
// a plain video of its own (FR-BOSS-009, AC17, #2032).
describe("the group's square is driven by the same pose and mood models (FR-BOSS-007; FR-BOSS-009, AC17)", () => {
    it("plays the panel's portrait: the card's situation, the expression queue and the blink rhythm", () => {
        const asked = { expression: "frown", cue: 3, at: Date.now() };
        globalStore.set(expressions.askedAtom, asked);
        const live = hook(() => useCardLive());
        expect(live).toMatchObject({ rhythm: "normal", asked });
        expect(live.situation).toMatchObject({ cardOpen: true });
    });

    it("listens while the developer writes and thinks while his own session answers", () => {
        expect(hook(() => useCardLive("typing")).situation.talk).toBe("typing");
        expect(hook(() => useCardLive("answering")).situation.talk).toBe("answering");
        expect(hook(() => useCardLive()).situation.talk).toBeUndefined();
    });

    it("lets what waits show in his pose, as in the panel: the situation counts the badge", () => {
        globalStore.set(bubble.badgeAtom, { count: 2, text: "2", tone: "error" });
        globalStore.set(bubble.workingCountAtom, 1);
        expect(hook(() => useCardLive()).situation).toMatchObject({ waiting: 2, working: 1, cardOpen: true });
    });

    it("shows the still under reduced motion, whatever happens", () => {
        Mocks.reduced = true;
        globalStore.set(expressions.askedAtom, { expression: "smile", cue: 1, at: Date.now() });
        expect(hook(() => useCardLive("typing"))).toBeNull();
    });

    it("says under the square the caption of the same scene, so that the words match the face", () => {
        globalStore.set(bubble.badgeAtom, { count: 1, text: "1", tone: "waiting" });
        globalStore.set(bubble.toHandleAtom, { items: [row("agent:a")], info: [], parked: 0 });
        // On opening he says the row, and his pose is speaking: the words and the face come from the same scene.
        const caption = hook(() => useGroupCaption());
        expect(caption).toBe("A thing for you: Olivia waits for you");
        const scene = hook(() => {
            const situation = useBrokkSituation(true, false);
            return useBrokkScene({ pinned: false, peek: NoPeek, situation, speaks: true });
        });
        expect(scene.face).toBe("speaking");
        expect(scene.caption.status).toMatchObject({
            key: "boss.screen.speech",
            vars: { line: "Olivia waits for you" },
        });
    });

    it("says the calm words when nothing goes on, and what works when something does", () => {
        expect(hook(() => useGroupCaption())).toMatch(/\S/);
        globalStore.set(bubble.workingCountAtom, 2);
        expect(hook(() => useGroupCaption())).toContain("2");
    });

    // #2033: the status and its detail ("2 agents at work", "Nothing for you") were joined by a space alone.
    it("reads the two lines of his caption as two sentences, not as one run of words", () => {
        globalStore.set(bubble.workingCountAtom, 2);
        const caption = hook(() => useGroupCaption());
        expect(caption).toBe("2 agents at work. Nothing for you.");
        expect(caption).not.toMatch(/work Nothing/);
    });

    it("is wired to the portrait through the same hooks the panel used, with no video or package of its own", () => {
        const group = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(group).toContain("useCardLive(pose)");
        expect(group).toContain("useGroupCaption(pose)");
        expect(group).toContain('<BossPortrait live={live} framing="banner" />');
        expect(group).not.toContain("TransmissionPortrait");
        expect(group).not.toContain("<video");
        const caption = readFileSync(join(__dirname, "use-brokk-caption.ts"), "utf8");
        expect(caption).toContain("useBrokkScene(");
        expect(caption).toContain("useBrokkSituation(");
    });

    it("keeps the expressions model watching, and lets his nod answer what the developer handles in the panels", () => {
        const host = readFileSync(join(__dirname, "brokk-hub-host.tsx"), "utf8");
        expect(host).toContain("BrokkExpressionsModel.getInstance().watch(document)");
        const actions = readFileSync(join(__dirname, "use-brokk-actions.ts"), "utf8");
        expect(actions).toContain("BrokkExpressionsModel.getInstance().noteHandled(handled)");
    });
});
