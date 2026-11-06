// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The way back from a download to where it started (#1992): the page that started it, in its view, in its workspace.
// What a row says about that place and what its call to action does follow from three facts read when the row is
// drawn, never from what was true at download time: the page may have been closed, its view closed, its workspace
// deleted. The download itself runs whatever happens to its page. Never a button that leads nowhere: what cannot work
// is not offered, and the row says why.

import type { DownloadOrigin } from "./downloads-model";

// What exists now, read from wavesrv. workspace is null when it was deleted; view is null when the view (the Wave tab)
// is gone from it.
export type OriginFacts = {
    workspace: { name: string; activeTabId: string } | null;
    view: { name: string; blockIds: string[] } | null;
};

export type OriginKind =
    // the page's panel is still in its view
    | "page"
    // the view is there, the panel is not
    | "pageclosed"
    // the view is gone, the workspace is there
    | "viewclosed"
    // the workspace itself was deleted
    | "workspacegone"
    // nothing is known about where it started, or the facts could not be read
    | "unknown";

export type OriginState = {
    kind: OriginKind;
    workspaceName: string;
    viewName: string;
    // The origin workspace is not the one the developer is in: its name is told, and the call to action switches to it.
    otherWorkspace: boolean;
    // goto: the page is open. reopen: open its address in the origin workspace. none: nothing can lead back.
    cta: "goto" | "reopen" | "none";
    // A calmer second way, to the view, when the page is closed but the view is there.
    toView: boolean;
};

const Unknown: OriginState = {
    kind: "unknown",
    workspaceName: "",
    viewName: "",
    otherWorkspace: false,
    cta: "none",
    toView: false,
};

// Only a web page can be opened again: a blob or a data address of the page is gone with it.
export function canReopenPage(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
        return false;
    }
}

export function originState(origin: DownloadOrigin, facts: OriginFacts, currentWorkspaceId: string): OriginState {
    if (!origin?.workspaceId || !origin.tabId || facts == null) {
        return Unknown;
    }
    if (facts.workspace == null) {
        return { ...Unknown, kind: "workspacegone" };
    }
    const base = {
        workspaceName: facts.workspace.name,
        viewName: facts.view?.name ?? "",
        otherWorkspace: origin.workspaceId !== currentWorkspaceId,
    };
    const reopen = canReopenPage(origin.pageUrl) ? "reopen" : "none";
    if (facts.view == null) {
        return { ...base, kind: "viewclosed", cta: reopen, toView: false };
    }
    if (!origin.blockId || !facts.view.blockIds.includes(origin.blockId)) {
        return { ...base, kind: "pageclosed", cta: reopen, toView: true };
    }
    return { ...base, kind: "page", cta: "goto", toView: false };
}

// Where "Reopen the page" opens it: its own view when that is still there, otherwise a new browser panel of the
// workspace, in the view it shows. Never the workspace the developer is in unless that is the origin.
export function reopenTarget(origin: DownloadOrigin, facts: OriginFacts): { workspaceId: string; tabId: string } {
    if (facts?.workspace == null) {
        return null;
    }
    if (facts.view != null) {
        return { workspaceId: origin.workspaceId, tabId: origin.tabId };
    }
    return facts.workspace.activeTabId ? { workspaceId: origin.workspaceId, tabId: facts.workspace.activeTabId } : null;
}

// The request a view's renderer applies once it shows: open this address in a browser panel of the view.
export const OpenPageMetaKey = "molten:openpage";
export const OpenPageFreshMs = 10000;

export type OpenPageRequest = { url: string; ts: number };

export function freshOpenPage(meta: Record<string, any>, nowMs: number): string {
    const req = meta?.[OpenPageMetaKey] as OpenPageRequest;
    if (req == null || typeof req !== "object" || typeof req.url !== "string" || typeof req.ts !== "number") {
        return null;
    }
    const age = nowMs - req.ts;
    if (age < -OpenPageFreshMs || age > OpenPageFreshMs || !canReopenPage(req.url)) {
        return null;
    }
    return req.url;
}

export function openPageRequestKey(req: OpenPageRequest): string {
    return req?.url ? `${req.url}:${req.ts}` : "";
}
