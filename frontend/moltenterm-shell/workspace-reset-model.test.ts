// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { canCloseWorkspace, resetLossText } from "./workspace-reset-model";

describe("canCloseWorkspace", () => {
    it("refuses the only workspace", () => {
        expect(canCloseWorkspace([{ id: "a" }], "a")).toBe(false);
    });

    it("allows a close when another workspace remains", () => {
        expect(canCloseWorkspace([{ id: "a" }, { id: "b" }], "a")).toBe(true);
        expect(canCloseWorkspace([{ id: "a" }, { id: "b" }], "b")).toBe(true);
    });

    it("counts the unsaved workspace of the window as one to land on", () => {
        expect(canCloseWorkspace([{ id: "tmp" }, { id: "a" }], "a")).toBe(true);
    });

    it("refuses when the list is empty or unknown", () => {
        expect(canCloseWorkspace([], "a")).toBe(false);
        expect(canCloseWorkspace(null, "a")).toBe(false);
        expect(canCloseWorkspace([{ id: "" }, { id: "a" }], "a")).toBe(false);
    });
});

describe("resetLossText", () => {
    it("names the views and panels lost (FR-SHELL-095)", () => {
        expect(resetLossText(3, 5)).toBe("Its 3 views and their 5 panels will close; terminals and agents stop.");
        expect(resetLossText(1, 1)).toBe("Its 1 view and their 1 panel will close; terminals and agents stop.");
    });

    it("names only the views when they hold no panel", () => {
        expect(resetLossText(1, 0)).toBe("Its 1 view will close.");
    });
});
