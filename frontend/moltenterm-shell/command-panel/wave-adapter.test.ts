// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { adaptMenuItems, isDeveloperLabel } from "./wave-adapter";

describe("Wave adapter (FR-SHELL-047-AC7, DS-SHELL-086, TC-SHELL-103)", () => {
    it("turns a checkbox into a toggle, a checked submenu into a choice, a plain item into an action", () => {
        const click = vi.fn();
        const { items } = adaptMenuItems([
            { label: "Split right", click },
            { type: "separator" },
            { label: "Word Wrap", type: "checkbox", checked: true, click },
            {
                label: "Plot Type",
                submenu: [
                    { label: "CPU", type: "radio", checked: false, click },
                    { label: "Mem", type: "radio", checked: true, click },
                ],
            },
            { label: "Copy URL", click },
        ]);
        expect(items.map((i) => [i.label, i.type])).toEqual([
            ["Word Wrap", "toggle"],
            ["Plot Type", "choice"],
            ["Copy URL", "action"],
        ]);
        const toggle = items[0] as any;
        expect(toggle.value).toBe(true);
        const choice = items[1] as any;
        expect(choice.options.map((o: any) => [o.label, o.checked])).toEqual([
            ["CPU", false],
            ["Mem", true],
        ]);
        choice.options[0].run();
        expect(click).toHaveBeenCalledTimes(1);
    });

    it("makes a nested submenu a sub-page and moves developer items out of any depth", () => {
        const { items, developer } = adaptMenuItems([
            { label: "Copy BlockId", click: () => {} },
            {
                label: "Advanced",
                submenu: [
                    { label: "Force Restart Controller", click: () => {} },
                    {
                        label: "Run On Startup",
                        submenu: [
                            { label: "On", type: "checkbox", checked: false, click: () => {} },
                            { label: "Off", type: "checkbox", checked: true, click: () => {} },
                        ],
                    },
                ],
            },
        ]);
        expect(developer.map((d) => d.label)).toEqual(["Copy BlockId", "Force Restart Controller"]);
        expect(items.map((i) => [i.label, i.type])).toEqual([["Advanced", "page"]]);
        const inner = (items[0] as any).items;
        // An On / Off submenu reads as a switch.
        expect(inner.map((i: any) => [i.label, i.type, i.value])).toEqual([["Run On Startup", "toggle", false]]);
    });

    it("keeps disabled items dimmed, skips role-only items and puts destructive items last", () => {
        const { items } = adaptMenuItems([
            { label: "Danger", destructive: true, click: () => {} },
            { role: "copy" },
            { label: "Default Settings", enabled: false },
            { label: "Later", enabled: false, click: () => {} },
            { label: "Fine", click: () => {} },
        ]);
        expect(items.map((i) => [i.label, i.type, !!i.disabled])).toEqual([
            ["Default Settings", "info", true],
            ["Later", "action", true],
            ["Fine", "action", false],
            ["Danger", "action", false],
        ]);
    });

    it("gives every item a unique id", () => {
        const { items } = adaptMenuItems([
            { label: "Same", click: () => {} },
            { label: "Same", click: () => {} },
        ]);
        expect(new Set(items.map((i) => i.id)).size).toBe(2);
    });

    it("knows Wave's developer labels", () => {
        expect(isDeveloperLabel("Copy BlockId")).toBe(true);
        expect(isDeveloperLabel("Allow Bracketed Paste Mode")).toBe(true);
        expect(isDeveloperLabel("Debug Connection")).toBe(true);
        expect(isDeveloperLabel("Open DevTools")).toBe(true);
        expect(isDeveloperLabel("Themes")).toBe(false);
    });
});
