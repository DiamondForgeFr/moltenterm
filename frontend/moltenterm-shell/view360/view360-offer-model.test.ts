// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import type { LayoutModel } from "@/layout/lib/layoutModel";
import { findNode } from "@/layout/lib/layoutNode";
import { FlexDirection, type LayoutNode } from "@/layout/lib/types";
import { atom, type PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showToast } from "../toast-store";
import { PlacesToastId } from "./carpet-places-toast";
import type { FakeScreens } from "./screen-store-fake";
import type { ScreenInfo } from "./screen-threshold";
import {
    OfferGrid,
    OfferTaken,
    View360FixedPxMetaKey,
    View360MetaKey,
    View360OfferMetaKey,
    View360PlacesMetaKey,
} from "./view360-meta";
import { View360Model } from "./view360-model";
import { View360NoticeToastId } from "./view360-notice";

const settings = vi.hoisted(() => ({ view360: null as unknown, places: null as unknown }));
const screens = vi.hoisted(() => ({ fake: null as unknown, threshold: null as unknown }));

vi.mock("@/app/store/global", async () => {
    const { atom } = await import("jotai");
    settings.view360 = atom<string>(undefined);
    settings.places = atom<string>(undefined);
    return {
        getSettingsKeyAtom: (key: string) => (key === "moltenterm:view360places" ? settings.places : settings.view360),
    };
});
vi.mock("./screen-store", async () => {
    const { atom } = await import("jotai");
    const { makeFakeScreens } = await import("./screen-store-fake");
    screens.threshold = atom(2);
    screens.fake = makeFakeScreens(screens.threshold);
    return { ScreenModel: { getInstance: () => screens.fake } };
});
vi.mock("@/app/store/wshclientapi", () => ({
    RpcApi: { SetMetaCommand: vi.fn(() => Promise.resolve()), SetConfigCommand: vi.fn(() => Promise.resolve()) },
}));
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
vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0));
vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));

const Wide = { top: 0, left: 0, width: 2400, height: 900 };
const laptop: ScreenInfo = { key: "1512x982@2", widthpx: 1512, heightpx: 982, scalefactor: 2 };

function setSetting(value: string) {
    globalStore.set(settings.view360 as PrimitiveAtom<string>, value);
}

function setStoredPlaces(value: string) {
    globalStore.set(settings.places as PrimitiveAtom<string>, value);
}

function fakeScreens(): FakeScreens {
    return screens.fake as FakeScreens;
}

function leaf(id: string): LayoutNode {
    return { id, flexDirection: FlexDirection.Column, size: 10, data: { blockId: `b-${id}` } };
}

function rowOf(n: number): LayoutNode {
    return {
        id: "root",
        flexDirection: FlexDirection.Row,
        size: 10,
        children: Array.from({ length: n }, (_, i) => leaf(`c${i}`)),
    };
}

// The view's tree is the last one passed, as the layout model's would be.
function makeModel(meta: Record<string, unknown> = {}) {
    const tabAtom = atom({ oid: "tab-1", meta } as unknown as Tab) as PrimitiveAtom<Tab>;
    const focusedNode = atom(null as LayoutNode) as PrimitiveAtom<LayoutNode>;
    const state = { rootNode: rowOf(2) };
    const layoutModel = {
        focusedNode,
        updateTree: vi.fn(),
        treeReducer: vi.fn(),
        treeState: state,
        displayContainerRef: { current: null },
        getNodeByBlockId: (blockId: string) => findNode(state.rootNode, blockId.replace(/^b-/, "")),
        focusNode: vi.fn((id: string) => globalStore.set(focusedNode, findNode(state.rootNode, id))),
    } as unknown as LayoutModel;
    const model = new View360Model(layoutModel, tabAtom);
    const pass = (columns: number, bounds = Wide) => {
        state.rootNode = rowOf(columns);
        model.evaluate(state.rootNode, bounds);
        return model.computeLayout(state.rootNode, bounds);
    };
    return { model, tabAtom, layoutModel, pass };
}

function metaWrites(): Record<string, unknown>[] {
    return vi.mocked(RpcApi.SetMetaCommand).mock.calls.map((c) => c[1].meta as Record<string, unknown>);
}

