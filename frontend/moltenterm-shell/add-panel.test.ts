// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { MoltentermAddPanelWidget } from "./add-panel";

describe("MoltentermAddPanelWidget", () => {
    it("opens Wave's launcher view in a new panel", () => {
        expect(MoltentermAddPanelWidget.blockdef).toEqual({ meta: { view: "launcher" } });
        expect(MoltentermAddPanelWidget.icon).toBe("plus");
        expect(MoltentermAddPanelWidget.magnified).toBeFalsy();
    });
});
