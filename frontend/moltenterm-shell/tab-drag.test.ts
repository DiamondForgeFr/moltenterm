// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { checkTabDragReleased } from "./tab-drag";

describe("tab drag (#81)", () => {
    it("ends when the pointer moves with no button pressed", () => {
        expect(checkTabDragReleased({ buttons: 0 })).toBe(true);
    });

    it("goes on while the main button is held, with or without another one", () => {
        expect(checkTabDragReleased({ buttons: 1 })).toBe(false);
        expect(checkTabDragReleased({ buttons: 3 })).toBe(false);
    });
});
