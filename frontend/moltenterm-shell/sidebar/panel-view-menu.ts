// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// "Create a view with this panel" in the panel's menus (FR-SHELL-080, #2548): the right-click on the panel and the
// command panel offer it with a destination each, the project's entry listing its Views and its folders. The
// destinations and their order are in panel-view-model.ts; what a choice does is panel-view-store.ts.

import { fireAndForget } from "@/util/util";
import { t } from "../i18n/i18n";
import { PanelSection } from "../split/split-menu";
import { PanelViewEntry, panelViewEntries } from "./panel-view-model";
import { makeViewFromPanel, panelViewMenuFacts } from "./panel-view-store";

export const PanelViewIcon = "square-plus";

function labelOf(entry: PanelViewEntry): string {
    return t(entry.labelKey, entry.vars);
}

function toMenuItem(blockId: string, entry: PanelViewEntry): ContextMenuItem {
    if (entry.children != null) {
        return {
            label: labelOf(entry),
            icon: entry.icon,
            type: "submenu",
            submenu: entry.children.map((child) => toMenuItem(blockId, child)),
        };
    }
    return {
        label: labelOf(entry),
        icon: entry.icon,
        click: () => fireAndForget(() => makeViewFromPanel(blockId, entry.destination)),
    };
}

// The menu entry: one submenu, a destination per item.
export function panelViewMenuItems(blockId: string, section: string = PanelSection): ContextMenuItem[] {
    return [
        {
            label: t("sidebar.panelView.menu"),
            icon: PanelViewIcon,
            section,
            type: "submenu",
            submenu: panelViewEntries(panelViewMenuFacts()).map((entry) => toMenuItem(blockId, entry)),
        },
    ];
}
