// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The drop of a panel on the sidebar (FR-SHELL-080, #2548), and what it leaves alone: a drag between panels is the
// layout's, exactly as before.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/util/fetchutil", () => ({ fetch: () => new Promise(() => {}) }));

import type { LayoutNode } from "@/layout/lib/types";
import { blockIdOf, canDropOnSidebar, dropOnSidebar, TileItemType } from "./panel-view-drop";
import { PanelHit, PanelViewDestination } from "./panel-view-model";

const panel = { id: "node-1", data: { blockId: "block-1" } } as unknown as LayoutNode;
const noBlock = { id: "node-2" } as unknown as LayoutNode;

// A sidebar whose top row is at the top left and whose tiles are under it; the panels are everywhere else.
function hitAt(x: number, y: number): PanelHit {
    if (x < 260 && y < 40) {
        return { zone: "top", key: "g1", after: false, before: "g1" };
    }
    if (x < 260 && y < 100) {
        return { zone: "tiles", key: null, before: null };
    }
    return null;
}

function destination(hit: PanelHit): PanelViewDestination {
    if (hit == null) {
        return null;
    }
    return hit.zone === "top" ? { kind: "pinned", before: hit.before } : { kind: "workspace" };
}

describe("a panel released on the sidebar", () => {
    it("makes a view from that panel where it was released", () => {
        const make = vi.fn();
        expect(dropOnSidebar(panel, { x: 100, y: 20 }, make, hitAt, destination)).toBe(true);
        expect(make).toHaveBeenCalledWith("block-1", { kind: "pinned", before: "g1" });
        expect(dropOnSidebar(panel, { x: 100, y: 70 }, make, hitAt, destination)).toBe(true);
        expect(make).toHaveBeenLastCalledWith("block-1", { kind: "workspace" });
    });

    it("is refused away from every zone: nothing is made, the panel stays", () => {
        const make = vi.fn();
        expect(dropOnSidebar(panel, { x: 100, y: 500 }, make, hitAt, destination)).toBe(false);
        expect(canDropOnSidebar(panel, { x: 100, y: 500 }, hitAt, destination)).toBe(false);
        expect(make).not.toHaveBeenCalled();
    });

    it("is refused over the panels, where a drag between panels is the layout's", () => {
        const make = vi.fn();
        expect(dropOnSidebar(panel, { x: 700, y: 20 }, make, hitAt, destination)).toBe(false);
        expect(canDropOnSidebar(panel, { x: 700, y: 20 }, hitAt, destination)).toBe(false);
        expect(make).not.toHaveBeenCalled();
    });

    it("is refused without a panel to copy or without a place", () => {
        const make = vi.fn();
        expect(dropOnSidebar(noBlock, { x: 100, y: 20 }, make, hitAt, destination)).toBe(false);
        expect(dropOnSidebar(panel, null, make, hitAt, destination)).toBe(false);
        expect(canDropOnSidebar(noBlock, { x: 100, y: 20 }, hitAt, destination)).toBe(false);
        expect(canDropOnSidebar(panel, null, hitAt, destination)).toBe(false);
        expect(make).not.toHaveBeenCalled();
    });

    it("reads the panel's block from the layout's node", () => {
        expect(blockIdOf(panel)).toBe("block-1");
        expect(blockIdOf(noBlock)).toBeNull();
        expect(blockIdOf(null)).toBeNull();
    });
});

describe("a drag between panels", () => {
    const layout = fs.readFileSync(path.join(__dirname, "../../layout/lib/TileLayout.tsx"), "utf8");

    it("is the layout's own: its drop is still taken by the panels' overlay, on the zones as drawn", () => {
        expect(layout).toContain("dropPanelAt(layoutModel, monitor.getItem<LayoutNode>(), at?.x, at?.y)");
        expect(layout).toContain("monitor.isOver({ shallow: true })");
        expect(layout).toContain('const tileItemType = "TILE_ITEM"');
    });

    it("knows nothing of the sidebar's drop, which drags the same item and takes it elsewhere", () => {
        expect(layout).not.toMatch(/panel-view|sidebar/i);
        expect(TileItemType).toBe("TILE_ITEM");
    });

    it("is not taken by the sidebar's drop, which accepts the item only on the sidebar", () => {
        const drop = fs.readFileSync(path.join(__dirname, "panel-view-drop.tsx"), "utf8");
        expect(drop).toContain("drop(asideRef)");
        expect(drop).not.toContain("document.addEventListener");
    });
});
