// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Closing a pinned view (FR-SHELL-080, #1760): the view is the workspace's, each project holds an instance of it, so it
// closes for every project. A tile closes every instance of its slot, a view pinned everywhere this workspace's
// instances of its pin, the Project tab its one shared tab. With two projects or more a confirmation comes first and
// names them, never a block; with one project the view closes at once. Pure: the store reads the workspace.

import { slotMembers } from "../hidden-tabs";
import { GlobalPinMetaKey, ViewState } from "./view-pins-model";

export type PinnedClosePlan = {
    // The tabs that close, the one asked first.
    tabIds: string[];
    // The view is the workspace's: it closes for every project.
    shared: boolean;
    // A confirmation names the projects first.
    confirm: boolean;
    // The workspace's projects, by name.
    projects: string[];
};

export function planPinnedClose(
    ws: { tabids?: string[]; meta?: Record<string, any> },
    tabId: string,
    state: ViewState,
    projectTab: boolean,
    metaOf: (tabId: string) => Record<string, any>,
    projectNames: string[]
): PinnedClosePlan {
    const names = projectNames ?? [];
    if (state === "temporary" && !projectTab) {
        return { tabIds: [tabId], shared: false, confirm: false, projects: names };
    }
    let tabIds = [tabId];
    if (!projectTab && state === "workspace") {
        tabIds = slotMembers(ws, tabId);
    }
    if (!projectTab && state === "everywhere") {
        const pin = metaOf(tabId)?.[GlobalPinMetaKey];
        if (typeof pin === "string" && pin !== "") {
            tabIds = (ws?.tabids ?? []).filter((id) => metaOf(id)?.[GlobalPinMetaKey] === pin);
        }
    }
    const asked = tabIds.includes(tabId) ? [tabId, ...tabIds.filter((id) => id !== tabId)] : tabIds;
    return { tabIds: asked, shared: true, confirm: names.length >= 2, projects: names };
}

// A safety net: since #1778 the window's action queue runs every close in order and closeTab answers true only once the
// tab is gone, but the workspace this renderer sees can lag behind. Each close is checked and asked again when the tab is
// still there; the first ask is the recorded one, the others do not record again.
export const CloseAttempts = 3;
export const CloseStepMs = 100;
export const CloseStepsPerAttempt = 20;

export async function closeUntilGone(
    close: (attempt: number) => Promise<boolean>,
    isGone: () => boolean,
    wait: (ms: number) => Promise<void>
): Promise<boolean> {
    for (let attempt = 0; attempt < CloseAttempts; attempt++) {
        if (!(await close(attempt))) {
            return false;
        }
        for (let step = 0; step < CloseStepsPerAttempt && !isGone(); step++) {
            await wait(CloseStepMs);
        }
        if (isGone()) {
            return true;
        }
    }
    return false;
}
