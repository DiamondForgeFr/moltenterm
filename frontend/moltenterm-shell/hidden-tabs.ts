// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Hidden tabs (#758, pkg/molten/hiddentabs.go): an agent the developer let work out of sight runs in a tab of the
// workspace that the tab bars and the tab-switch keys skip. Activating the tab (Go to, a notification, Show in
// Sessions) reveals it: wavesrv takes it out of the list.

// must match pkg/molten/hiddentabs.go
export const HiddenTabsMetaKey = "molten:hiddentabs";

export function hiddenTabIds(ws: { meta?: Record<string, any> }): string[] {
    const ids = ws?.meta?.[HiddenTabsMetaKey];
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
}

// visibleTabIds: the workspace's tabs a tab bar shows, in order.
export function visibleTabIds(ws: { tabids?: string[]; meta?: Record<string, any> }): string[] {
    const tabIds = ws?.tabids ?? [];
    const hidden = hiddenTabIds(ws);
    if (hidden.length === 0) {
        return tabIds;
    }
    return tabIds.filter((id) => !hidden.includes(id));
}
