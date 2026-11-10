// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The tab bar toggle's tooltip (FR-SHELL-066 AC3, DS-SHELL-117): the state, what holds it (or keeps it off), and what a
// click does. Kept apart from the component so the words for each state are tested alone.

import { t } from "../i18n/i18n";
import type { View360Decision } from "./view360-decision";
import { View360Text } from "./view360-text";

export function toggleTitle(decision: View360Decision, single: boolean, threshold: number): string {
    if (single) {
        return View360Text.tooltipSingle;
    }
    if (decision.active) {
        const held =
            decision.source === "manual"
                ? View360Text.heldManual
                : decision.source === "auto"
                  ? decision.reason === "columns"
                      ? t("view360.ui.heldColumns", { count: threshold })
                      : View360Text.heldAuto
                  : View360Text.heldSetting;
        return `${View360Text.tooltipOn}\n${held}\n${View360Text.clickOff}`;
    }
    if (decision.idle) {
        return `${View360Text.tooltipOff}\n${t("view360.ui.offPlaces")}\n${View360Text.clickOn}`;
    }
    const off =
        decision.source === "manual"
            ? View360Text.offManual
            : decision.source === "setting"
              ? t("view360.ui.offGrid")
              : t("view360.ui.offColumns", { count: threshold });
    return `${View360Text.tooltipOff}\n${off}\n${View360Text.clickOn}`;
}
