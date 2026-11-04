// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The field takes the keyboard focus, so it remembers the panel that had the focus when it opened (FR-SHELL-083,
// #1743): Enter goes to that page, whatever the layout focuses meanwhile.

import { globalStore } from "@/app/store/jotaiStore";
import * as layout from "@/layout/index";
import { atom, PrimitiveAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarModel } from "./sidebar-store";
import { openTopField, TopFieldModel } from "./top-field-store";

function nodeOf(blockId: string) {
    return blockId == null ? null : { data: { blockId } };
}

let focused: PrimitiveAtom<{ data: { blockId: string } }>;

beforeEach(() => {
    focused = atom(nodeOf("page1"));
    vi.spyOn(layout, "getLayoutModelForStaticTab").mockReturnValue({ focusedNode: focused } as never);
    const sidebar = SidebarModel.getInstance();
    vi.spyOn(sidebar, "isEnabled").mockReturnValue(true);
    vi.spyOn(sidebar, "isHidden").mockReturnValue(false);
});

afterEach(() => {
    TopFieldModel.getInstance().close();
    vi.restoreAllMocks();
});

const originOf = () => globalStore.get(TopFieldModel.getInstance().originAtom);

describe("the panel the top field works on", () => {
    it("is the panel focused when the field opens", () => {
        expect(openTopField()).toBe(true);
        expect(originOf()).toBe("page1");
    });

    it("stays that panel when the focus moves while the field is open", () => {
        openTopField();
        globalStore.set(focused, nodeOf("term1"));
        expect(originOf()).toBe("page1");
        openTopField();
        expect(originOf()).toBe("page1");
    });

    it("is the panel that asks for the field, when it focuses itself in the same breath", () => {
        globalStore.set(focused, nodeOf("term1"));
        openTopField("page2");
        expect(originOf()).toBe("page2");
    });

    it("is forgotten when the field closes, and read again at the next opening", () => {
        openTopField();
        TopFieldModel.getInstance().close();
        expect(originOf()).toBeNull();
        globalStore.set(focused, nodeOf("term1"));
        openTopField();
        expect(originOf()).toBe("term1");
    });

    it("is nothing when no panel has the focus", () => {
        globalStore.set(focused, nodeOf(null));
        openTopField();
        expect(originOf()).toBeNull();
    });

    it("does not exist while the sidebar is off", () => {
        vi.spyOn(SidebarModel.getInstance(), "isEnabled").mockReturnValue(false);
        expect(openTopField()).toBe(false);
        expect(originOf()).toBeNull();
    });
});
