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
    it("names the tabs and panes lost", () => {
        expect(resetLossText(3, 5)).toBe(
            "Its 3 tabs and the 5 panes they hold will be closed: their terminals and agents stop and the layout is lost."
        );
        expect(resetLossText(1, 1)).toBe(
            "Its 1 tab and the 1 pane they hold will be closed: their terminals and agents stop and the layout is lost."
        );
    });

    it("names only the tabs when they hold no pane", () => {
        expect(resetLossText(1, 0)).toBe("Its 1 tab will be closed.");
    });
});
