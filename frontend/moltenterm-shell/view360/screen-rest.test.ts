// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// One user action is one change of screen for the 360 cube (FR-SHELL-081, #1924): from the screen before the action to
// the one where the carpet rests, never through the screens a glide or a swipe crosses on the way. The carpet is the
// real model, driven frame by frame; what the publisher would hand the cube is read through the same functions as the
// hook's (screenToPublish) and fed to the cube's own rules.

import { globalStore } from "@/app/store/jotaiStore";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode } from "@/layout/lib/layoutNode";
import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { atom, type PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextCube, startCube, type CubeMotion } from "../sidebar/view-cube-model";
import { isGlyphCube } from "../sidebar/view-menu-model";
import { carpetScrollStops } from "./carpet-model";
import { describeScreen, sameScreen, screenGlyphIcons, screenToPublish, type ScreenDescription } from "./screen-glyph";
import { View360Model } from "./view360-model";

const settingAtom = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    settingAtom.current = atom<string>("auto");
    return { getSettingsKeyAtom: () => settingAtom.current };
});
const screenThreshold = vi.hoisted(() => ({ atom: null as unknown }));
vi.mock("./screen-store", async () => {
    const { atom } = await import("jotai");
    screenThreshold.atom = atom(8);
    return { ScreenModel: { getInstance: () => ({ thresholdAtom: screenThreshold.atom }) } };
});
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(() => Promise.resolve()) } }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: {} }));
vi.mock("../toast-store", () => ({ showToast: vi.fn(() => "toast:1") }));
vi.mock("../panel-size/panel-size-store", () => ({
    cachedBlockView: () => "web",
    currentPanelSizes: () => ({}),
    currentFirstColumnFloorPx: () => null,
    clearFirstColumnFloor: vi.fn(),
    setFirstColumnFloor: vi.fn(),
    rememberPanelWidth: vi.fn(),
}));

const Wide = { top: 0, left: 0, width: 2400, height: 900 };
const ColumnCount = 8;

function leaf(id: string): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size: 10, data: { blockId: `b-${id}` } };
}

// A fixed first column c0 and a carpet c1 to c7, each panel's block named b-<column>.
const BlockIds = Array.from({ length: ColumnCount }, (_, i) => `b-c${i}`);
const iconOf = (blockId: string) => `icon-${blockId}`;

type Carpet = { model: View360Model; root: LayoutNode };

function carpetOf(places: number): Carpet {
    const root: LayoutNode = {
        id: "root",
        flexDirection: FlexDirection.Row,
        size: 10,
        children: Array.from({ length: ColumnCount }, (_, i) => leaf(`c${i}`)),
    };
    const tabAtom = atom({ oid: "tab-1", meta: {} } as unknown as Tab) as PrimitiveAtom<Tab>;
    const layoutModel = {
        focusedNode: atom(null as LayoutNode),
        updateTree: vi.fn(),
        treeReducer: vi.fn(),
        treeState: { rootNode: root },
        displayContainerRef: { current: null },
        getNodeByBlockId: (blockId: string) => findNode(root, blockId.replace(/^b-/, "")),
        focusNode: vi.fn(),
    } as unknown as LayoutModel;
    const model = new View360Model(layoutModel, tabAtom);
    model.evaluate(root, Wide);
    model.computeLayout(root, Wide);
    model.applyPlaces("b-c1", places);
    model.evaluate(root, Wide);
    model.computeLayout(root, Wide);
    return { model, root };
}

// The cube a screen draws, as the sidebar reads it from the tab's meta.
function cubeOf(screen: ScreenDescription) {
    return screenGlyphIcons(screen, BlockIds, iconOf).find(isGlyphCube);
}

// The motions the cube makes for a series of screens, the first one being what it starts on.
function motionsOf(screens: ScreenDescription[]): CubeMotion[] {
    let state = startCube(cubeOf(screens[0]));
    return screens.slice(1).map((screen) => {
        state = nextCube(state, cubeOf(screen), true);
        return state.motion;
    });
}

function names(screen: ScreenDescription): string {
    const first = screen.carpet.indexOf(screen.front);
    return screen.carpet.slice(first, first + screen.shown).join(",");
}

