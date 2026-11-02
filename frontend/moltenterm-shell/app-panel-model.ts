// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Where an app action's panel opens (FR-SHELL-094): Preferences, CI/CD, a notification's view... never into the pinned
// view it was started from. Kept apart from the store so the rule can be tested without the app.

import { isProjectTab, shownViewState, viewStateOf } from "./sidebar/view-pins-model";

export type PanelMatch = (meta: Record<string, any>) => boolean;

export type AppPanelStep =
    // The active view already shows it.
    | { kind: "focus"; blockId: string }
    // Another view of the workspace shows it.
    | { kind: "show"; tabId: string; blockId: string }
    // The active view is temporary: the panel joins it.
    | { kind: "add" }
    // The active view is pinned and no view shows it: a new temporary view holds it.
    | { kind: "newview" };

// A view whose panels only the developer changes: pinned in the workspace, everywhere, or MoltenTerm's Project tab.
export function viewIsPinned(tab: { meta?: Record<string, any> }, globalIds: ReadonlySet<string>): boolean {
    if (tab == null) {
        return false;
    }
    return shownViewState(viewStateOf(tab, globalIds), isProjectTab(tab)) !== "temporary";
}

export function appPanelStep(input: {
    activePinned: boolean;
    inActive: string;
    elsewhere: { tabId: string; blockId: string };
}): AppPanelStep {
    if (input.inActive) {
        return { kind: "focus", blockId: input.inActive };
    }
    if (!input.activePinned) {
        return { kind: "add" };
    }
    if (input.elsewhere != null) {
        return { kind: "show", tabId: input.elsewhere.tabId, blockId: input.elsewhere.blockId };
    }
    return { kind: "newview" };
}

// The panel a block definition opens: the same view, and the same file for a JSON editor of the settings.
export function sameViewMatch(blockDef: BlockDef): PanelMatch {
    const view = blockDef?.meta?.view;
    const file = blockDef?.meta?.file ?? null;
    return (meta) => meta?.view === view && (meta?.file ?? null) === file;
}
