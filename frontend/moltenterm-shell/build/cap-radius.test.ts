// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isRadiusProp, moltentermCapRadius, snapRadiusValue } from "./cap-radius";

describe("snapRadiusValue", () => {
    it.each([
        ["12px", "6px"],
        ["8px", "6px"],
        ["6px", "6px"],
        ["5px", "6px"],
        ["4px", "4px"],
        ["3px", "4px"],
        ["2px", "4px"],
        ["0", "0"],
        [".375rem", "6px"],
        ["0.125rem", "4px"],
        ["0.25rem", "4px"],
        ["10px 10px 0 0", "6px 6px 0 0"],
        ["8px / 4px", "6px / 4px"],
        ["50%", "50%"],
        ["3.40282e38px", "3.40282e38px"],
        ["9999px", "9999px"],
        ["calc(infinity * 1px)", "calc(infinity * 1px)"],
        ["calc(var(--block-border-radius) + 2px)", "6px"],
        ["var(--block-border-radius)", "var(--block-border-radius)"],
        ["var(--block-border-radius) var(--block-border-radius) 0 0", "var(--block-border-radius) var(--block-border-radius) 0 0"],
    ])("snaps %s to %s", (value, want) => {
        expect(snapRadiusValue(value)).toBe(want);
    });

    it("leaves nothing but 4 px and 6 px (0, circles and tokens apart)", () => {
        const radii = ["1px", "2px", "3px", "4px", "5px", "6px", "7px", "8px", "10px", "12px", "16px", "24px", "0.5rem", "1rem"];
        expect(new Set(radii.map(snapRadiusValue))).toEqual(new Set(["4px", "6px"]));
    });
});

describe("isRadiusProp", () => {
    it.each(["border-radius", "border-top-left-radius", "--block-border-radius", "--radius", "--radius-md", "--modal-border-radius"])(
        "%s is a radius",
        (prop) => expect(isRadiusProp(prop)).toBe(true)
    );
    it.each(["border-width", "--radiusless", "padding", "--color-accent", "--mt-radius-panel", "--mt-radius-control", "--df-radius-lg"])(
        "%s is not",
        (prop) => expect(isRadiusProp(prop)).toBe(false)
    );
});

describe("moltentermCapRadius", () => {
    it("rewrites radius declarations only", () => {
        const plugin = moltentermCapRadius();
        const radius = { prop: "border-radius", value: "8px" };
        const width = { prop: "border-width", value: "8px" };
        plugin.Declaration(radius);
        plugin.Declaration(width);
        expect(radius.value).toBe("6px");
        expect(width.value).toBe("8px");
    });
});
