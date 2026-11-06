// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The panel's side of an agent showing a page (#1812, #1994): the tab the agent showed is the one the panel shows, and the
// panel comes into view. The keyboard focus is not asked for anywhere on this path: the developer goes on typing where they
// were, and the agent's own bar says why the page came.

import { bringPanelIntoView } from "../view360/carpet-reveal";

export type AgentShowTarget = {
    blockId: string;
    activeTabId: () => string;
    hasTab: (browserTabId: string) => boolean;
    selectTab: (browserTabId: string) => void;
};

// `shownTabIds` come latest last: when one call shows several tabs of a panel, the last one is what the developer sees.
export function showAgentPage(target: AgentShowTarget, shownTabIds: string[]): void {
    const latest = shownTabIds?.[shownTabIds.length - 1];
    if (latest != null && latest !== target.activeTabId() && target.hasTab(latest)) {
        target.selectTab(latest);
    }
    bringPanelIntoView(target.blockId);
}
