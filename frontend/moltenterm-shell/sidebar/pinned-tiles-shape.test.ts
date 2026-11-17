// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The pinned tiles always fill their rows (FR-SHELL-079, #2173, #2184): as many columns as fit at PinnedTileMinWidth,
// never more than there are tiles, equal shares, a short last row stretched; each tile's shape follows its own width
// (icon left and name right from PinnedRowMinWidth). The layout is the stylesheet's wrapping flex row and container
// query, so these tests check the model that states the rule, the stylesheet and markup that carry it, and the drop
// side that follows the shape; the computed layout at several widths is checked in a running instance.

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zoneAt } from "./sidebar-drag";
import {
    pinnedColumns,
    PinnedRowMinWidth,
    PinnedTileMinWidth,
    pinnedTileShape,
    pinnedTileWidths,
    SidebarDefaultWidth,
    SidebarMaxWidth,
    SidebarMinWidth,
    TileGap,
} from "./sidebar-model";
import { blockStacks, dropsBelow } from "./view-menu-model";

const css = fs.readFileSync(path.join(__dirname, "sidebar.css"), "utf8");
const src = fs.readFileSync(path.join(__dirname, "workspace-sidebar.tsx"), "utf8");
const ghost = fs.readFileSync(path.join(__dirname, "sidebar-ghost.tsx"), "utf8");

// The sidebar's width less the frame's gap on its left (8 px) and the tiles' area padding (4 px a side).
const RoomLost = 16;

const room = (sidebar: number) => sidebar - RoomLost;

// The tiles' widths split into rows of the given number of columns.
function rows(widths: number[], cols: number): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < widths.length; i += cols) {
        out.push(widths.slice(i, i + cols));
    }
    return out;
}

function functionSource(text: string, name: string): string {
    const start = text.indexOf(`function ${name}(`);
    expect(start).toBeGreaterThanOrEqual(0);
    return text.slice(start, text.indexOf("\n}\n", start));
}

function containerBlock(): string {
    const start = css.indexOf("@container mttile");
    expect(start).toBeGreaterThanOrEqual(0);
    return css.slice(start, css.indexOf("\n}\n", start) + 2);
}

function rule(block: string, selector: string): string {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = block.match(new RegExp(`(^|\\n)\\s*${escaped}\\s*{([^}]*)}`));
    expect(match, selector).not.toBeNull();
    return match[2];
}

describe("the columns of the pinned tiles", () => {
    it("lays two tiles side by side across the whole row at the default width (AC-1)", () => {
        expect(pinnedColumns(room(SidebarDefaultWidth), 2)).toBe(2);
        const [a, b] = pinnedTileWidths(room(SidebarDefaultWidth), 2);
        expect(a).toBe(b);
        expect(a + b + TileGap).toBe(room(SidebarDefaultWidth));
    });

    it("adds columns only when there are more tiles than columns; two tiles stay two and stretch (AC-2)", () => {
        for (let sidebar = 240; sidebar <= SidebarMaxWidth; sidebar++) {
            expect(pinnedColumns(room(sidebar), 2)).toBe(2);
        }
        expect(pinnedColumns(room(SidebarMaxWidth), 5)).toBe(3);
        expect(pinnedColumns(room(SidebarMaxWidth), 2)).toBe(2);
        expect(pinnedColumns(room(SidebarMaxWidth), 1)).toBe(1);
        expect(pinnedColumns(room(340), 5)).toBe(2);
        expect(pinnedColumns(room(480), 5)).toBe(4);
    });

    it("gives one column of full-width rows, icon left, in a very narrow sidebar (AC-3)", () => {
        expect(pinnedColumns(room(SidebarMinWidth), 5)).toBe(1);
        expect(pinnedColumns(room(200), 2)).toBe(1);
        for (const w of pinnedTileWidths(room(SidebarMinWidth), 3)) {
            expect(w).toBe(room(SidebarMinWidth));
            expect(pinnedTileShape(w)).toBe("row");
        }
    });

    it("never leaves a hole at the end of a row, the last one included (AC-5)", () => {
        expect(pinnedTileWidths(room(SidebarDefaultWidth), 3)).toEqual([121, 121, 248]);
        for (let sidebar = 200; sidebar <= 480; sidebar++) {
            for (let count = 1; count <= 8; count++) {
                const cols = pinnedColumns(room(sidebar), count);
                expect(cols).toBeLessThanOrEqual(count);
                for (const row of rows(pinnedTileWidths(room(sidebar), count), cols)) {
                    const filled = row.reduce((sum, w) => sum + w, 0) + TileGap * (row.length - 1);
                    expect(filled).toBeCloseTo(room(sidebar), 6);
                    for (const w of row) {
                        expect(w).toBeGreaterThanOrEqual(Math.min(PinnedTileMinWidth, room(sidebar)));
                    }
                }
            }
        }
    });

    it("switches a tile's shape on its own width (AC-4)", () => {
        expect(pinnedTileShape(PinnedRowMinWidth - 1)).toBe("stack");
        expect(pinnedTileShape(PinnedRowMinWidth)).toBe("row");
        // Two tiles at the default width are stacked shapes; the third, alone on its row, is a row.
        const shapes = pinnedTileWidths(room(SidebarDefaultWidth), 3).map(pinnedTileShape);
        expect(shapes).toEqual(["stack", "stack", "row"]);
        // Two tiles in the widest sidebar are rows side by side.
        expect(pinnedTileWidths(room(SidebarMaxWidth), 2).map(pinnedTileShape)).toEqual(["row", "row"]);
    });
});

