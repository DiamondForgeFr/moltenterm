// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Every string the 360 view's toggle and its leave dialogs show (FR-SHELL-066, #733), read through the interface's keys (FR-I18N-001) at
// each access: the components that show them call useLocale() so a language switch redraws them.

import { t } from "../i18n/i18n";

const Keys = [
    "toggleLabel",
    "toggleAutoMark",
    "tooltipOn",
    "tooltipOff",
    "heldManual",
    "heldAuto",
    "heldSetting",
    "offManual",
    "clickOn",
    "clickOff",
    "tooltipSingle",
    "menuOn",
    "menuLeave",
    "menuSettings",
    "blockedTitle",
    "blockedOk",
] as const;

export const View360Text = {} as Record<(typeof Keys)[number], string>;
for (const key of Keys) {
    Object.defineProperty(View360Text, key, { enumerable: true, get: () => t(`view360.ui.${key}`) });
}
