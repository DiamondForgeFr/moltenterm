// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A view's icon says what its screen shows (FR-SHELL-081, #1823), end to end from the tab's meta and its blocks: a grid
// view keeps a mark per panel, a view drawn in 360 view has its fixed panel and one cube whose front face follows the
// carpet; the icon menu previews it.

import { initGlobalAtoms } from "@/app/store/global-atoms";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { panelIcon } from "../tab-identity";
import { ScreenMetaKey } from "../view360/screen-glyph";
import { screenGlyphAtom, viewGlyphAtom } from "./view-glyph";
import { isGlyphCube, ViewIconMetaKey, type GlyphCube } from "./view-menu-model";
import { openViewPopover, ViewPopoverHost } from "./view-popover";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

beforeAll(() => {
    initGlobalAtoms({ tabId: "tab-a", windowId: "win-a", clientId: "c", platform: "darwin" } as any);
});

const Panels: Record<string, Record<string, any>> = {
    "blk-term": { view: "term", controller: "shell" },
    "blk-files": { view: "preview", file: "/tmp" },
    "blk-page": { view: "molten-browser" },
};

function seed(tabId: string, meta: Record<string, any>) {
    for (const [id, blockMeta] of Object.entries(Panels)) {
        globalStore.get(WOS.getWaveObjectAtom(WOS.makeORef("block", id)));
        WOS.setObjectValue({ otype: "block", oid: id, version: 1, meta: blockMeta } as any);
    }
    globalStore.get(WOS.getWaveObjectAtom(WOS.makeORef("tab", tabId)));
    WOS.setObjectValue({ otype: "tab", oid: tabId, version: 1, blockids: Object.keys(Panels), meta } as any);
}

const Screen = (front: string) => ({ fixed: ["blk-term"], carpet: ["blk-files", "blk-page"], front });
const iconOf = (id: string) => panelIcon(Panels[id]);

describe("the icon of a view in the sidebar (#1823)", () => {
    it("keeps a grid view as it was: one icon per panel, no cube", () => {
        seed("tab-grid", {});
        expect(globalStore.get(viewGlyphAtom("tab-grid"))).toEqual(Object.keys(Panels).map(iconOf));
    });

    it("draws a 360 view as the fixed panel's icon then one cube showing the page in front", () => {
        seed("tab-360", { [ScreenMetaKey]: Screen("blk-page") });
        const glyph = globalStore.get(viewGlyphAtom("tab-360"));
        expect(glyph).toHaveLength(2);
        expect(glyph[0]).toBe(iconOf("blk-term"));
        expect(glyph[1]).toEqual({ cube: true, id: "blk-page", icon: iconOf("blk-page"), index: 1, count: 2 });
    });

    it("turns the cube to the files when the carpet scrolls to them, and back", () => {
        seed("tab-turn", { [ScreenMetaKey]: Screen("blk-page") });
        expect((globalStore.get(viewGlyphAtom("tab-turn"))[1] as GlyphCube).id).toBe("blk-page");
        seed("tab-turn", { [ScreenMetaKey]: Screen("blk-files") });
        expect(globalStore.get(viewGlyphAtom("tab-turn"))[1]).toMatchObject({
            id: "blk-files",
            icon: iconOf("blk-files"),
            index: 0,
        });
        seed("tab-turn", { [ScreenMetaKey]: Screen("blk-page") });
        expect((globalStore.get(viewGlyphAtom("tab-turn"))[1] as GlyphCube).id).toBe("blk-page");
    });

    it("goes back to a mark per panel as soon as the tab publishes no 360 screen", () => {
        seed("tab-back", { [ScreenMetaKey]: Screen("blk-page") });
        expect(globalStore.get(viewGlyphAtom("tab-back")).some(isGlyphCube)).toBe(true);
        seed("tab-back", {});
        expect(globalStore.get(viewGlyphAtom("tab-back")).some(isGlyphCube)).toBe(false);
    });

    it("shows a chosen icon alone, and keeps the screen's marks for the icon menu to preview", () => {
        seed("tab-chosen", { [ScreenMetaKey]: Screen("blk-page"), [ViewIconMetaKey]: "rocket" });
        expect(globalStore.get(viewGlyphAtom("tab-chosen"))).toEqual(["rocket"]);
        const preview = globalStore.get(screenGlyphAtom("tab-chosen"));
        expect(preview).toHaveLength(2);
        expect(isGlyphCube(preview[1])).toBe(true);
    });

    it('previews the cube on the icon menu\'s "What the view shows" button', () => {
        seed("tab-menu", { [ScreenMetaKey]: Screen("blk-files"), [ViewIconMetaKey]: "rocket" });
        openViewPopover({ kind: "icon", ref: { tabId: "tab-menu" }, name: "Strategy", icon: "rocket", x: 0, y: 0 });
        const html = renderToStaticMarkup(
            <Provider store={globalStore}>
                <ViewPopoverHost />
            </Provider>
        );
        const button = html.slice(html.indexOf('data-testid="sidebar-icon-panels"'));
        expect(button).toContain('data-testid="view-cube"');
        expect(button).toContain(`data-front="blk-files"`);
        expect(button).toContain("What the view shows");
    });
});