function noticeToasts() {
    return vi.mocked(showToast).mock.calls.filter((c) => c[0].id === View360NoticeToastId);
}

function offeredNumbers(model: View360Model): number[] {
    return (globalStore.get(model.offerAtom)?.options ?? []).filter((o) => o.offered).map((o) => o.n);
}

beforeEach(() => {
    vi.mocked(RpcApi.SetMetaCommand).mockClear();
    vi.mocked(RpcApi.SetConfigCommand).mockClear();
    vi.mocked(showToast).mockClear();
    setSetting(undefined);
    setStoredPlaces(undefined);
    globalStore.set(screens.threshold as PrimitiveAtom<number>, 2);
    const fake = fakeScreens();
    fake.screen = null;
    fake.offered = false;
    fake.saved.length = 0;
    fake.declined.length = 0;
    fake.threshold = 2;
});

afterEach(() => {
    setSetting(undefined);
    setStoredPlaces(undefined);
});

describe("the first-time offer (FR-SHELL-066-AC11, #2180)", () => {
    it("is shown instead of the switch when a view that never was in 360 view goes beyond the threshold (AC-1)", () => {
        const { model, pass } = makeModel();
        expect(pass(2)).toBeNull();
        expect(globalStore.get(model.offerAtom)).toBeNull();
        // The third column: no switch, no notice, an offer with the numbers the chooser would offer.
        expect(pass(3)).toBeNull();
        expect(model.active).toBe(false);
        expect(offeredNumbers(model)).toEqual([1]);
        expect(globalStore.get(model.decisionAtom)).toMatchObject({ active: false, wanted: false, asking: true });
        expect(noticeToasts()).toHaveLength(0);
        expect(metaWrites().some((m) => View360FixedPxMetaKey in m)).toBe(false);
        // More columns on a wide view: more numbers.
        pass(5);
        expect(offeredNumbers(model)).toEqual([1, 2, 3]);
    });

    it("is not a toast, and does not touch the focus", () => {
        const { model, pass, layoutModel } = makeModel();
        pass(2);
        pass(3);
        expect(globalStore.get(model.offerAtom)).not.toBeNull();
        expect(vi.mocked(showToast)).not.toHaveBeenCalled();
        expect(layoutModel.focusNode).not.toHaveBeenCalled();
    });

    it("goes when the view drops back within the threshold, and comes back while it is unanswered", () => {
        const { model, pass } = makeModel();
        pass(2);
        pass(3);
        expect(globalStore.get(model.offerAtom)).not.toBeNull();
        pass(2);
        expect(globalStore.get(model.offerAtom)).toBeNull();
        pass(3);
        expect(globalStore.get(model.offerAtom)).not.toBeNull();
    });

    it("is not shown within the threshold of a larger screen", () => {
        globalStore.set(screens.threshold as PrimitiveAtom<number>, 3);
        const { model, pass } = makeModel();
        pass(3);
        expect(globalStore.get(model.offerAtom)).toBeNull();
        pass(4);
        expect(globalStore.get(model.offerAtom)).not.toBeNull();
    });

    it("is not shown to a view that was in 360 view, nor once the setting is chosen: they switch as before", () => {
        const history = [
            { [View360FixedPxMetaKey]: 700 },
            { [View360MetaKey]: false },
            { [View360PlacesMetaKey]: 1 },
            { [View360OfferMetaKey]: OfferGrid },
        ];
        for (const meta of history) {
            const { model, pass } = makeModel(meta);
            pass(2);
            pass(3);
            expect(globalStore.get(model.offerAtom)).toBeNull();
        }
        const { model, pass } = makeModel({ [View360FixedPxMetaKey]: 700 });
        pass(2);
        pass(3);
        expect(model.active).toBe(true);
        for (const chosen of ["auto", "always"]) {
            setSetting(chosen);
            const fresh = makeModel();
            fresh.pass(2);
            fresh.pass(3);
            expect(globalStore.get(fresh.model.offerAtom)).toBeNull();
            expect(fresh.model.active).toBe(true);
        }
    });

    it("leaves the readable-minimum safety net: columns that cannot fit still go to 360 view, without the offer", () => {
        const { model, pass } = makeModel();
        pass(2, { ...Wide, width: 1000 });
        pass(5, { ...Wide, width: 1000 });
        expect(model.active).toBe(true);
        expect(globalStore.get(model.offerAtom)).toBeNull();
    });

    it("a setting chosen elsewhere takes the offer away at the next pass", () => {
        const { model, pass, layoutModel } = makeModel();
        pass(2);
        pass(3);
        expect(globalStore.get(model.offerAtom)).not.toBeNull();
        vi.mocked(layoutModel.updateTree).mockClear();
        setSetting("grid");
        expect(layoutModel.updateTree).toHaveBeenCalled();
        pass(3);
        expect(globalStore.get(model.offerAtom)).toBeNull();
        expect(model.active).toBe(false);
    });
});

