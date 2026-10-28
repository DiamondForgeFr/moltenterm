// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// ⌘L is the top field's only key; ⌘K clears the terminal and never opens the field (FR-SHELL-083, #1219).

import { globalStore } from "@/app/store/jotaiStore";
import { TermViewModel } from "@/app/view/term/term-model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findShortcut } from "../shortcuts/registry";
import { SidebarModel } from "./sidebar-store";
import { registerTopFieldKeys, TopFieldModel } from "./top-field-store";

function keydown(key: string, meta = true): KeyboardEvent {
    return {
        type: "keydown",
        key,
        code: `Key${key.toUpperCase()}`,
        metaKey: meta,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
        location: 0,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    } as unknown as KeyboardEvent;
}

function fakeTerminal() {
    const clear = vi.fn();
    const model = Object.create(TermViewModel.prototype) as TermViewModel;
    Object.assign(model, {
        blockId: "b1",
        termRef: { current: { terminal: { clear, getSelection: () => "" } } },
        keyDownHandler: () => false,
    });
    return { model, clear };
}

afterEach(() => {
    vi.restoreAllMocks();
    TopFieldModel.getInstance().close();
});

describe("top field keys", () => {
    it("binds ⌘L only", () => {
        const shortcut = findShortcut("top-field");
        expect(shortcut.keys).toBe("Cmd:l");
        expect(shortcut.alt ?? []).not.toContain("Cmd:k");
        expect(findShortcut("term-clear").keys).toBe("Cmd:k");
        const keyMap = new Map<string, (e: WaveKeyboardEvent) => boolean>();
        registerTopFieldKeys(keyMap);
        expect([...keyMap.keys()]).toEqual(["Cmd:l"]);
    });

    it("⌘L opens the field with the sidebar on, peeking a hidden sidebar", () => {
        const sidebar = SidebarModel.getInstance();
        vi.spyOn(sidebar, "isEnabled").mockReturnValue(true);
        vi.spyOn(sidebar, "isHidden").mockReturnValue(true);
        const peek = vi.spyOn(sidebar, "setPeek").mockImplementation(() => {});
        const keyMap = new Map<string, (e: WaveKeyboardEvent) => boolean>();
        registerTopFieldKeys(keyMap);
        expect(keyMap.get("Cmd:l")(null)).toBe(true);
        expect(globalStore.get(TopFieldModel.getInstance().openAtom)).toBe(true);
        expect(peek).toHaveBeenCalledWith(true);
    });

    it("⌘K in a terminal clears it and never opens the field, sidebar on", () => {
        const sidebar = SidebarModel.getInstance();
        vi.spyOn(sidebar, "isEnabled").mockReturnValue(true);
        const open = vi.spyOn(TopFieldModel.getInstance(), "open");
        const { model, clear } = fakeTerminal();
        const event = keydown("k");
        expect(model.handleTerminalKeydown(event)).toBe(false);
        expect(clear).toHaveBeenCalledTimes(1);
        expect(event.preventDefault).toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(globalStore.get(TopFieldModel.getInstance().openAtom)).toBe(false);
    });
});
