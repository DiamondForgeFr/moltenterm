// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Ctrl+Shift hold that numbers the panels and the carpet's tabs (FR-SHELL-126-AC2): on while both keys are down
// and no Cmd, off when either goes up or the window loses focus.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("./moltenterm-external-links", () => ({ openExternalLink: vi.fn() }));

import { handleCtrlShiftFocus, handleCtrlShiftState } from "./emain-util";

function ev(type: "keydown" | "keyup", key: string, mods: { control?: boolean; shift?: boolean; meta?: boolean }) {
    return { type, key, control: !!mods.control, shift: !!mods.shift, meta: !!mods.meta } as WaveKeyboardEvent;
}

function recorder() {
    const sent: boolean[] = [];
    const wc = { send: (_channel: string, state: boolean) => sent.push(state) } as unknown as Electron.WebContents;
    return { wc, sent };
}

describe("the Ctrl+Shift hold", () => {
    beforeEach(() => {
        handleCtrlShiftFocus({ send: () => {} } as unknown as Electron.WebContents, false);
    });

    it("turns on when Ctrl and Shift are both down, in either order", () => {
        const { wc, sent } = recorder();
        handleCtrlShiftState(wc, ev("keydown", "Control", { control: true }));
        expect(sent.at(-1)).toBe(false);
        handleCtrlShiftState(wc, ev("keydown", "Shift", { control: true, shift: true }));
        expect(sent.at(-1)).toBe(true);
    });

    it("turns off when either key is released", () => {
        const first = recorder();
        handleCtrlShiftState(first.wc, ev("keydown", "Shift", { control: true, shift: true }));
        handleCtrlShiftState(first.wc, ev("keyup", "Control", { shift: true }));
        expect(first.sent).toEqual([true, false]);
        const second = recorder();
        handleCtrlShiftState(second.wc, ev("keydown", "Control", { control: true, shift: true }));
        handleCtrlShiftState(second.wc, ev("keyup", "Shift", { control: true }));
        expect(second.sent).toEqual([true, false]);
    });

    it("stays on while Tab is pressed and released, so cycling shows the numbers", () => {
        const { wc, sent } = recorder();
        handleCtrlShiftState(wc, ev("keydown", "Control", { control: true, shift: true }));
        handleCtrlShiftState(wc, ev("keydown", "Tab", { control: true, shift: true }));
        handleCtrlShiftState(wc, ev("keyup", "Tab", { control: true, shift: true }));
        expect(sent).toEqual([true]);
    });

    it("is off with Cmd down, and when the window loses focus", () => {
        const { wc, sent } = recorder();
        handleCtrlShiftState(wc, ev("keydown", "Meta", { control: true, shift: true, meta: true }));
        expect(sent).toEqual([false]);
        handleCtrlShiftFocus(wc, true);
        expect(sent).toEqual([false]);
        handleCtrlShiftFocus(wc, false);
        expect(sent).toEqual([false, false]);
    });
});