describe("answering the offer (AC-1, AC-2, AC-4)", () => {
    it("360 × N applies the number to the view and the offer does not come back", () => {
        const { model, pass } = makeModel();
        pass(2);
        pass(3);
        expect(model.answerOffer(1, false)).toBe(true);
        expect(globalStore.get(model.offerAtom)).toBeNull();
        expect(model.places()).toBe(1);
        expect(metaWrites().at(-1)).toEqual({ [View360PlacesMetaKey]: 1 });
        expect(metaWrites()).toContainEqual({ [View360OfferMetaKey]: OfferTaken });
        expect(RpcApi.SetConfigCommand).not.toHaveBeenCalled();
        pass(3);
        expect(model.active).toBe(true);
        expect(globalStore.get(model.shownPlacesAtom)).toBe(1);
        pass(4);
        expect(globalStore.get(model.offerAtom)).toBeNull();
        // Leaving 360 view forgets the view's N but not that it was in 360 view: no offer afterwards either.
        model.requestLeave();
        pass(4);
        expect(globalStore.get(model.offerAtom)).toBeNull();
    });

    it("its Undo takes the answer back: the view is offered the switch again", () => {
        const { model, pass } = makeModel();
        pass(2);
        pass(3);
        model.answerOffer(1, false);
        pass(3);
        expect(globalStore.get(model.offerAtom)).toBeNull();
        const undo = vi
            .mocked(showToast)
            .mock.calls.filter((c) => c[0].id === PlacesToastId)
            .at(-1)[0].actions[0];
        undo.run();
        expect(model.places()).toBeNull();
        expect(model.offerAnswer()).toBeNull();
        expect(metaWrites().at(-1)).toEqual({ [View360PlacesMetaKey]: null });
        expect(metaWrites()).toContainEqual({ [View360OfferMetaKey]: null });
        pass(3);
        expect(model.active).toBe(false);
        expect(offeredNumbers(model)).toEqual([1]);
    });

    it("a 360 × N applied by hand answers it too: leaving the view does not bring the offer back", () => {
        const { model, pass } = makeModel();
        pass(5);
        expect(globalStore.get(model.offerAtom)).not.toBeNull();
        expect(model.applyPlaces("b-c2", 2)).toBe(true);
        expect(model.offerAnswer()).toBe(OfferTaken);
        pass(5);
        expect(globalStore.get(model.offerAtom)).toBeNull();
        model.requestLeave();
        pass(5);
        expect(model.places()).toBeNull();
        expect(globalStore.get(model.offerAtom)).toBeNull();
    });

    it("a number applied to a view that kept the grid replaces that answer, its Undo gives it back", () => {
        const { model, pass } = makeModel({ [View360OfferMetaKey]: OfferGrid });
        pass(5);
        expect(model.applyPlaces("b-c1", 1)).toBe(true);
        expect(model.offerAnswer()).toBe(OfferTaken);
        const undo = vi
            .mocked(showToast)
            .mock.calls.filter((c) => c[0].id === PlacesToastId)
            .at(-1)[0].actions[0];
        undo.run();
        expect(model.offerAnswer()).toBe(OfferGrid);
    });

    it("refuses a number that does not apply, and the offer stays", () => {
        const { model, pass } = makeModel();
        pass(2);
        pass(3);
        expect(model.answerOffer(3, false)).toBe(false);
        expect(globalStore.get(model.offerAtom)).not.toBeNull();
        expect(model.places()).toBeNull();
    });

    it("Keep the grid leaves the view as it is, remembered by the view, and the offer does not come back", () => {
        const { model, pass } = makeModel();
        pass(2);
        pass(3);
        expect(model.answerOffer(OfferGrid, false)).toBe(true);
        expect(metaWrites().at(-1)).toEqual({ [View360OfferMetaKey]: OfferGrid });
        expect(RpcApi.SetConfigCommand).not.toHaveBeenCalled();
        expect(globalStore.get(model.offerAtom)).toBeNull();
        pass(3);
        expect(model.active).toBe(false);
        pass(5);
        expect(model.active).toBe(false);
        expect(globalStore.get(model.offerAtom)).toBeNull();
        expect(globalStore.get(model.decisionAtom)).toMatchObject({ source: "setting" });
        expect(globalStore.get(model.decisionAtom).asking).toBeUndefined();
        // The view still goes to 360 view when its columns cannot fit at all.
        pass(5, { ...Wide, width: 1000 });
        expect(model.active).toBe(true);
    });

    it("what a view answered holds for that view only: another view is offered the switch", () => {
        const first = makeModel();
        first.pass(2);
        first.pass(3);
        first.model.answerOffer(OfferGrid, false);
        const other = makeModel();
        other.pass(2);
        other.pass(3);
        expect(globalStore.get(other.model.offerAtom)).not.toBeNull();
        expect(other.model.active).toBe(false);
    });

    it("with Do the same in every view, the answer is stored in the settings (AC-2)", async () => {
        const { model, pass } = makeModel();
        pass(2);
        pass(3);
        model.answerOffer(1, true);
        expect(RpcApi.SetConfigCommand).toHaveBeenCalledTimes(1);
        expect(RpcApi.SetConfigCommand).toHaveBeenCalledWith(
            {},
            { "moltenterm:view360": "auto", "moltenterm:view360places": "1" }
        );
        const grid = makeModel();
        grid.pass(2);
        grid.pass(3);
        grid.model.answerOffer(OfferGrid, true);
        expect(RpcApi.SetConfigCommand).toHaveBeenLastCalledWith({}, { "moltenterm:view360": "grid" });
    });
});

