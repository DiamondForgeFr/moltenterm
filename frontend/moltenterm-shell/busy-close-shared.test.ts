// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { busyCloseText } from "./busy-close-model";

describe("closing a pinned view for every project (#1760)", () => {
    it("names the view and the projects, and offers one way to close it: for all of them", () => {
        const text = busyCloseText("shared", "Cadrage", false, "Desktop, Website");
        expect(text.title).toContain("Cadrage");
        expect(text.subtitle).toContain("Desktop, Website");
        expect(text.subtitle).toContain("Cadrage");
        expect(text.confirm.toLowerCase()).toContain("all");
        expect(JSON.stringify(text).toLowerCase()).not.toContain("this project only");
    });

    it("keeps the other actions' texts as they were", () => {
        expect(busyCloseText("tab", "Notes").title).toContain("Notes");
        expect(busyCloseText("clear").confirm).not.toBe(busyCloseText("shared", "x", false, "a, b").confirm);
    });
});
