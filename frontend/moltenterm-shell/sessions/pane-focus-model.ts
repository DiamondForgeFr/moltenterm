// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The rules of pane-focus.ts, kept apart from the app so they can be tested.

import { FocusBlockMetaKey, SessionLocation } from "./sessions-model";

// A request older than this was for a visit that is over (the user went elsewhere meanwhile).
export const FocusFreshMs = 10000;

// browsertabid: the page of a browser panel to show when the panel is reached (a download's way back, #1992).
export type FocusRequest = { blockid: string; ts: number; browsertabid?: string };

export function freshFocusRequest(meta: Record<string, any>, nowMs: number): string {
    const req = meta?.[FocusBlockMetaKey] as FocusRequest;
    if (req == null || typeof req !== "object" || !req.blockid || typeof req.ts !== "number") {
        return null;
    }
    const age = nowMs - req.ts;
    return age >= -FocusFreshMs && age <= FocusFreshMs ? req.blockid : null;
}

// The page of the panel the request asks for, when there is one.
export function focusRequestBrowserTab(meta: Record<string, any>): string {
    const req = meta?.[FocusBlockMetaKey] as FocusRequest;
    return typeof req?.browsertabid === "string" && req.browsertabid !== "" ? req.browsertabid : null;
}

export type ShowStep = "focus" | "tab" | "workspace";

export function paneShowStep(loc: SessionLocation, workspaceId: string, activeTabId: string): ShowStep {
    if (loc.workspaceid && loc.workspaceid !== workspaceId) {
        return "workspace";
    }
    if (loc.tabid && loc.tabid !== activeTabId) {
        return "tab";
    }
    return "focus";
}