describe("another view after Do the same in every view (AC-2)", () => {
    it("gets the stored 360 × N when a column is added across the threshold, with no offer and no message", () => {
        setSetting("auto");
        setStoredPlaces("2");
        const { model, pass } = makeModel();
        pass(2);
        expect(model.places()).toBeNull();
        pass(3);
        expect(model.places()).toBe(2);
        expect(metaWrites().at(-1)).toEqual({ [View360PlacesMetaKey]: 2 });
        expect(globalStore.get(model.offerAtom)).toBeNull();
        expect(vi.mocked(showToast)).not.toHaveBeenCalled();
        // Two panels beside the first column are both visible: nothing is stored, so the view rests as the grid...
        expect(globalStore.get(model.decisionAtom)).toMatchObject({ active: false, idle: true });
        // ...and the carpet comes back, with the same N, once a panel would be stored.
        pass(4);
        expect(model.active).toBe(true);
        expect(globalStore.get(model.shownPlacesAtom)).toBe(2);
        expect(globalStore.get(model.signalAtom)).toBe(0);
        expect(vi.mocked(showToast)).not.toHaveBeenCalled();
    });

    it("keeps the grid under the stored Keep the grid, with no offer", () => {
        setSetting("grid");
        const { model, pass } = makeModel();
        pass(2);
        pass(5);
        expect(model.active).toBe(false);
        expect(globalStore.get(model.offerAtom)).toBeNull();
        expect(model.places()).toBeNull();
    });

    it("keeps the plain automatic 360 view when no number is stored", () => {
        setSetting("auto");
        const { model, pass } = makeModel();
        pass(2);
        pass(3);
        expect(model.active).toBe(true);
        expect(model.places()).toBeNull();
    });

    it("does not choose for a view the developer turned off by hand, nor for one that opens beyond the threshold", () => {
        setSetting("auto");
        setStoredPlaces("1");
        const off = makeModel({ [View360MetaKey]: false });
        off.pass(2);
        off.pass(3);
        expect(off.model.places()).toBeNull();
        const opened = makeModel();
        opened.pass(4);
        expect(opened.model.places()).toBeNull();
        expect(opened.model.active).toBe(true);
    });

    it("ignores a stored number under Keep the grid or Always, and a value that is not 1, 2 or 3", () => {
        setStoredPlaces("2");
        for (const setting of ["grid", "always", undefined]) {
            setSetting(setting);
            const { model, pass } = makeModel({ [View360FixedPxMetaKey]: 700 });
            pass(2);
            pass(3);
            expect(model.places()).toBeNull();
        }
        setSetting("auto");
        setStoredPlaces("7");
        const { model, pass } = makeModel();
        pass(2);
        pass(3);
        expect(model.places()).toBeNull();
    });
});

