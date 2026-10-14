// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The text a MoltenTerm menu shows, in the interface language (FR-I18N-001): edit roles from their keys, and the
// section headings the host draws from the items' sections. Kept apart from menu-model.ts, which Electron main imports.

import { t } from "../i18n/i18n";
import { hasKey } from "../i18n/i18n-core";
import { menuLabel, MenuRoleKeys, menuSectionKey } from "./menu-model";

// A heading the host drew from a section (layoutMenuItems) is the section's id: translated when a key exists, as
// written otherwise (a heading an item declared itself is already in the interface language).
export function menuDisplayLabel(item: ContextMenuItem): string {
    if (item.type === "header" && item.label != null) {
        const key = menuSectionKey(item.label);
        return hasKey(key) ? t(key) : item.label;
    }
    if (item.label == null && MenuRoleKeys[item.role] != null) return t(MenuRoleKeys[item.role]);
    return menuLabel(item);
}
