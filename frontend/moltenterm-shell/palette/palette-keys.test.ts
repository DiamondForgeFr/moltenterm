// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// ⌘⇧K opens the top field, the same field as ⌘L (FR-SHELL-113, AC-1); with the sidebar off it opens the palette dialog,
// so the palette never goes missing. Help › Command Palette runs the same key.

import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const menu = vi.hoisted(() => ({ listener: null as (command: string) => void }));
const refocus = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@/app/store/global", async () => {
    const { globalStore } = await import("@/app/store/jotaiStore");
    return {
        globalStore,
        getFocusedBlockId: () => "b1",
        refocusNode: (id: string) => refocus.calls.push(id),
        getApi: () => ({
            onMoltentermAppMenuCommand: (cb: (command: string) => void) => {
                menu.listener = cb;
            },
        }),
    };
});

vi.mock("../companion/companion-open", () => ({ registerCompanionKeys: () => {} }));
vi.mock("../view360/view360-pin", () => ({ registerPinKeys: () => {} }));

import { listenAppMenuCommands } from "../menu/app-menu-commands";
import { SidebarModel } from "../sidebar/sidebar-store";
import { TopFieldModel } from "../sidebar/top-field-store";
import { CommandPaletteKey, CommandPaletteModalName, toggleCommandPalette } from "./palette-keys";

function openModals(): string[] {
    return globalStore.get(modalsModel.modalsAtom).map((m) => m.displayName);
}

function fieldOpen(): boolean {
    return globalStore.get(TopFieldModel.getInstance().openAtom);
}

beforeEach(() => {
    globalStore.set(modalsModel.modalsAtom, []);
    TopFieldModel.getInstance().close();
    refocus.calls = [];
    vi.stubGlobal("document", { querySelector: () => null });
    vi.spyOn(SidebarModel.getInstance(), "isHidden").mockReturnValue(false);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("⌘⇧K (FR-SHELL-113)", () => {
    it("opens the top field with the sidebar on, and closes it when pressed again", () => {
        vi.spyOn(SidebarModel.getInstance(), "isEnabled").mockReturnValue(true);
        expect(toggleCommandPalette()).toBe(true);
        expect(fieldOpen()).toBe(true);
        expect(openModals()).toEqual([]);
        expect(toggleCommandPalette()).toBe(true);
        expect(fieldOpen()).toBe(false);
        expect(refocus.calls).toEqual(["b1"]);
    });

    it("hides a peeking sidebar again when it closes the field", () => {
        vi.spyOn(SidebarModel.getInstance(), "isEnabled").mockReturnValue(true);
        vi.spyOn(SidebarModel.getInstance(), "isHidden").mockReturnValue(true);
        const peek = vi.spyOn(SidebarModel.getInstance(), "setPeek").mockImplementation(() => {});
        toggleCommandPalette();
        expect(peek).toHaveBeenLastCalledWith(true);
        toggleCommandPalette();
        expect(peek).toHaveBeenLastCalledWith(false);
    });

    it("opens the palette dialog with the sidebar off", () => {
        vi.spyOn(SidebarModel.getInstance(), "isEnabled").mockReturnValue(false);
        toggleCommandPalette();
        expect(fieldOpen()).toBe(false);
        expect(openModals()).toEqual([CommandPaletteModalName]);
        toggleCommandPalette();
        expect(openModals()).toEqual([]);
    });

    it("Help › Command Palette runs the key's own handler", async () => {
        vi.spyOn(SidebarModel.getInstance(), "isEnabled").mockReturnValue(true);
        const keyMap = new Map<string, (e: WaveKeyboardEvent) => boolean>();
        keyMap.set(CommandPaletteKey, () => toggleCommandPalette());
        listenAppMenuCommands(keyMap);
        expect(menu.listener).not.toBeNull();
        menu.listener("palette");
        await vi.waitFor(() => expect(fieldOpen()).toBe(true));
        // An id the menu does not know does nothing.
        menu.listener("format-disk");
        expect(fieldOpen()).toBe(true);
    });
});
