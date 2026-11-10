// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The pinned tiles follow the sidebar's width (FR-SHELL-079, #2173): narrow, the icon above the name, up to three a
// row; from PinnedRowMinWidth of room, a row of its own with the icon on the left and the name on the right. The
// switch is the stylesheet's container query, so these tests read the stylesheet and the markup that feed it, and the
// drop side that follows the shape; the computed layout at two widths is checked in a running instance.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zoneAt } from "./sidebar-drag";
import {
    PinnedRowMinWidth,
    SidebarDefaultWidth,
    SidebarMaxWidth,
    SidebarMinWidth,
    TileGridColumns,
} from "./sidebar-model";
import { blockStacks, dropsBelow } from "./view-menu-model";

const css = fs.readFileSync(path.join(__dirname, "sidebar.css"), "utf8");
const src = fs.readFileSync(path.join(__dirname, "workspace-sidebar.tsx"), "utf8");
const ghost = fs.readFileSync(path.join(__dirname, "sidebar-ghost.tsx"), "utf8");

// The sidebar's width less the frame's gap on its left (8 px) and the tiles' area padding (4 px a side).
const RoomLost = 16;

function functionSource(text: string, name: string): string {
    const start = text.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    return text.slice(start, text.indexOf("\n}\n", start));
}

function containerBlock(): string {
    const start = css.indexOf("@container mtpins");
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("\n}\n", start) + 2);
}

function rule(block: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = block.match(new RegExp(`(^|\\n)\\s*${escaped}\\s*{([^}]*)}`));
    expect(match, selector).not.toBeNull();
    return match[2];
}

describe("the room a tile needs to become a row", () => {
    it("is the width the stylesheet's container query switches at", () => {
        expect(css).toContain(`@container mtpins (min-width: ${PinnedRowMinWidth}px)`);
        expect(css).toMatch(/\.mt-sb-tiles\s*{[^}]*container:\s*mtpins \/ inline-size;/);
    });

    it("is reached by dragging the sidebar, and the default width keeps the tiles", () => {
        expect(SidebarMinWidth - RoomLost).toBeLessThan(PinnedRowMinWidth);
        expect(SidebarDefaultWidth - RoomLost).toBeLessThan(PinnedRowMinWidth);
        expect(SidebarMaxWidth - RoomLost).toBeGreaterThanOrEqual(PinnedRowMinWidth);
    });

    it("leaves the tile grid's rule for the narrow shape as it was", () => {
        expect(TileGridColumns).toBe("repeat(auto-fill, minmax(max(74px, calc((100% - 12px) / 3)), 1fr))");
        expect(css).toMatch(/\.mt-sb-tilegrid\s*{[^}]*grid-template-columns:\s*var\(--mt-tile-cols\);/);
    });
});

