// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/jotaiStore", async () => ({ globalStore: (await import("jotai")).createStore() }));

const Mocks = vi.hoisted(() => ({
    reducedAtom: null as any,
    noteOpen: vi.fn(),
    models: null as any,
}));
vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    Mocks.reducedAtom = atom(false);
    return { atoms: { prefersReducedMotionAtom: Mocks.reducedAtom } };
});
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
        toHandleAtom: atom({ items: [], info: [], parked: 0 }),
        peekAtom: atom({ waiting: [], waitingMore: 0, working: [], workingMore: 0, usage: [], latest: null }),
    };
    return { BossBubbleModel: { getInstance: () => model } };
});
// The face's badge (#2223): the one count the avatar shows and the pose reads.
vi.mock("./brokk-hub-store", async () => {
    const { atom } = await import("jotai");
    const model = { faceBadgeAtom: atom({ count: 0, text: "", tone: "waiting" }) };
    return { BrokkHubModel: { getInstance: () => model } };
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
import { AgentStates } from "../agent-state-store";
import { TabActivity } from "../tab-activity";
import { BossBubbleModel } from "./boss-store";
import type { ToHandleItem } from "./boss-to-handle-model";
import { BrokkExpressionsModel } from "./brokk-expressions";
import { BrokkHubModel } from "./brokk-hub-store";
import type { BrokkScene } from "./brokk-scene";
import { LongThoughtMs, TypingCalmMs } from "./brokk-scene";
import {
    faceVisibleIn,
    useBlinkRhythm,
    useBrokkScene,
    useBrokkSituation,
    useCardLive,
    useFaceVisible,
    useMotionAllowed,
    useReducedMotion,
} from "./use-brokk-live";

const bubble = BossBubbleModel.getInstance() as any;
const face = BrokkHubModel.getInstance() as any;
const expressions = BrokkExpressionsModel.getInstance() as any;

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

function setReduced(value: boolean) {
    globalStore.set(Mocks.reducedAtom, value);
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
    setReduced(false);
    Mocks.noteOpen.mockReset();
    globalStore.set(bubble.workingCountAtom, 0);
    globalStore.set(face.faceBadgeAtom, { count: 0, text: "", tone: "waiting" });
    globalStore.set(bubble.toHandleAtom, { items: [], info: [], parked: 0 });
    globalStore.set(expressions.askedAtom, null);
    globalStore.set(expressions.lastKeyAtAtom, null);
});

afterEach(() => {
    vi.useRealTimers();
});

describe("the card's header (FR-BOSS-007, AC8, #1959; FR-BOSS-009)", () => {
    it("shows his animated portrait while the card shows: the avatar that opened it has emptied its face", () => {
        expect(hook(() => useCardLive())).toMatchObject({ rhythm: "normal" });
    });

    it("keeps him animated when motion is reduced, as a calm face (#2224, AC-1)", () => {
        setReduced(true);
        expect(hook(() => useCardLive())).toMatchObject({ calm: true });
        setReduced(false);
        expect(hook(() => useCardLive())).toMatchObject({ calm: false });
    });
});

describe("the rhythm of his blinks comes from the scene (FR-BOSS-007, AC17; FR-BOSS-009, AC1, #2219)", () => {
    const agents = AgentStates.getInstance() as any;

    afterEach(() => {
        globalStore.set(agents.dataAtom, { states: {}, versions: {} });
    });

    it("is normal with nothing going on, for the group's face and for any face that asks", () => {
        expect(hook(() => useBlinkRhythm({ working: 0, waiting: 0, cardOpen: false }))).toBe("normal");
        expect(hook(() => useCardLive()).rhythm).toBe("normal");
    });

    it("turns calm while the developer types, and normal again once the typing is old", () => {
        globalStore.set(expressions.lastKeyAtAtom, Date.now() - 1000);
        expect(hook(() => useCardLive()).rhythm).toBe("calm");
        expect(hook(() => useBlinkRhythm({ working: 0, waiting: 0, cardOpen: false }))).toBe("calm");
        globalStore.set(expressions.lastKeyAtAtom, Date.now() - TypingCalmMs - 1000);
        expect(hook(() => useCardLive()).rhythm).toBe("normal");
    });

    it("turns calm after a long thought, and only while someone still works", () => {
        const working = { working: 1, waiting: 0, cardOpen: false };
        globalStore.set(agents.dataAtom, {
            states: { a: { state: "working", since: Date.now() - LongThoughtMs - 1000 } },
            versions: {},
        });
        expect(hook(() => useBlinkRhythm(working))).toBe("calm");
        expect(hook(() => useBlinkRhythm({ ...working, working: 0 }))).toBe("normal");
        globalStore.set(agents.dataAtom, {
            states: { a: { state: "working", since: Date.now() - LongThoughtMs + 60_000 } },
            versions: {},
        });
        expect(hook(() => useBlinkRhythm(working))).toBe("normal");
    });

    it("turns calm late at night", () => {
        vi.setSystemTime(new Date(2026, 5, 15, 1));
        expect(hook(() => useCardLive()).rhythm).toBe("calm");
        expect(hook(() => useBlinkRhythm({ working: 0, waiting: 0, cardOpen: false }))).toBe("calm");
    });

    it("hands the group's portrait the rhythm it read, so that no face keeps one of its own", () => {
        globalStore.set(expressions.lastKeyAtAtom, Date.now());
        expect(hook(() => useCardLive())).toMatchObject({ rhythm: "calm" });
        const hubSource = readFileSync(join(__dirname, "use-brokk-hub.ts"), "utf8");
        const liveSource = readFileSync(join(__dirname, "use-brokk-live.ts"), "utf8");
        expect(hubSource).not.toMatch(/rhythm: "(calm|normal)"/);
        expect(liveSource).not.toMatch(/rhythm: "(calm|normal)"/);
    });

    it("is read from the stores and not from the keystrokes: the face is drawn again only when the rhythm changes", () => {
        const source = readFileSync(join(__dirname, "use-brokk-live.ts"), "utf8");
        const start = source.indexOf("export function useBlinkRhythm");
        const body = source.slice(start, source.indexOf("export function useCardLive"));
        expect(body).toContain("useSyncExternalStore");
        expect(body).not.toContain("useAtomValue");
    });
});

describe("reduced motion is read from its atom (FR-BOSS-009, AC1, #2224, AC-2)", () => {
    it("follows the setting: what a face reads is the atom's value at once, and motion is allowed only without it", () => {
        expect(hook(() => useReducedMotion())).toBe(false);
        expect(hook(() => useMotionAllowed())).toBe(true);
        setReduced(true);
        expect(hook(() => useReducedMotion())).toBe(true);
        expect(hook(() => useMotionAllowed())).toBe(false);
        setReduced(false);
        expect(hook(() => useReducedMotion())).toBe(false);
        expect(hook(() => useMotionAllowed())).toBe(true);
    });

    it("keeps his face mounted wherever it can be seen, reduced motion or not", () => {
        setReduced(true);
        expect(hook(() => useCardLive())).not.toBeNull();
        const activity = TabActivity.getInstance();
        globalStore.set(activity.documentVisibleAtom, false);
        expect(hook(() => useCardLive())).toBeNull();
        globalStore.set(activity.documentVisibleAtom, true);
        TabActivity.resetInstance();
    });

    it("no face asks the page's media query while it draws: every one reads the atom", () => {
        for (const file of ["use-brokk-live.ts", "use-brokk-hub.ts", "brokk-visit-scene.tsx"]) {
            const source = readFileSync(join(__dirname, file), "utf8");
            expect(source, file).not.toMatch(/prefersReducedMotion\(/);
            expect(source, file).not.toContain("molten-motion");
        }
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

describe("the scene the portrait reads (FR-BOSS-007, AC10, #1959)", () => {
    function scene(options: { cardOpen?: boolean; pinned?: boolean; speaks?: boolean } = {}): BrokkScene {
        return hook(() => {
            const situation = useBrokkSituation(options.cardOpen === true, false);
            return useBrokkScene({
                pinned: options.pinned === true,
                situation,
                speaks: options.speaks === true,
            });
        });
    }

    it("is calm with nothing going on", () => {
        const s = scene();
        expect(s.face).toBe("listening");
        expect(Object.keys(s)).not.toContain("caption");
    });

    it("carries the badge's count in the round, where the badge counts it", () => {
        globalStore.set(face.faceBadgeAtom, { count: 1, text: "1", tone: "waiting" });
        globalStore.set(bubble.toHandleAtom, { items: [row("agent:a")], info: [], parked: 0 });
        const s = scene();
        expect(s.round).toMatchObject({ count: 1, text: "1" });
    });

    it("shows the domino while agents work, with no gesture", () => {
        globalStore.set(bubble.workingCountAtom, 1);
        const working = scene();
        expect(working.loader).toBe(true);
        expect(working.gesture).toBeNull();
        globalStore.set(bubble.workingCountAtom, 0);
        expect(scene().loader).toBe(false);
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
        setReduced(true);
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
        globalStore.set(face.faceBadgeAtom, { count: 2, text: "2", tone: "error" });
        globalStore.set(bubble.workingCountAtom, 1);
        expect(hook(() => useCardLive()).situation).toMatchObject({ waiting: 2, working: 1, cardOpen: true });
    });

    it("keeps listening and answering under reduced motion, and tells the face to play none of what is asked (#2224, AC-1)", () => {
        setReduced(true);
        const asked = { expression: "smile", cue: 1, at: Date.now() };
        globalStore.set(expressions.askedAtom, asked);
        const typing = hook(() => useCardLive("typing"));
        expect(typing).toMatchObject({ calm: true, situation: { talk: "typing" } });
        expect(hook(() => useCardLive("answering")).situation.talk).toBe("answering");
        // The gesture is still handed over, so that a face turned back to full motion does not replay an old one.
        expect(typing.asked).toBe(asked);
    });

    it("speaks on opening when something waits: the face speaks, and no sentence of the notifications is read", () => {
        globalStore.set(face.faceBadgeAtom, { count: 1, text: "1", tone: "waiting" });
        globalStore.set(bubble.toHandleAtom, { items: [row("agent:a")], info: [], parked: 0 });
        const scene = hook(() => {
            const situation = useBrokkSituation(true, false);
            return useBrokkScene({ pinned: false, situation, speaks: true });
        });
        expect(scene.face).toBe("speaking");
        expect(JSON.stringify(scene)).not.toContain("Olivia");
    });

    // #2203: the line under the square used to be the caption of this scene and repeated the Notifications panel.
    it("is wired to the portrait through the same hooks the panel used, with no video or package of its own", () => {
        const group = readFileSync(join(__dirname, "brokk-group.tsx"), "utf8");
        expect(group).toContain("useCardLive(pose)");
        expect(group).toContain("useBrokkMoment(shown && !answerHoldsLine)");
        expect(group).not.toContain("useGroupCaption");
        expect(group).toContain('<BossPortrait live={live} framing="banner" />');
        expect(group).not.toContain("TransmissionPortrait");
        expect(group).not.toContain("<video");
    });

    it("keeps the expressions model watching, and lets his nod answer what the developer handles in the panels", () => {
        const host = readFileSync(join(__dirname, "brokk-hub-host.tsx"), "utf8");
        expect(host).toContain("BrokkExpressionsModel.getInstance().watch(document)");
        const actions = readFileSync(join(__dirname, "use-brokk-actions.ts"), "utf8");
        expect(actions).toContain("BrokkExpressionsModel.getInstance().noteHandled(handled)");
    });
});
