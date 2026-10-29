// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { appPanelStep, sameViewMatch, viewIsPinned } from "./app-panel-model";
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
