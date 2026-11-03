// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
    appPanelStep,
    NoPanelMatch,
    panelCtaStep,
    panelOrigin,
    sameViewMatch,
    viewIsPinned,
    wantsNewView,
} from "./app-panel-model";
import {
    GlobalPinMetaKey,
    PinConfigMetaKey,
    PinMetaKey,
    PinWorkspace,
    ProjectTabMetaKey,
} from "./sidebar/view-pins-model";

const Config = { tree: { pane: 0 }, panes: [{ view: "term" }] };

describe("viewIsPinned (FR-SHELL-094)", () => {
    const globalIds = new Set(["g1"]);

    it("counts a view pinned in the workspace, everywhere, and the Project tab", () => {
        expect(viewIsPinned({ meta: { [PinMetaKey]: PinWorkspace, [PinConfigMetaKey]: Config } }, globalIds)).toBe(
            true
        );
        expect(viewIsPinned({ meta: { [GlobalPinMetaKey]: "g1" } }, globalIds)).toBe(true);
        expect(viewIsPinned({ meta: { [ProjectTabMetaKey]: true } }, globalIds)).toBe(true);
    });

    it("leaves a temporary view, a pin that no longer exists and no view at all", () => {
        expect(viewIsPinned({ meta: {} }, globalIds)).toBe(false);
        expect(viewIsPinned({ meta: { [GlobalPinMetaKey]: "gone" } }, globalIds)).toBe(false);
        expect(viewIsPinned(null, globalIds)).toBe(false);
    });
});

describe("appPanelStep (FR-SHELL-094)", () => {
    it("focuses the panel the active view already shows, pinned or not", () => {
        expect(appPanelStep({ activePinned: true, inActive: "b1", elsewhere: null })).toEqual({
            kind: "focus",
            blockId: "b1",
        });
        expect(appPanelStep({ activePinned: false, inActive: "b1", elsewhere: null })).toEqual({
            kind: "focus",
            blockId: "b1",
        });
    });

    it("adds the panel to a temporary view", () => {
        expect(
            appPanelStep({ activePinned: false, inActive: null, elsewhere: { tabId: "t2", blockId: "b2" } })
        ).toEqual({ kind: "add" });
    });

    it("never adds to a pinned view: the view showing the panel comes forward, else a new view", () => {
        expect(appPanelStep({ activePinned: true, inActive: null, elsewhere: { tabId: "t2", blockId: "b2" } })).toEqual(
            { kind: "show", tabId: "t2", blockId: "b2" }
        );
        expect(appPanelStep({ activePinned: true, inActive: null, elsewhere: null })).toEqual({ kind: "newview" });
    });
});

describe("panelCtaStep (#1844, FR-SHELL-139 AC13)", () => {
    const here = { newView: false, inActive: null as string, sourceBlockId: "src", sourceLaidOut: true };

    it("opens the panel beside the one the call to action is in", () => {
        expect(panelCtaStep(here)).toEqual({ kind: "beside", sourceBlockId: "src" });
    });

    it("reuses the panel the view already shows, wherever it is", () => {
        expect(panelCtaStep({ ...here, inActive: "b9" })).toEqual({ kind: "focus", blockId: "b9" });
        expect(panelCtaStep({ ...here, inActive: "b9", sourceLaidOut: false })).toEqual({
            kind: "focus",
            blockId: "b9",
        });
    });

    it("opens a new view only when the call to action asked for one, even with the panel at hand", () => {
        expect(panelCtaStep({ ...here, newView: true })).toEqual({ kind: "newview" });
        expect(panelCtaStep({ ...here, newView: true, inActive: "b9" })).toEqual({ kind: "newview" });
    });

    it("falls back to the app action's rules without a panel laid out to open beside", () => {
        expect(panelCtaStep({ ...here, sourceLaidOut: false })).toEqual({ kind: "door" });
        expect(panelCtaStep({ ...here, sourceBlockId: null })).toEqual({ kind: "door" });
    });
});

describe("wantsNewView (#1844)", () => {
    it("is the browser's open in a new window: Shift, or the platform's command key", () => {
        expect(wantsNewView({ shiftKey: true }, true)).toBe(true);
        expect(wantsNewView({ shiftKey: true }, false)).toBe(true);
        expect(wantsNewView({ metaKey: true }, true)).toBe(true);
        expect(wantsNewView({ ctrlKey: true }, false)).toBe(true);
    });

    it("leaves a plain click, the other platform's command key, and a call without a click", () => {
        expect(wantsNewView({}, true)).toBe(false);
        expect(wantsNewView({ ctrlKey: true }, true)).toBe(false);
        expect(wantsNewView({ metaKey: true }, false)).toBe(false);
        expect(wantsNewView(undefined, true)).toBe(false);
    });

    it("builds the origin of a call to action from its panel and its click", () => {
        expect(panelOrigin("b1", { shiftKey: true }, true)).toEqual({ blockId: "b1", newView: true });
        expect(panelOrigin("b1", undefined, false)).toEqual({ blockId: "b1", newView: false });
    });
});

describe("NoPanelMatch", () => {
    it("matches no open panel", () => {
        expect(NoPanelMatch({ view: "term" })).toBe(false);
    });
});

describe("sameViewMatch", () => {
    it("matches the same view, and the same settings file", () => {
        const settings = sameViewMatch({ meta: { view: "waveconfig" } });
        expect(settings({ view: "waveconfig", "molten:settings:section": "agents" })).toBe(true);
        expect(settings({ view: "waveconfig", file: "widgets.json" })).toBe(false);
        expect(settings({ view: "term" })).toBe(false);
        const widgets = sameViewMatch({ meta: { view: "waveconfig", file: "widgets.json" } });
        expect(widgets({ view: "waveconfig", file: "widgets.json" })).toBe(true);
        expect(widgets({ view: "waveconfig" })).toBe(false);
    });
});
