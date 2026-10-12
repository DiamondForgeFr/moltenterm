// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { toggleStep } from "./view-toggle-model";

describe("rail toggle (#533)", () => {
    it("opens a view the tab does not show", () => {
        expect(toggleStep(null, 3)).toBe("open");
        expect(toggleStep("", 0)).toBe("open");
    });

    it("closes the view on the second click", () => {
        expect(toggleStep("b1", 3)).toBe("close");
    });

    it("keeps the tab when the view is its only pane", () => {
        expect(toggleStep("b1", 1)).toBe("replace");
    });
});
