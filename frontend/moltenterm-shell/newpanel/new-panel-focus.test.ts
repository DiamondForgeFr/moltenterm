// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
    layoutFocused: "layout" as string,
    blocks: {} as Record<string, { meta: Record<string, unknown> }>,
}));

vi.mock("@/app/store/global", () => ({
    getFocusedBlockId: () => h.layoutFocused,
    globalStore: { get: (a: { id: string }) => h.blocks[a.id] },
    WOS: {
        getWaveObjectAtom: (oref: string) => ({ id: oref.replace("block:", "") }),
        makeORef: (type: string, id: string) => `${type}:${id}`,
    },
}));

import {
    currentFocusedBlockId,
    currentFocusedView,
    placementFallbackBlockId,
    runWithKeyOrigin,
} from "./new-panel-focus";

type Fake = { closest: (selector: string) => { getAttribute: (name: string) => string } | object | null };

// An element the way the window finds the focus: inside a panel, inside the sidebar, or nowhere.
function element(where: { block?: string; sidebar?: boolean }): Fake {
    return {
        closest: (selector: string) => {
            if (selector.includes("workspace-sidebar")) {
                return where.sidebar ? {} : null;
            }
            if (selector.includes("data-blockid")) {
                return where.block ? { getAttribute: () => where.block } : null;
            }
            return null;
        },
    };
}

function focus(where: { block?: string; sidebar?: boolean }) {
    vi.stubGlobal("document", { activeElement: element(where) });
}

beforeEach(() => {
    h.layoutFocused = "layout";
    h.blocks = {
        term: { meta: { view: "term" } },
        page: { meta: { view: "molten-browser" } },
        layout: { meta: { view: "preview" } },
    };
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("where the focus is when ⌘T is pressed (#1742)", () => {
    it("is the panel holding the keyboard focus, whatever the layout believes", () => {
        focus({ block: "term" });
        expect(currentFocusedBlockId()).toBe("term");
        expect(currentFocusedView()).toBe("term");
    });

    it("is the layout's focused panel when the keyboard focus is in no panel", () => {
        focus({});
        expect(currentFocusedBlockId()).toBe("layout");
        expect(currentFocusedView()).toBe("preview");
    });

    it("is no panel with the keyboard focus on the sidebar", () => {
        focus({ sidebar: true });
        expect(currentFocusedBlockId()).toBeNull();
        expect(currentFocusedView()).toBeNull();
    });

    it("is no panel when none is focused at all", () => {
        h.layoutFocused = null;
        focus({});
        expect(currentFocusedBlockId()).toBeNull();
        expect(currentFocusedView()).toBeNull();
    });

    it("is the panel of the page a key came from, even with the keyboard focus elsewhere", () => {
        focus({ block: "term" });
        const seen = runWithKeyOrigin("page", () => [currentFocusedBlockId(), currentFocusedView()]);
        expect(seen).toEqual(["page", "molten-browser"]);
        expect(currentFocusedBlockId()).toBe("term");
    });

    it("forgets the page after its key, also when the key's handler throws", () => {
        focus({ block: "term" });
        expect(() =>
            runWithKeyOrigin("page", () => {
                throw new Error("handler failed");
            })
        ).toThrow("handler failed");
        expect(currentFocusedBlockId()).toBe("term");
        expect(runWithKeyOrigin(null, () => currentFocusedBlockId())).toBe("term");
    });

    it("keeps an outer page while an inner key runs without one", () => {
        focus({});
        runWithKeyOrigin("page", () => {
            runWithKeyOrigin(null, () => expect(currentFocusedBlockId()).toBe("layout"));
            expect(currentFocusedBlockId()).toBe("page");
        });
    });
});

describe("where the new panel goes when the pointer is over none", () => {
    it("is beside the page's panel for a page's key, else beside the layout's focused panel", () => {
        focus({ sidebar: true });
        expect(placementFallbackBlockId()).toBe("layout");
        expect(runWithKeyOrigin("page", () => placementFallbackBlockId())).toBe("page");
    });
});
