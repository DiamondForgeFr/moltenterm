// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What changes a folder of views (FR-SHELL-080, #2484), apart from the window and loaded on demand with the folders' row
// and grid and the operations (NFR-PERF-003: the startup bundle holds only what the Views list needs to draw, in
// view-folders-model.ts): making, filling, emptying, renaming and reordering folders, the workspace's tab order they
// ask for, and how a folder is named from its content.

import { cleanFolderName, dissolveSmall, folderOf, ViewFolder } from "./view-folders-model";

// A view dropped on another, or on a folder: the folders after it. Dropping on a view makes a folder of the two, the
// target first; dropping on a folder adds the view at its end. The dragged view leaves the folder it was in; one left
// with a single view dissolves. A drop on itself changes nothing.
export function dropOnView(
    folders: readonly ViewFolder[],
    dragged: string,
    target: string,
    newId: string
): ViewFolder[] {
    if (dragged === target) {
        return [...folders];
    }
    const targetFolder = folderOf(folders, target);
    if (targetFolder != null) {
        return addToFolder(folders, targetFolder.id, dragged);
    }
    const without = folders.map((f) => ({ ...f, tabids: f.tabids.filter((id) => id !== dragged) }));
    return dissolveSmall([...without, { id: newId, name: "", tabids: [target, dragged] }]);
}

export function addToFolder(
    folders: readonly ViewFolder[],
    folderId: string,
    tabId: string,
    at?: number
): ViewFolder[] {
    if (!folders.some((f) => f.id === folderId)) {
        return [...folders];
    }
    const next = folders.map((f) => {
        const rest = f.tabids.filter((id) => id !== tabId);
        if (f.id !== folderId) {
            return { ...f, tabids: rest };
        }
        const index = at == null ? rest.length : Math.max(0, Math.min(rest.length, at));
        return { ...f, tabids: [...rest.slice(0, index), tabId, ...rest.slice(index)] };
    });
    return dissolveSmall(next);
}

export function takeOut(folders: readonly ViewFolder[], tabId: string): ViewFolder[] {
    return dissolveSmall(folders.map((f) => ({ ...f, tabids: f.tabids.filter((id) => id !== tabId) })));
}

export function dissolveFolder(folders: readonly ViewFolder[], folderId: string): ViewFolder[] {
    return folders.filter((f) => f.id !== folderId);
}

// The developer's name for a folder; empty gives the name back to the content.
export function renameFolder(folders: readonly ViewFolder[], folderId: string, name: string): ViewFolder[] {
    const clean = cleanFolderName(name);
    return folders.map((f) => (f.id === folderId ? { ...f, name: clean } : f));
}

// A view one place earlier (-1) or later (+1) inside its folder.
export function moveInFolder(
    folders: readonly ViewFolder[],
    folderId: string,
    tabId: string,
    delta: number
): ViewFolder[] {
    return folders.map((f) => {
        const from = f.tabids.indexOf(tabId);
        if (f.id !== folderId || from < 0) {
            return f;
        }
        const to = Math.max(0, Math.min(f.tabids.length - 1, from + delta));
        if (to === from) {
            return f;
        }
        const rest = f.tabids.filter((id) => id !== tabId);
        return { ...f, tabids: [...rest.slice(0, to), tabId, ...rest.slice(to)] };
    });
}

// The workspace's tab order once a folder's views move together: they leave their places and land side by side, in the
// order they already have, before target (null: after every tab of the list's end, at the end of the order).
export function moveRunBefore(order: readonly string[], run: readonly string[], target: string): string[] {
    const members = new Set(run);
    if (target != null && members.has(target)) {
        return [...order];
    }
    const moving = order.filter((id) => members.has(id));
    const rest = order.filter((id) => !members.has(id));
    const at = target == null ? -1 : rest.indexOf(target);
    if (at < 0) {
        return [...rest, ...moving];
    }
    return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

// The workspace's tab order once a view lands right after the last of the given tabs: where a view taken out of a
// folder lands when it is released with no row to choose from. After the last one of them in the order.
export function moveAfterLast(order: readonly string[], tabId: string, among: readonly string[]): string[] {
    const rest = order.filter((id) => id !== tabId);
    const last = Math.max(-1, ...among.filter((id) => id !== tabId).map((id) => rest.indexOf(id)));
    if (last < 0) {
        return [...order];
    }
    return [...rest.slice(0, last + 1), tabId, ...rest.slice(last + 1)];
}

// What kind of view a folder's view is, for the folder's derived name: only its first panel counts, as for its icon.
export type ViewKind = "review" | "terminal" | "files" | "web" | "agent" | "other";
export type ViewKindFact = { kind: ViewKind; host?: string };

const ReviewViews = new Set(["molten-review", "molten-reviews"]);
const WebViews = new Set(["web", "molten-browser"]);
const PullRequestPath = /\/pulls?(\/|$)/;

// A pull request page is a review whatever panel shows it.
export function isPullRequestUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return PullRequestPath.test(u.pathname);
    } catch {
        return false;
    }
}

// view: the first panel's view type; url: the page it shows now; host: that page's site (its registrable domain).
export function viewKindOf(view: string, url: string, hasAgent: boolean, host = ""): ViewKindFact {
    if (hasAgent) {
        return { kind: "agent" };
    }
    if (ReviewViews.has(view)) {
        return { kind: "review" };
    }
    if (view === "term") {
        return { kind: "terminal" };
    }
    if (view === "preview") {
        return { kind: "files" };
    }
    if (WebViews.has(view)) {
        if (isPullRequestUrl(url ?? "")) {
            return { kind: "review" };
        }
        return { kind: "web", host };
    }
    return { kind: "other" };
}

// The name a folder shows while the developer has not named it: a key under sidebar.folders.name, and the site when it
// is the site's.
export type DerivedFolderName = {
    key: "review" | "terminals" | "files" | "agents" | "pages" | "site" | "mixed";
    site?: string;
};

export function derivedFolderName(facts: readonly ViewKindFact[]): DerivedFolderName {
    const first = facts[0];
    if (first == null || facts.some((f) => f.kind !== first.kind)) {
        return { key: "mixed" };
    }
    switch (first.kind) {
        case "review":
            return { key: "review" };
        case "terminal":
            return { key: "terminals" };
        case "files":
            return { key: "files" };
        case "agent":
            return { key: "agents" };
        case "web": {
            const host = first.host ?? "";
            if (host !== "" && facts.every((f) => f.host === host)) {
                return { key: "site", site: host };
            }
            return { key: "pages" };
        }
        default:
            return { key: "mixed" };
    }
}

// An agent in one of these states is news for the view that holds it.
const NewsAgentStates = new Set(["waiting", "done", "error"]);

// A view has news when it carries a badge, or an agent in it waits, ended or failed: the folder that holds it shows a
// dot.
export function viewHasNews(badges: number, agentStates: readonly string[]): boolean {
    return badges > 0 || agentStates.some((state) => NewsAgentStates.has(state));
}

// The name a folder's row and grid show: the developer's, else the one its content gives.
export function folderShownName(
    folder: ViewFolder,
    kinds: readonly ViewKindFact[],
    t: (key: string) => string
): string {
    if (folder.name !== "") {
        return folder.name;
    }
    const derived = derivedFolderName(kinds);
    return derived.key === "site" ? derived.site : t(`sidebar.folders.name.${derived.key}`);
}
