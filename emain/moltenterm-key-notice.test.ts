// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isKeyNotice } from "./moltenterm-key-notice";

function ev(type: string, key: string, mods: Partial<WaveKeyboardEvent> = {}): WaveKeyboardEvent {
    return { type, key, meta: false, alt: false, control: false, shift: false, ...mods } as WaveKeyboardEvent;
}

describe("web page key notices for the shortcut overlay (FR-SHELL-090)", () => {
    it("tells the modifiers, the chords and Escape", () => {
        expect(isKeyNotice(ev("keydown", "Meta", { meta: true }))).toBe(true);
        expect(isKeyNotice(ev("keyup", "Meta"))).toBe(true);
        expect(isKeyNotice(ev("keydown", "Alt", { alt: true }))).toBe(true);
        expect(isKeyNotice(ev("keydown", "c", { meta: true }))).toBe(true);
        expect(isKeyNotice(ev("keydown", "Escape"))).toBe(true);
    });

    it("never tells plain typing", () => {
        expect(isKeyNotice(ev("keydown", "a"))).toBe(false);
        expect(isKeyNotice(ev("keydown", "A", { shift: true }))).toBe(false);
        expect(isKeyNotice(ev("keyup", "a"))).toBe(false);
        expect(isKeyNotice(ev("keydown", "Enter"))).toBe(false);
        expect(isKeyNotice(null)).toBe(false);
    });
});
