// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { modalsModel } from "@/app/store/modalmodel";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/global", async () => {
    const { globalStore } = await import("@/app/store/jotaiStore");
    return { globalStore, getFocusedBlockId: () => "b1", refocusNode: () => {} };
});
vi.mock("./companion/companion-open", () => ({ registerCompanionKeys: () => {} }));
vi.mock("./view360/view360-pin", () => ({ registerPinKeys: () => {} }));

import { CommandPanelModel, toggleFocusedCommandPanel } from "./command-panel/command-panel-store";
import { modalIsOpen } from "./modal-open";
import { CommandPaletteModalName, toggleCommandPalette } from "./palette/palette-keys";
import { ShortcutsSheetModalName, toggleShortcutsSheet } from "./shortcuts/shortcuts-keys";

// The classes on the page: the test's stand-in for the DOM (vitest runs without one).
let present: string[] = [];

function openModals(): string[] {
    return globalStore.get(modalsModel.modalsAtom).map((m) => m.displayName);
}

beforeEach(() => {
    present = [];
    globalStore.set(modalsModel.modalsAtom, []);
    CommandPanelModel.getInstance().close();
    vi.stubGlobal("document", {
        querySelector: (selector: string) =>
            selector
                .split(",")
                .map((s) => s.trim().replace(/^\./, ""))
                .some((c) => present.includes(c))
                ? {}
                : null,
    });
    vi.stubGlobal("CSS", { escape: (s: string) => s });
    vi.stubGlobal("window", { innerWidth: 1200, innerHeight: 800 });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("no overlay opens under a modal (#746)", () => {
    it("sees a MoltenTerm dialog by its scrim and a Wave modal by its backdrop", () => {
        expect(modalIsOpen()).toBe(false);
        present = ["molten-scrim"];
        expect(modalIsOpen()).toBe(true);
        present = ["modal-backdrop"];
        expect(modalIsOpen()).toBe(true);
    });

    it("leaves the palette closed while a dialog is up, and opens it once the dialog is gone", () => {
        present = ["molten-scrim"];
        expect(toggleCommandPalette()).toBe(true);
        expect(openModals()).toEqual([]);
        present = [];
        toggleCommandPalette();
        expect(openModals()).toEqual([CommandPaletteModalName]);
        toggleCommandPalette();
        expect(openModals()).toEqual([]);
    });

    it("leaves the shortcuts sheet closed under another modal, and still closes it with its own key", () => {
        present = ["modal-backdrop"];
        expect(toggleShortcutsSheet()).toBe(true);
        expect(openModals()).toEqual([]);
        present = [];
        toggleShortcutsSheet();
        expect(openModals()).toEqual([ShortcutsSheetModalName]);
        // The sheet is itself a dialog with a scrim.
        present = ["molten-scrim"];
        toggleShortcutsSheet();
        expect(openModals()).toEqual([]);
    });

    it("leaves the command panel closed while a dialog is up", () => {
        present = ["molten-scrim"];
        expect(toggleFocusedCommandPanel()).toBe(true);
        expect(CommandPanelModel.getInstance().current()).toBeNull();
        present = [];
        toggleFocusedCommandPanel();
        expect(CommandPanelModel.getInstance().current()?.blockId).toBe("b1");
    });
});
