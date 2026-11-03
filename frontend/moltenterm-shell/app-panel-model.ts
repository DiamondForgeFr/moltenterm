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

// For a panel that every call to action opens afresh (a terminal in the project's folder): no open panel counts.
export const NoPanelMatch: PanelMatch = () => false;

// A call to action inside a panel that opens another panel (#1844, FR-SHELL-139 AC13): the developer's own gesture in
// that view, so the panel opens beside the one the call to action is in, even in a pinned view. App actions (the rail,
// the status bar, a notification...) start outside any panel and keep appPanelStep.
export type PanelOrigin = {
    // The panel the call to action is in (usePanelBlockId).
    blockId?: string;
    // The call to action asked for a new view: it says so, or Shift (⌘) was held on the click.
    newView?: boolean;
};

export type PanelCtaStep =
    // The view already shows a panel of that kind: it gets the focus and what the call to action names.
    | { kind: "focus"; blockId: string }
    // A new column to the right of the panel the call to action is in.
    | { kind: "beside"; sourceBlockId: string }
    | { kind: "newview" }
    // The panel it is in is not laid out (a floating panel, none known): the app action's rules.
    | { kind: "door" };

export function panelCtaStep(input: {
    newView: boolean;
    inActive: string;
    sourceBlockId: string;
    sourceLaidOut: boolean;
}): PanelCtaStep {
    if (input.newView) {
        return { kind: "newview" };
    }
    if (input.inActive) {
        return { kind: "focus", blockId: input.inActive };
    }
    if (input.sourceBlockId && input.sourceLaidOut) {
        return { kind: "beside", sourceBlockId: input.sourceBlockId };
    }
    return { kind: "door" };
}

export type ClickModifiers = { shiftKey?: boolean; metaKey?: boolean; ctrlKey?: boolean };

// The browser's "open in a new window" (window = view, FR-SHELL-139): Shift on the click, or the platform's command key
// (⌘; Ctrl elsewhere, where Ctrl-click is not the context menu).
export function wantsNewView(mods: ClickModifiers, mac: boolean): boolean {
    if (mods == null) {
        return false;
    }
    return !!mods.shiftKey || (mac ? !!mods.metaKey : !!mods.ctrlKey);
}

export function panelOrigin(blockId: string, mods: ClickModifiers, mac: boolean): PanelOrigin {
    return { blockId, newView: wantsNewView(mods, mac) };
}
