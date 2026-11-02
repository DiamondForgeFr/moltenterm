// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { isDarkSurface } from "./dark-surface";

// FR-SHELL-121 AC-3: terminals stay dark in the light theme unless the developer picks a light terminal theme.
describe("dark panel in the light theme (FR-SHELL-121)", () => {
    it.each(["#100e0c", "#100e0c80", "rgba(16, 14, 12, 0.5)", "#000000", "#1e1e2e"])("keeps %s dark", (bg) => {
        expect(isDarkSurface(bg)).toBe(true);
    });

    it.each(["#ffffff", "#fdf6e3", "rgba(255, 255, 255, 0.4)"])("lets a light terminal theme %s follow", (bg) => {
        expect(isDarkSurface(bg)).toBe(false);
    });

    it.each([undefined, null, "", "not a colour"])("marks nothing without a background (%s)", (bg) => {
        expect(isDarkSurface(bg)).toBe(false);
    });
});
