// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
    contentBoxFor,
    layoutKey,
    LayoutStorage,
    measureLayout,
    overlapArea,
    parseLayout,
    readLayout,
    sameLayout,
    scaleLayout,
    staleLayoutKeys,
    writeLayout,
} from "./layout-memory";

// A storage that outlives the app: what one run writes, the next one reads.
function diskStorage(): LayoutStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
        data,
        getItem: (k) => data.get(k) ?? null,
        setItem: (k, v) => void data.set(k, String(v)),
        removeItem: (k) => void data.delete(k),
    };
}

// A synthetic workspace: a sidebar of 260 px and a frame margin of 8 px, a terminal on the left half, a browser and a
// panel stacked on the right, in a 1600 x 1000 window.
const Window = { width: 1600, height: 1000 };
const Content = { left: 268, top: 8, width: 1324, height: 984 };
const Blocks = [
    { id: "term-1", kind: "term", rect: { left: 268, top: 8, width: 662, height: 984 } },
    { id: "web-1", kind: "web", rect: { left: 930, top: 8, width: 662, height: 492 } },
    { id: "panel-1", kind: "preview", rect: { left: 930, top: 500, width: 662, height: 492 } },
];

describe("the remembered layout of a workspace (FR-SHELL-082, #2407)", () => {
    it("keeps each panel's kind, its order and its place as shares of the content area", () => {
        const layout = measureLayout("ws-alpha", "tab-1", Content, Window, Blocks, 1);
        expect(layout.panels.map((p) => [p.id, p.kind])).toEqual([
            ["term-1", "term"],
            ["web-1", "web"],
            ["panel-1", "preview"],
        ]);
        expect(layout.panels[0]).toMatchObject({ x: 0, y: 0, w: 0.5, h: 1 });
        expect(layout.panels[1]).toMatchObject({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
        expect(layout.insets).toEqual({ left: 268, top: 8, right: 8, bottom: 8 });
    });

    it("leaves out a panel outside the content area and clips one that runs past it", () => {
        const layout = measureLayout(
            "ws-alpha",
            "tab-1",
            Content,
            Window,
            [
                { id: "off", kind: "term", rect: { left: -15000, top: 8, width: 600, height: 600 } },
                { id: "wide", kind: "term", rect: { left: 268, top: 8, width: 5000, height: 984 } },
            ],
            1
        );
        expect(layout.panels.map((p) => p.id)).toEqual(["wide"]);
        expect(layout.panels[0].w).toBe(1);
    });

    it("is read back from this run's copy and drawn proportionally in a smaller window, never at its old pixel sizes", () => {
        const disk = diskStorage();
        writeLayout(measureLayout("ws-alpha", "tab-1", Content, Window, Blocks, 1), disk);
        const read = readLayout("ws-alpha", disk);
        expect(read).not.toBeNull();
        expect(read.panels).toHaveLength(3);
        const small = { width: 1000, height: 700 };
        const box = contentBoxFor(read, small);
        expect(box).toEqual({ left: 268, top: 8, width: 724, height: 684 });
        const frames = scaleLayout(read, box);
        expect(frames[0].rect).toEqual({ left: 268, top: 8, width: 362, height: 684 });
        expect(frames[1].rect).toEqual({ left: 630, top: 8, width: 362, height: 342 });
        expect(frames[2].rect).toEqual({ left: 630, top: 350, width: 362, height: 342 });
        // Every frame stays inside the window, and none covers another.
        for (const f of frames) {
            expect(f.rect.left + f.rect.width).toBeLessThanOrEqual(small.width);
            expect(f.rect.top + f.rect.height).toBeLessThanOrEqual(small.height);
        }
        for (let i = 0; i < frames.length; i++) {
            for (let j = i + 1; j < frames.length; j++) {
                expect(overlapArea(frames[i].rect, frames[j].rect)).toBe(0);
            }
        }
    });

    it("reads nothing of another workspace, nor anything broken", () => {
        const disk = diskStorage();
        disk.setItem(layoutKey("ws-beta"), JSON.stringify({ workspaceId: "ws-alpha", panels: [] }));
        expect(readLayout("ws-beta", disk)).toBeNull();
        expect(parseLayout("{")).toBeNull();
        expect(parseLayout(JSON.stringify({ workspaceId: "w", panels: [{ id: "a", x: 0, y: 0, w: 0, h: 1 }] })).panels).toEqual(
            []
        );
    });

    it("tells an unchanged layout, so the view writes only when something moved", () => {
        const a = measureLayout("ws-alpha", "tab-1", Content, Window, Blocks, 1);
        const b = measureLayout("ws-alpha", "tab-1", Content, Window, Blocks, 2);
        expect(sameLayout(a, b)).toBe(true);
        const moved = [{ ...Blocks[0], rect: { ...Blocks[0].rect, width: 500 } }, ...Blocks.slice(1)];
        expect(sameLayout(a, measureLayout("ws-alpha", "tab-1", Content, Window, moved, 3))).toBe(false);
    });

    it("drops the layouts of workspaces that are gone", () => {
        const keys = [layoutKey("a"), layoutKey("b"), "moltenterm:other"];
        expect(staleLayoutKeys(keys, ["a"])).toEqual([layoutKey("b")]);
    });

    it("measures overlap only where two rectangles share area, never where they touch", () => {
        const left = { left: 0, top: 0, width: 240, height: 600 };
        expect(overlapArea(left, { left: 240, top: 0, width: 240, height: 600 })).toBe(0);
        expect(overlapArea(left, { left: 230, top: 0, width: 240, height: 600 })).toBe(6000);
    });
});