describe("the stylesheet that lays the tiles out", () => {
    it("wraps the tiles in a flex row with the model's gutter, no fixed tracks", () => {
        const grid = rule(css, ".mt-sb-tilegrid");
        expect(grid).toMatch(/display:\s*flex/);
        expect(grid).toMatch(/flex-wrap:\s*wrap/);
        expect(grid).toMatch(new RegExp(`gap:\\s*${TileGap}px`));
        expect(css).not.toMatch(/grid-template-columns:\s*var\(--mt-tile-cols\)/);
        expect(css).not.toContain("mtpins");
    });

    it("grows each cell from the readable minimum and makes it its tile's size container", () => {
        const cell = rule(css, ".mt-sb-tilecell");
        expect(cell).toMatch(new RegExp(`flex:\\s*1 1 ${PinnedTileMinWidth}px`));
        expect(cell).toMatch(/min-width:\s*0/);
        expect(cell).toMatch(/container:\s*mttile \/ inline-size/);
        expect(css).toContain(`@container mttile (min-width: ${PinnedRowMinWidth}px)`);
    });

    it("shows a stacked tile's drop above or below it, whatever its shape", () => {
        expect(rule(css, ".mt-sb-tile.mt-sb-dropy.mt-sb-dropb")).toMatch(
            /box-shadow:\s*0 -3px 0 0 var\(--color-accent\) !important/
        );
        expect(rule(css, ".mt-sb-tile.mt-sb-dropy.mt-sb-dropa")).toMatch(
            /box-shadow:\s*0 3px 0 0 var\(--color-accent\) !important/
        );
    });
});

