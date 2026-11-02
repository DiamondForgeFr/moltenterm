// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// One click closes a temporary view, with Undo (FR-SHELL-025 revision #1656). Until its toast leaves, the view is only
// set aside: hidden (#758, hidden-tabs.ts) and named by the workspace's meta, its panels, terminals and agents still
// alive, so Undo gives it back exactly as it was. The view on screen shows the toast and owns the real close; each
// window view is its own renderer, so the meta is how they agree. Kept apart from the stores to be tested alone.

import { hiddenTabIds } from "../hidden-tabs";

export const SetAsideMetaKey = "molten:closingview";
// A mark older than this has lost its toast (a renderer gone, a quit): the view on screen closes the view for good.
// The toast pauses while pointed at, so the bound is far above its own time.
export const SetAsideStaleMs = 120000;

export type SetAsideMark = {
    tabid: string;
    at: number;
    id: string;
    // The view was on screen: Undo brings it back there.
    wasactive: boolean;
    // The view whose renderer shows the toast; the view on screen takes it over, so the toast follows the screen.
    shownby?: string;
};

type WorkspaceLike = { tabids?: string[]; activetabid?: string; meta?: Record<string, any> };

export function readSetAside(ws: WorkspaceLike): SetAsideMark {
    const m = ws?.meta?.[SetAsideMetaKey];
    if (m == null || typeof m !== "object" || typeof m.tabid !== "string" || !m.tabid || typeof m.id !== "string") {
        return null;
    }
    return {
        tabid: m.tabid,
        at: typeof m.at === "number" ? m.at : 0,
        id: m.id,
        wasactive: !!m.wasactive,
        shownby: typeof m.shownby === "string" ? m.shownby : undefined,
    };
}

// What the renderer of ownTabId does with the workspace's mark:
// show: it is on screen and does not show the toast yet (it takes it over);
// finish: the mark is stale, the view closes for good;
// forget: the view is gone or was shown again by another path, the close is off;
// drop: this renderer shows a toast the view on screen took over;
// none: nothing to do.
export type SetAsideStep = "none" | "show" | "finish" | "forget" | "drop";

export type SetAsideHere = {
    ownTabId: string;
    // The mark id whose toast this renderer shows; null when none.
    showingId: string;
    now: number;
};

export function setAsideStep(ws: WorkspaceLike, here: SetAsideHere): SetAsideStep {
    const mark = readSetAside(ws);
    if (mark == null) {
        return here.showingId != null ? "drop" : "none";
    }
    if (here.showingId != null && (here.showingId !== mark.id || (mark.shownby && mark.shownby !== here.ownTabId))) {
        return "drop";
    }
    // The view set aside is still on screen for the moment the window takes to show the next one: never its toast.
    if (here.ownTabId !== ws.activetabid || here.ownTabId === mark.tabid) {
        return "none";
    }
    if (!(ws.tabids ?? []).includes(mark.tabid) || !hiddenTabIds(ws).includes(mark.tabid)) {
        return "forget";
    }
    if (here.now - mark.at > SetAsideStaleMs) {
        return "finish";
    }
    if (here.showingId === mark.id) {
        return "none";
    }
    return "show";
}

// The view shown once tabId is set aside, as wavesrv picks it for a close (moltenNextActiveTab,
// pkg/wcore/moltenterm_hiddentabs.go): its opener when shown, the view shown before it (#1345), the nearest shown one
// on its left, else on its right. null: no other view shows, the close is not set aside.
export function setAsideSurvivor(ws: WorkspaceLike, tabId: string, opener: string): string {
    const ids = ws?.tabids ?? [];
    const hidden = hiddenTabIds(ws);
    const shown = (id: string) => id !== tabId && ids.includes(id) && !hidden.includes(id);
    if (opener && shown(opener)) {
        return opener;
    }
    const history = ws?.meta?.["molten:tabhistory"];
    if (Array.isArray(history)) {
        const previous = history.find((id) => typeof id === "string" && shown(id));
        if (previous != null) {
            return previous;
        }
    }
    const idx = ids.indexOf(tabId);
    for (let i = idx - 1; i >= 0; i--) {
        if (shown(ids[i])) {
            return ids[i];
        }
    }
    return ids.slice(idx + 1).find(shown) ?? null;
}

// The hidden list with tabId set aside, or given back; null once empty, which takes the key away.
export function withHidden(ws: WorkspaceLike, tabId: string, hide: boolean): string[] {
    const rest = hiddenTabIds(ws).filter((id) => id !== tabId);
    const ids = hide ? [...rest, tabId] : rest;
    return ids.length > 0 ? ids : null;
}
