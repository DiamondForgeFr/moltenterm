// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import { View360Text } from "./view360-text";
import { toggleTitle } from "./view360-toggle-title";

describe("the 360 toggle's tooltip (FR-SHELL-066 AC3, #2175)", () => {
    it("says a resting 360 × N keeps its N and that the carpet comes back by itself", () => {
        const title = toggleTitle({ active: false, wanted: true, source: "manual", idle: true }, false, 2);
        expect(title).toBe(`${View360Text.tooltipOff}\n${t("view360.ui.offPlaces")}\n${View360Text.clickOn}`);
        expect(title).not.toContain(View360Text.offManual);
    });

    it("says a view that is offered the 360 view asks before it turns on (#2180)", () => {
        const title = toggleTitle({ active: false, wanted: false, source: "auto", asking: true }, false, 2);
        expect(title).toBe(`${View360Text.tooltipOff}\n${t("view360.ui.offAsking", { count: 2 })}\n${View360Text.clickOn}`);
        expect(title).not.toContain(t("view360.ui.offColumns", { count: 2 }));
    });

    it("keeps the words of the other states", () => {
        expect(toggleTitle({ active: false, wanted: false, source: "auto" }, true, 2)).toBe(View360Text.tooltipSingle);
        expect(toggleTitle({ active: true, wanted: true, source: "manual" }, false, 2)).toBe(
            `${View360Text.tooltipOn}\n${View360Text.heldManual}\n${View360Text.clickOff}`
        );
        expect(toggleTitle({ active: false, wanted: false, source: "manual" }, false, 2)).toContain(
            View360Text.offManual
        );
        expect(toggleTitle({ active: false, wanted: false, source: "setting" }, false, 2)).toContain(
            t("view360.ui.offGrid")
        );
        expect(toggleTitle({ active: false, wanted: false, source: "auto" }, false, 3)).toContain(
            t("view360.ui.offColumns", { count: 3 })
        );
    });
});
