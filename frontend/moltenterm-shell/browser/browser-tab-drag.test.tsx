// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BrowserState } from "./browser-model";
import {
    dropOnTab,
    dropSide,
    overTab,
    startTabDrag,
    TabDragEvent,
    TabDragType,
    tabDropIndex,
    TabDropIndicator,
} from "./browser-tab-drag";

const state: BrowserState = {
    tabs: [
        { id: "a", url: "https://a.test/" },
        { id: "b", url: "https://b.test/" },
        { id: "c", url: "https://c.test/" },
    ],
    activeId: "a",
};

function dragEvent(clientX = 0, left = 0, width = 100): TabDragEvent & { data: Record<string, string> } {
    const data: Record<string, string> = {};
    return {
        data,
        clientX,
        currentTarget: { getBoundingClientRect: () => ({ left, width }) },
        dataTransfer: {
            effectAllowed: "uninitialized",
            dropEffect: "none",
            setData: (type, value) => {
                data[type] = value;
            },
            getData: (type) => data[type] ?? "",
        },
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    };
}

const ids = (s: BrowserState) => s.tabs.map((t) => t.id).join("");

describe("tab drag (#388)", () => {
    it("starts a move drag that carries data and never reaches the block drag backend", () => {
        const e = dragEvent();
        startTabDrag(e, "b");
        expect(e.data[TabDragType]).toBe("b");
        expect(e.dataTransfer.effectAllowed).toBe("move");
        expect(e.stopPropagation).toHaveBeenCalled();
    });

    it("reads the drop side from the pointer position over the tab", () => {
        expect(dropSide(100, 80, 120)).toBe(false);
        expect(dropSide(100, 80, 160)).toBe(true);
    });

    it("maps a drop before or after a tab to the index moveTab takes", () => {
        expect(tabDropIndex(state.tabs, "a", { overId: "c", after: true })).toBe(2);
        expect(tabDropIndex(state.tabs, "a", { overId: "c", after: false })).toBe(1);
        expect(tabDropIndex(state.tabs, "c", { overId: "a", after: false })).toBe(0);
        expect(tabDropIndex(state.tabs, "c", { overId: "a", after: true })).toBe(1);
    });

    it("has no drop index where the tab would not move", () => {
        expect(tabDropIndex(state.tabs, "b", { overId: "b", after: true })).toBeNull();
        expect(tabDropIndex(state.tabs, "b", { overId: "a", after: true })).toBeNull();
        expect(tabDropIndex(state.tabs, "b", { overId: "c", after: false })).toBeNull();
        expect(tabDropIndex(state.tabs, "x", { overId: "a", after: false })).toBeNull();
    });

    it("accepts a tab of the strip over a tab, and ignores any other drag", () => {
        const over = dragEvent(90, 0, 100);
        expect(overTab(over, "a", "b")).toEqual({ overId: "b", after: true });
        expect(over.preventDefault).toHaveBeenCalled();
        expect(over.stopPropagation).toHaveBeenCalled();
        expect(over.dataTransfer.dropEffect).toBe("move");

        const foreign = dragEvent();
        expect(overTab(foreign, null, "b")).toBeNull();
        expect(foreign.preventDefault).not.toHaveBeenCalled();
    });

    it("drops the dragged tab where the indicator showed it, keeping the active tab", () => {
        const e = dragEvent(90, 0, 100);
        const target = overTab(e, "a", "c");
        const next = dropOnTab(e, state, "a", target);
        expect(ids(next)).toBe("bca");
        expect(next.activeId).toBe("a");

        const left = dragEvent(10, 0, 100);
        expect(ids(dropOnTab(left, state, "c", overTab(left, "c", "a")))).toBe("cab");
    });

    it("leaves the order alone for a drop that moves nothing or a drag from elsewhere", () => {
        const e = dragEvent(10, 0, 100);
        expect(dropOnTab(e, state, "b", overTab(e, "b", "c"))).toBe(state);
        expect(dropOnTab(dragEvent(), state, null, null)).toBe(state);
    });

    it("draws the drop indicator on the side of the hovered tab", () => {
        expect(renderToStaticMarkup(<TabDropIndicator after={true} />)).toContain('data-dropindicator="after"');
        expect(renderToStaticMarkup(<TabDropIndicator after={false} />)).toContain('data-dropindicator="before"');
    });
});
