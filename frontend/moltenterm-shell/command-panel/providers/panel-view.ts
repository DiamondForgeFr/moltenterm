// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// "Create a view with this panel" in the command panel of every panel (FR-SHELL-080, #2548): a page whose entries are
// the destinations, a project's entry a page of its own when it has folders. The destinations are in
// sidebar/panel-view-model.ts, and what a choice does in sidebar/panel-view-store.ts.

import { t } from "../../i18n/i18n";
import { PanelViewIcon } from "../../sidebar/panel-view-menu";
import { PanelViewEntry, panelViewEntries } from "../../sidebar/panel-view-model";
import { makeViewFromPanel, panelViewMenuFacts } from "../../sidebar/panel-view-store";
import { CommandProvider, PanelContext, PanelItem, PanelSection } from "../panel-types";

function toItem(blockId: string, entry: PanelViewEntry): PanelItem {
    const id = `molten:panelview:${entry.id}`;
    const label = t(entry.labelKey, entry.vars);
    if (entry.children != null) {
        return { id, type: "page", label, icon: entry.icon, items: entry.children.map((c) => toItem(blockId, c)) };
    }
    return {
        id,
        type: "action",
        label,
        icon: entry.icon,
        run: () => {
            void makeViewFromPanel(blockId, entry.destination);
        },
    };
}

export function panelViewItem(blockId: string): PanelItem {
    return {
        id: "molten:panelview",
        type: "page",
        label: t("sidebar.panelView.menu"),
        icon: PanelViewIcon,
        keywords: ["view", "vue", "pin", "épingler", "new view", "nouvelle vue", "sidebar"],
        items: panelViewEntries(panelViewMenuFacts()).map((entry) => toItem(blockId, entry)),
    };
}

export function panelViewSections(ctx: PanelContext): PanelSection[] {
    return [{ id: "molten", kind: "molten", title: "MoltenTerm", items: [panelViewItem(ctx.blockId)] }];
}

export const PanelViewProvider: CommandProvider = {
    id: "molten-panel-view",
    kind: "molten",
    order: 5,
    sections: panelViewSections,
};