describe("the 360 cube sees one screen per action (#1924)", () => {
    let queued = new Map<number, FrameRequestCallback>();
    let nextId = 1;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
        queued = new Map();
        vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
            const id = nextId++;
            queued.set(id, fn);
            return id;
        });
        vi.stubGlobal("cancelAnimationFrame", (id: number) => queued.delete(id));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    function frames(count: number, each?: (frame: number) => void) {
        for (let i = 0; i < count; i++) {
            vi.advanceTimersByTime(16);
            each?.(i);
            const callbacks = Array.from(queued.values());
            queued.clear();
            callbacks.forEach((fn) => fn(performance.now()));
        }
    }

    // Long enough for a glide (260 ms) and for a swipe to be declared over (140 ms).
    function settle() {
        frames(40);
    }

    // What a window publishes while the carpet is driven: every screen the hook would schedule (the new one, and the
    // one the carpet passes through if the hook is fed the columns in view as they are), without its debounce, which
    // can only drop some of them.
    function record({ model, root }: Carpet) {
        const read = (useRest: boolean) => {
            const ids = globalStore.get(useRest ? model.restColumnIdsAtom : model.visibleColumnIdsAtom);
            const moving = useRest && globalStore.get(model.freeScrollAtom);
            return screenToPublish(root, model.layout, ids, moving, ColumnCount);
        };
        const onRest: ScreenDescription[] = [read(true)];
        const live: ScreenDescription[] = [read(false)];
        const push = (list: ScreenDescription[], next: ScreenDescription) => {
            if (next !== undefined && !sameScreen(next, list[list.length - 1])) {
                list.push(next);
            }
        };
        const subs = [
            globalStore.sub(model.restColumnIdsAtom, () => push(onRest, read(true))),
            globalStore.sub(model.freeScrollAtom, () => push(onRest, read(true))),
            globalStore.sub(model.visibleColumnIdsAtom, () => push(live, read(false))),
        ];
        return { onRest, live, stop: () => subs.forEach((unsub) => unsub()) };
    }

    it("reads two panels per screen: the carpet starts on [1,2]", () => {
        const carpet = carpetOf(2);
        settle();
        const { onRest } = record(carpet);
        expect(names(onRest[0])).toBe("b-c1,b-c2");
    });

    describe("a click on a tab", () => {
        it("replaces both panels of a prism: one screen after it, whatever the glide crosses", () => {
            const carpet = carpetOf(2);
            settle();
            const seen = record(carpet);
            carpet.model.scrollToColumn("c4");
            settle();
            expect(seen.onRest.map(names)).toEqual(["b-c1,b-c2", "b-c3,b-c4"]);
            expect(motionsOf(seen.onRest)).toEqual(["prism-turn"]);
            seen.stop();
        });

        it("would have shown the screens the glide crosses, and made a stretch of the first one", () => {
            const carpet = carpetOf(2);
            settle();
            const seen = record(carpet);
            carpet.model.scrollToColumn("c4");
            settle();
            expect(seen.live.map(names)).toEqual(["b-c1,b-c2", "b-c1,b-c2,b-c3", "b-c2,b-c3,b-c4", "b-c3,b-c4"]);
            const motions = motionsOf(seen.live);
            expect(motions.filter((m) => m !== "none").length).toBeGreaterThan(1);
            expect(motions).not.toContain("prism-turn");
            expect(motions[0]).toBe("stretch");
            seen.stop();
        });

        it("follows the developer's sequence: [1,2], tab 4, tab 2 is a turn, then a slide", () => {
            const carpet = carpetOf(2);
            settle();
            const seen = record(carpet);
            carpet.model.scrollToColumn("c4");
            settle();
            carpet.model.scrollToColumn("c2");
            settle();
            expect(seen.onRest.map(names)).toEqual(["b-c1,b-c2", "b-c3,b-c4", "b-c2,b-c3"]);
            expect(motionsOf(seen.onRest)).toEqual(["prism-turn", "slide"]);
            seen.stop();
        });

        it("moves a single panel: always a turn, never a prism in between", () => {
            const carpet = carpetOf(1);
            settle();
            const seen = record(carpet);
            carpet.model.scrollToColumn("c2");
            settle();
            carpet.model.scrollToColumn("c6");
            settle();
            carpet.model.scrollToColumn("c3");
            settle();
            expect(seen.onRest.map(names)).toEqual(["b-c1", "b-c2", "b-c6", "b-c3"]);
            expect(motionsOf(seen.onRest)).toEqual(["turn", "turn", "turn"]);
            seen.stop();
        });

        it("would have hesitated between the prism and the cube for a single panel", () => {
            const carpet = carpetOf(1);
            settle();
            const seen = record(carpet);
            carpet.model.scrollToColumn("c2");
            settle();
            expect(seen.live.map(names)).toEqual(["b-c1", "b-c1,b-c2", "b-c2"]);
            expect(motionsOf(seen.live)).toEqual(["stretch", "stretch"]);
            seen.stop();
        });

        it("publishes the screen the carpet is going to, from the first frame of its glide", () => {
            const carpet = carpetOf(2);
            settle();
            const seen = record(carpet);
            carpet.model.scrollToColumn("c4");
            expect(globalStore.get(carpet.model.glideTargetAtom)).not.toBeNull();
            expect(names(seen.onRest[seen.onRest.length - 1])).toBe("b-c3,b-c4");
            frames(1);
            expect(seen.onRest).toHaveLength(2);
            settle();
            expect(globalStore.get(carpet.model.glideTargetAtom)).toBeNull();
            expect(seen.onRest).toHaveLength(2);
            seen.stop();
        });

        it("changes what the cube is fed once, not once per scroll frame", () => {
            const carpet = carpetOf(2);
            settle();
            let rest = 0;
            let live = 0;
            const unsubs = [
                globalStore.sub(carpet.model.restColumnIdsAtom, () => rest++),
                globalStore.sub(carpet.model.visibleColumnIdsAtom, () => live++),
            ];
            carpet.model.scrollToColumn("c4");
            settle();
            expect(rest).toBe(1);
            expect(live).toBeGreaterThan(2);
            unsubs.forEach((unsub) => unsub());
        });

        it("rests where a second click sent it when it comes before the first glide ended", () => {
            const carpet = carpetOf(2);
            settle();
            const seen = record(carpet);
            carpet.model.scrollToColumn("c5");
            frames(3);
            carpet.model.scrollToColumn("c2");
            settle();
            expect(names(seen.onRest[seen.onRest.length - 1])).toBe("b-c2,b-c3");
            expect(globalStore.get(carpet.model.glideTargetAtom)).toBeNull();
            seen.stop();
        });
    });

    describe("a swipe or a drag", () => {
        it("publishes nothing while it moves the carpet, and the screen it stops on after", () => {
            const carpet = carpetOf(2);
            settle();
            const seen = record(carpet);
            const stops = carpetScrollStops(carpet.model.layout);
            const end = stops[3];
            const steps = 24;
            frames(steps, (i) => carpet.model.scrollTo((end * (i + 1)) / steps));
            expect(globalStore.get(carpet.model.freeScrollAtom)).toBe(true);
            expect(seen.live.length).toBeGreaterThan(3);
            expect(seen.onRest).toHaveLength(1);
            settle();
            expect(globalStore.get(carpet.model.freeScrollAtom)).toBe(false);
            expect(seen.onRest.map(names)).toEqual(["b-c1,b-c2", names(describeAt(carpet, end))]);
            expect(motionsOf(seen.onRest)).toHaveLength(1);
            seen.stop();
        });

        it("is no free scroll when a glide moves the carpet", () => {
            const carpet = carpetOf(2);
            settle();
            const flags: boolean[] = [];
            const unsub = globalStore.sub(carpet.model.freeScrollAtom, () =>
                flags.push(globalStore.get(carpet.model.freeScrollAtom))
            );
            carpet.model.scrollToColumn("c4");
            settle();
            expect(flags).toEqual([]);
            unsub();
        });
    });

    describe("the number of panels on screen changes", () => {
        it("stretches once from two panels to one, and back", () => {
            const carpet = carpetOf(2);
            settle();
            const seen = record(carpet);
            carpet.model.applyPlaces("b-c1", 1);
            carpet.model.evaluate(carpet.root, Wide);
            carpet.model.computeLayout(carpet.root, Wide);
            settle();
            carpet.model.applyPlaces("b-c1", 2);
            carpet.model.evaluate(carpet.root, Wide);
            carpet.model.computeLayout(carpet.root, Wide);
            settle();
            expect(seen.onRest.map((s) => s.shown)).toEqual([2, 1, 2]);
            expect(motionsOf(seen.onRest)).toEqual(["stretch", "stretch"]);
            seen.stop();
        });
    });

    // The screen the carpet shows when it stands at a scroll position.
    function describeAt({ model, root }: Carpet, scrollLeft: number): ScreenDescription {
        const stands = model.layout.columns.filter(
            (c) => c.x + c.width > scrollLeft + 1 && c.x < scrollLeft + model.layout.viewport.width - 1
        );
        return describeScreen(
            root,
            model.layout,
            stands.map((c) => c.nodeId)
        );
    }
});
