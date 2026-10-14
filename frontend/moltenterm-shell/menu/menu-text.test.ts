// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { DeveloperSection, layoutMenuItems } from "./menu-model";
import { menuDisplayLabel } from "./menu-text";

describe("menu text (FR-I18N-001)", () => {
    it("shows edit roles and the host's section headings from keys, other labels as given", () => {
        expect(menuDisplayLabel({ role: "pasteAndMatchStyle" })).toBe("Paste and match style");
        expect(menuDisplayLabel({ type: "header", label: DeveloperSection })).toBe("Developer");
        expect(menuDisplayLabel({ type: "header", label: "Some heading" })).toBe("Some heading");
        expect(menuDisplayLabel({ label: "Rename" })).toBe("Rename");
    });

    it("keeps grouping on the English section ids", () => {
        const items = layoutMenuItems(
            [
                { label: "a", section: "Panel" },
                { label: "b", section: DeveloperSection },
            ],
            { developer: true }
        );
        expect(items.filter((i) => i.type === "header").map((i) => i.label)).toEqual(["Panel", DeveloperSection]);
    });
});
