// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Every Wave widget nobody rewrote (web, sysinfo, processes, help, apps…) gets its getSettingsMenuItems() as a section
// named after the panel (FR-SHELL-047-AC7). A fallback: it steps aside when a native widget provider matches.

import { getBlockComponentModel } from "@/app/store/global";
import { CommandProvider, PanelContext, PanelSection } from "../panel-types";
import { adaptMenuItems } from "../wave-adapter";

export function waveSections(ctx: PanelContext): PanelSection[] {
    const viewModel = ctx.viewModel ?? getBlockComponentModel(ctx.blockId)?.viewModel;
    const items = viewModel?.getSettingsMenuItems?.() ?? [];
    const adapted = adaptMenuItems(items, `wave:${ctx.view}:`);
    return [
        { id: `widget:${ctx.view}`, kind: "widget", title: ctx.panelName, items: adapted.items },
        { id: "developer", kind: "developer", title: "Developer", items: adapted.developer },
    ];
}

export const WaveMenuProvider: CommandProvider = {
    id: "wave-menu",
    kind: "widget",
    needs: ["wave-menu"],
    fallback: true,
    sections: waveSections,
};