describe("the markup that carries the shape", () => {
    it("makes the zone the container and its child the grid, since a container cannot restyle itself", () => {
        const grid = functionSource(src, "TileGrid");
        expect(grid).toMatch(/"mt-sb-zone mt-sb-tiles /);
        expect(grid).toContain('"--mt-tile-cols": TileGridColumns');
        expect(grid).toContain("mt-sb-tilegrid");
        // An inline column rule would beat the query.
        expect(grid).not.toContain("gridTemplateColumns");
    });

    it("keeps the active underline, the corner's marks and the glyph on the tile, whatever the shape", () => {
        const tile = functionSource(src, "Tile");
        expect(tile).toContain('className="mt-sb-tile-place"');
        expect(tile).toContain('className="mt-sb-corner"');
        expect(tile).toContain("<TileAgentMark");
        expect(tile).toContain("<PrDots");
        expect(tile).toContain('className="mt-sb-modpip"');
        expect(tile).toContain("<ViewGlyph");
        expect(tile).toContain("mt-sb-tile-name");
    });

    it("gives the neighbour's likeness the same container, so it matches the sidebar it stands for", () => {
        expect(ghost).toContain("mt-sb-tiles");
        expect(ghost).toContain('"--mt-tile-cols": TileGridColumns');
        expect(ghost).not.toContain("gridTemplateColumns");
        expect(ghost).toContain("mt-sb-tile-name");
    });
});

describe("a tile as a row", () => {
    const block = containerBlock();

    it("is one column of full-width tiles, 36 px high, icon left, name right, as the temporary views' rows", () => {
        expect(rule(block, ".mt-sb-tilegrid")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
        const tile = rule(block, ".mt-sb-tile");
        expect(tile).toMatch(/height:\s*36px/);
        expect(tile).toMatch(/flex-direction:\s*row/);
        expect(tile).toMatch(/justify-content:\s*flex-start/);
        expect(tile).toMatch(/gap:\s*8px/);
        expect(tile).toMatch(/padding:\s*0 8px/);
        expect(tile).toMatch(/font-size:\s*var\(--mt-text-12\)/);
        const name = rule(block, ".mt-sb-tile .mt-sb-tile-name");
        expect(name).toMatch(/flex:\s*1 1 0/);
        expect(name).toMatch(/min-width:\s*0/);
    });

    it("turns the corner's column into a line at the row's end, in the flow, so the name never runs under it", () => {
        const corner = rule(block, ".mt-sb-tile .mt-sb-corner");
        expect(corner).toMatch(/position:\s*static/);
        expect(corner).toMatch(/flex-direction:\s*row/);
        expect(rule(block, ".mt-sb-tile .mt-sb-prdots")).toMatch(/flex-direction:\s*row/);
    });

    it("keeps the revert button inside the row, centred on its height", () => {
        const revert = rule(block, ".mt-sb-tile .mt-sb-revert");
        expect(revert).toMatch(/top:\s*50%/);
        expect(revert).toMatch(/bottom:\s*auto/);
        expect(revert).toMatch(/translateY\(-50%\)/);
    });

    it("shows a drop above or below the tile, not on its side", () => {
        expect(rule(block, ".mt-sb-tile.mt-sb-dropb")).toMatch(
            /box-shadow:\s*0 -3px 0 0 var\(--color-accent\) !important/
        );
        expect(rule(block, ".mt-sb-tile.mt-sb-dropa")).toMatch(
            /box-shadow:\s*0 3px 0 0 var\(--color-accent\) !important/
        );
    });

    it("does not hide the underline, the glyph or the corner", () => {
        expect(block).not.toMatch(/mt-sb-tile-place|sidebar-glyph|mt-sb-glyph|display:\s*none/);
    });
});

describe("the side of a drop between stacked tiles", () => {
    it("knows tiles that fill their area's width from tiles side by side", () => {
        expect(blockStacks({ width: 244 }, { width: 244 })).toBe(true);
        expect(blockStacks({ width: 230 }, { width: 244 })).toBe(true);
        expect(blockStacks({ width: 81 }, { width: 244 })).toBe(false);
        expect(blockStacks({ width: 81 }, { width: 0 })).toBe(false);
    });

    it("lands below the target past its middle", () => {
        expect(dropsBelow(51, { top: 10, height: 80 })).toBe(true);
        expect(dropsBelow(49, { top: 10, height: 80 })).toBe(false);
    });
});

describe("zoneAt on the tiles", () => {
    type Box = { left: number; top: number; width: number; height: number };

    function fakeTree(grid: Box, tile: Box, zone: string) {
        const rectOf = (b: Box) => () => ({ ...b, right: b.left + b.width, bottom: b.top + b.height });
        const zoneEl: any = { getAttribute: (n: string) => (n === "data-sb-zone" ? zone : null) };
        const gridEl: any = { getBoundingClientRect: rectOf(grid), parentElement: zoneEl };
        const tileEl: any = {
            getAttribute: (n: string) => (n === "data-sb-key" ? "tile-a" : null),
            getBoundingClientRect: rectOf(tile),
            parentElement: gridEl,
            closest: (sel: string) =>
                sel.includes("data-sb-key") ? tileEl : sel.includes("data-sb-zone") ? zoneEl : null,
        };
        zoneEl.contains = (el: any) => el === tileEl || el === gridEl;
        zoneEl.getBoundingClientRect = rectOf(grid);
        return tileEl;
    }

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function hit(grid: Box, tile: Box, x: number, y: number, zone = "tiles") {
        const el = fakeTree(grid, tile, zone);
        vi.stubGlobal("document", { elementFromPoint: () => el });
        return zoneAt(x, y);
    }

    it("reads the pointer's height when a tile fills the row (the wide shape)", () => {
        const grid = { left: 0, top: 0, width: 300, height: 120 };
        const tile = { left: 0, top: 40, width: 300, height: 36 };
        expect(hit(grid, tile, 20, 70)).toEqual({ zone: "tiles", key: "tile-a", after: true });
        expect(hit(grid, tile, 290, 45)).toEqual({ zone: "tiles", key: "tile-a", after: false });
    });

    it("reads the pointer's x when tiles stand side by side (the narrow shape)", () => {
        const grid = { left: 0, top: 0, width: 300, height: 120 };
        const tile = { left: 0, top: 0, width: 90, height: 52 };
        expect(hit(grid, tile, 80, 5)).toEqual({ zone: "tiles", key: "tile-a", after: true });
        expect(hit(grid, tile, 10, 50)).toEqual({ zone: "tiles", key: "tile-a", after: false });
    });

    it("keeps the top row's blocks on their x, even when one fills the line", () => {
        const grid = { left: 0, top: 0, width: 300, height: 44 };
        const tile = { left: 0, top: 0, width: 300, height: 44 };
        expect(hit(grid, tile, 250, 2, "top")).toEqual({ zone: "top", key: "tile-a", after: true });
        expect(hit(grid, tile, 10, 40, "top")).toEqual({ zone: "top", key: "tile-a", after: false });
    });
});
