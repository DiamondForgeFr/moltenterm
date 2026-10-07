// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { FirstClickWindowMs, makeFirstClickGuard } from "./first-click-guard";

describe("makeFirstClickGuard", () => {
    it("swallows a mousedown right after the window was activated", () => {
        const guard = makeFirstClickGuard();
        guard.noteWindowFocus(1000);
        expect(guard.swallowsMouseDown(1000 + FirstClickWindowMs - 1)).toBe(true);
    });

    it("lets a mousedown through once the activation window has passed", () => {
        const guard = makeFirstClickGuard();
        guard.noteWindowFocus(1000);
        expect(guard.swallowsMouseDown(1000 + FirstClickWindowMs)).toBe(false);
    });

    it("never swallows before the window was activated", () => {
        const guard = makeFirstClickGuard();
        expect(guard.swallowsMouseDown(0)).toBe(false);
    });

    it("does not treat the focus coming back from a webview as an activation (#334)", () => {
        const guard = makeFirstClickGuard();
        guard.noteWebviewFocus(true);
        guard.noteWindowFocus(1000);
        expect(guard.swallowsMouseDown(1001)).toBe(false);
    });

    it("forgets an earlier activation when the focus then comes back from a webview", () => {
        const guard = makeFirstClickGuard();
        guard.noteWindowFocus(1000);
        guard.noteWebviewFocus(true);
        guard.noteWindowFocus(1010);
        expect(guard.swallowsMouseDown(1020)).toBe(false);
    });

    it("arms again once the webview has lost the focus", () => {
        const guard = makeFirstClickGuard();
        guard.noteWebviewFocus(true);
        guard.noteWindowFocus(1000);
        guard.noteWebviewFocus(false);
        guard.noteWindowFocus(5000);
        expect(guard.swallowsMouseDown(5001)).toBe(true);
    });
});
