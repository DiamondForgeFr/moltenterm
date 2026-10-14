// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The add-panel button (FR-SHELL-006, DS-SHELL-006): the widget bar shows this one entry instead of the widget list.
// It opens Wave's launcher view in a new panel, where the user chooses what the panel becomes (the launcher replaces
// itself with the chosen widget); the launcher lists every configured widget. The description is read when shown, so it
// follows the interface language.

import { t } from "./i18n/i18n";

export const MoltentermAddPanelWidget: WidgetConfigType = {
    icon: "plus",
    label: "add",
    get description() {
        return t("shell.addPanel.description");
    },
    blockdef: { meta: { view: "launcher" } },
};