describe("the markup that carries the shape", () => {
    it("puts each tile in its own cell, since a container cannot restyle itself", () => {
        const grid = functionSource(src, "TileGrid");
        expect(grid).toMatch(/"mt-sb-zone mt-sb-tiles /);
        expect(grid).toContain('className="mt-sb-tilegrid"');
        expect(grid).toMatch(/className="mt-sb-tilecell">\s*<Tile\s/);
        // An inline column rule or a grid would bring back fixed tracks.
        expect(grid).not.toContain("gridTemplateColumns");
        expect(grid).not.toContain("--mt-tile-cols");
    });

    it("marks a drop on a stacked tile so its bar shows above or below", () => {
        expect(functionSource(src, "dropSideClass")).toContain('drag.stacked && "mt-sb-dropy"');
    });

    it("keeps the selected liseré, the corner's marks and the glyph on the tile, whatever the shape", () => {
        const tile = functionSource(src, "Tile");
        expect(tile).toContain('active ? "mt-sb-selected bg-white/20"');
        expect(tile).not.toContain("mt-sb-tile-place");
        expect(tile).toContain('className="mt-sb-corner"');
        expect(tile).toContain("<TileAgentMark");
        expect(tile).toContain("<PrDots");
        expect(tile).toContain('className="mt-sb-modpip"');
        expect(tile).toContain("<ViewGlyph");
        expect(tile).toContain("mt-sb-tile-name");
        expect(tile).toContain('className="mt-sb-revert"');
    });

    it("gives the neighbour's likeness the same cells, so it matches the sidebar it stands for", () => {
        expect(ghost).toContain('className="mt-sb-tilegrid"');
        expect(ghost).toContain('className="mt-sb-tilecell"');
        expect(ghost).not.toContain("gridTemplateColumns");
        expect(ghost).not.toContain("--mt-tile-cols");
        expect(ghost).toContain("mt-sb-tile-name");
    });
});

describe("a tile as a row", () => {
    const block = containerBlock();

    it("is 36 px high, icon left, name right, as the temporary views' rows", () => {
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

    it("does not hide the selected liseré, the glyph or the corner", () => {
        expect(block).not.toMatch(/mt-sb-selected|box-shadow|sidebar-glyph|mt-sb-glyph|display:\s*none/);
    });
});

describe("the side of a drop between stacked tiles", () => {
    it("knows tiles that fill their area's width from tiles side by side", () => {
        expect(blockStacks({ width: 244 }, { width: 252 })).toBe(true);
        expect(blockStacks({ width: 230 }, { width: 244 })).toBe(true);
        expect(blockStacks({ width: 121 }, { width: 252 })).toBe(false);
        expect(blockStacks({ width: 81 }, { width: 0 })).toBe(false);
    });

    it("lands below the target past its middle", () => {
        expect(dropsBelow(51, { top: 10, height: 80 })).toBe(true);
        expect(dropsBelow(49, { top: 10, height: 80 })).toBe(false);
    });
});

describe("zoneAt on the tiles", () => {
    type Box = { left: number; top: number; width: number; height: number };

    // The tile sits in a cell as wide as itself, inside the grid, inside the zone (TileGrid).
    function fakeTree(area: Box, tile: Box, zone: string) {
        const rectOf = (b: Box) => () => ({ ...b, right: b.left + b.width, bottom: b.top + b.height });
        const zoneEl: any = { getAttribute: (n: string) => (n === "data-sb-zone" ? zone : null) };
        const gridEl: any = { getBoundingClientRect: rectOf(area), parentElement: zoneEl };
        const cellEl: any = { getBoundingClientRect: rectOf(tile), parentElement: gridEl };
        const tileEl: any = {
            getAttribute: (n: string) => (n === "data-sb-key" ? "tile-a" : null),
            getBoundingClientRect: rectOf(tile),
            parentElement: cellEl,
            closest: (sel: string) =>
                sel.includes("data-sb-key") ? tileEl : sel.includes("data-sb-zone") ? zoneEl : null,
        };
        zoneEl.contains = (el: any) => el === tileEl || el === cellEl || el === gridEl;
        zoneEl.getBoundingClientRect = rectOf(area);
        return tileEl;
    }

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    function hit(area: Box, tile: Box, x: number, y: number, zone = "tiles") {
        const el = fakeTree(area, tile, zone);
        vi.stubGlobal("document", { elementFromPoint: () => el });
        return zoneAt(x, y);
    }

    it("reads the pointer's height when a tile fills the row (alone on its row)", () => {
        const area = { left: 0, top: 0, width: 252, height: 120 };
        const tile = { left: 4, top: 64, width: 244, height: 36 };
        expect(hit(area, tile, 20, 90)).toEqual({ zone: "tiles", key: "tile-a", after: true, stacked: true });
        expect(hit(area, tile, 240, 66)).toEqual({ zone: "tiles", key: "tile-a", after: false, stacked: true });
    });

    it("reads the pointer's x when tiles stand side by side, though each fills its own cell", () => {
        const area = { left: 0, top: 0, width: 252, height: 120 };
        const tile = { left: 4, top: 0, width: 121, height: 52 };
        expect(hit(area, tile, 100, 5)).toEqual({ zone: "tiles", key: "tile-a", after: true, stacked: false });
        expect(hit(area, tile, 10, 50)).toEqual({ zone: "tiles", key: "tile-a", after: false, stacked: false });
    });

    it("keeps the top row's blocks on their x, even when one fills the line", () => {
        const area = { left: 0, top: 0, width: 300, height: 44 };
        const tile = { left: 0, top: 0, width: 300, height: 44 };
        expect(hit(area, tile, 250, 2, "top")).toEqual({ zone: "top", key: "tile-a", after: true, stacked: false });
        expect(hit(area, tile, 10, 40, "top")).toEqual({ zone: "top", key: "tile-a", after: false, stacked: false });
    });
});
