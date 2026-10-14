// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What pinning a carpet panel says (FR-SHELL-067), read in the interface language each time it is shown (#623).

import { t } from "../i18n/i18n";

export const PinText = {
    get pinBeside() {
        return t("view360.pin.pinBeside");
    },
    get pinStacked() {
        return t("view360.pin.pinStacked");
    },
    get unpin() {
        return t("view360.pin.unpin");
    },
    get pinButton() {
        return t("view360.pin.pinButton");
    },
    get unpinButton() {
        return t("view360.pin.unpinButton");
    },
    get pinnedBadge() {
        return t("view360.pin.pinnedBadge");
    },
    get refusedTitle() {
        return t("view360.pin.refusedTitle");
    },
    get refusedMessage() {
        return t("view360.pin.refusedMessage");
    },
};

// The shortcut list keeps its English label as data and shows `shortcuts.items.pin-panel`.
export const PinShortcutLabel = "Pin the panel to the fixed zone, or unpin it";