describe("saving the screen (FR-SHELL-066-AC12, AC-3)", () => {
    beforeEach(() => {
        const fake = fakeScreens();
        fake.screen = laptop;
        fake.offered = true;
    });

    it("is offered once after the offer is answered with a number, with the threshold it would save", () => {
        const { model, pass } = makeModel();
        pass(2);
        pass(5);
        model.answerOffer(2, false);
        expect(globalStore.get(model.screenOfferAtom)).toEqual({ screen: laptop, columns: 3 });
        model.answerScreenOffer(true);
        expect(fakeScreens().saved).toEqual([{ columns: 3, screen: laptop }]);
        expect(fakeScreens().declined).toEqual([]);
        expect(globalStore.get(model.screenOfferAtom)).toBeNull();
    });

    it("Not now remembers the screen as asked and saves nothing", () => {
        const { model, pass } = makeModel();
        pass(2);
        pass(3);
        model.answerOffer(1, false);
        expect(globalStore.get(model.screenOfferAtom)).toEqual({ screen: laptop, columns: 2 });
        model.answerScreenOffer(false);
        expect(fakeScreens().saved).toEqual([]);
        expect(fakeScreens().declined).toEqual([laptop]);
        expect(globalStore.get(model.screenOfferAtom)).toBeNull();
    });

    it("follows a number picked from the chooser, the view menu or the command panel too", () => {
        const { model, pass } = makeModel({ [View360FixedPxMetaKey]: 700 });
        pass(5);
        expect(model.applyPlaces("b-c1", 3)).toBe(true);
        expect(globalStore.get(model.screenOfferAtom)).toEqual({ screen: laptop, columns: 4 });
    });

    it("is not raised by Keep the grid, by an Undo, nor by the stored number a view takes by itself", () => {
        const grid = makeModel();
        grid.pass(2);
        grid.pass(3);
        grid.model.answerOffer(OfferGrid, false);
        expect(globalStore.get(grid.model.screenOfferAtom)).toBeNull();

        fakeScreens().offered = false;
        const picked = makeModel({ [View360FixedPxMetaKey]: 700 });
        picked.pass(5);
        picked.model.applyPlaces("b-c1", 2);
        fakeScreens().offered = true;
        const undo = vi
            .mocked(showToast)
            .mock.calls.filter((c) => c[0].id === PlacesToastId)
            .at(-1)[0].actions[0];
        undo.run();
        expect(globalStore.get(picked.model.screenOfferAtom)).toBeNull();

        setSetting("auto");
        setStoredPlaces("1");
        const adopting = makeModel();
        adopting.pass(2);
        adopting.pass(3);
        expect(adopting.model.places()).toBe(1);
        expect(globalStore.get(adopting.model.screenOfferAtom)).toBeNull();
    });

    it("is not raised for a screen the list holds or that was declined, nor without a known screen", () => {
        fakeScreens().offered = false;
        const held = makeModel();
        held.pass(2);
        held.pass(3);
        held.model.answerOffer(1, false);
        expect(globalStore.get(held.model.screenOfferAtom)).toBeNull();

        fakeScreens().offered = true;
        fakeScreens().screen = null;
        const unknown = makeModel();
        unknown.pass(2);
        unknown.pass(3);
        unknown.model.answerOffer(1, false);
        expect(globalStore.get(unknown.model.screenOfferAtom)).toBeNull();
    });

    it("answering with nothing on offer does nothing", () => {
        const { model } = makeModel();
        model.answerScreenOffer(true);
        expect(fakeScreens().saved).toEqual([]);
        expect(fakeScreens().declined).toEqual([]);
    });
});
