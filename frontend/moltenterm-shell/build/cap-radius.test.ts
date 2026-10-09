// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { capRadiusValue, isRadiusProp, moltentermCapRadius } from "./cap-radius";

describe("capRadiusValue", () => {
    it.each([
        ["8px", "3px"],
        ["4px", "3px"],
        ["3px", "3px"],
        ["2px", "2px"],
        ["0", "0"],
        [".375rem", "3px"],
        ["0.125rem", "0.125rem"],
        ["10px 10px 0 0", "3px 3px 0 0"],
        ["8px / 4px", "3px / 3px"],
        ["50%", "50%"],
        ["3.40282e38px", "3.40282e38px"],
        ["9999px", "9999px"],
        ["calc(infinity * 1px)", "calc(infinity * 1px)"],
        ["calc(var(--block-border-radius) + 2px)", "3px"],
        ["var(--block-border-radius)", "var(--block-border-radius)"],
        ["var(--block-border-radius) var(--block-border-radius) 0 0", "var(--block-border-radius) var(--block-border-radius) 0 0"],
    ])("caps %s to %s", (value, want) => {
        expect(capRadiusValue(value)).toBe(want);
    });
});

describe("isRadiusProp", () => {
    it.each(["border-radius", "border-top-left-radius", "--block-border-radius", "--radius", "--radius-md", "--modal-border-radius"])(
        "%s is a radius",
        (prop) => expect(isRadiusProp(prop)).toBe(true)
    );
    it.each(["border-width", "--radiusless", "padding", "--color-accent", "--mt-radius-6", "--mt-radius-10"])("%s is not", (prop) =>
        expect(isRadiusProp(prop)).toBe(false)
    );
});

describe("moltentermCapRadius", () => {
    it("rewrites radius declarations only", () => {
        const plugin = moltentermCapRadius();
        const radius = { prop: "border-radius", value: "6px" };
        const width = { prop: "border-width", value: "6px" };
        plugin.Declaration(radius);
        plugin.Declaration(width);
        expect(radius.value).toBe("3px");
        expect(width.value).toBe("6px");
    });
});
