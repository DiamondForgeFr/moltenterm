// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Folders of views in the sidebar's Views section (FR-SHELL-080, #2484), as on a phone's home screen: a view dropped
// on another makes a folder of the two, a folder is one row (miniatures, name, count, a dot for news) that opens as a
// grid, a folder left with one view dissolves, and Clear closes only the views outside folders. The folders of a
// workspace live in its meta, next to the views; this file holds the rules, apart from the components, so that they are
// tested without the app.

export const ViewFoldersMetaKey = "molten:viewfolders";
export const MaxFolderNameLength = 40;
// The fewest views a folder keeps: below it the folder dissolves.
export const MinFolderViews = 2;
// The miniatures of a folder's icon.
export const MaxMiniatures = 4;

// name: what the developer typed, "" while the folder is named from its content (derivedFolderName).
export type ViewFolder = { id: string; name: string; tabids: string[] };

export function cleanFolderName(name: unknown): string {
    if (typeof name !== "string") {
        return "";
    }
    return name.replace(/\s+/g, " ").trim().slice(0, MaxFolderNameLength).trim();
}

// The folders a workspace's meta holds, read defensively: a view is in one folder at most (the first that names it),
// a folder keeps its views once, and what is not a folder is dropped.
export function readViewFolders(meta: Record<string, any>): ViewFolder[] {
    const value = meta?.[ViewFoldersMetaKey];
    if (!Array.isArray(value)) {
        return [];
    }
    const folders: ViewFolder[] = [];
    const taken = new Set<string>();
    const ids = new Set<string>();
    for (const item of value) {
        const id = typeof item?.id === "string" ? item.id.trim() : "";
        if (id === "" || ids.has(id) || !Array.isArray(item.tabids)) {
            continue;
        }
        const tabids: string[] = [];
        for (const tabId of item.tabids) {
            if (typeof tabId === "string" && tabId !== "" && !taken.has(tabId)) {
                taken.add(tabId);
                tabids.push(tabId);
            }
        }
        ids.add(id);
        folders.push({ id, name: cleanFolderName(item.name), tabids });
    }
    return folders;
}

export function sameViewFolders(a: readonly ViewFolder[], b: readonly ViewFolder[]): boolean {
    return (
        a.length === b.length &&
        a.every(
            (f, i) =>
                f.id === b[i].id &&
                f.name === b[i].name &&
                f.tabids.length === b[i].tabids.length &&
                f.tabids.every((id, j) => id === b[i].tabids[j])
        )
    );
}

// What a folder is never left with: fewer than MinFolderViews views.
export function dissolveSmall(folders: readonly ViewFolder[]): ViewFolder[] {
    return folders.filter((f) => f.tabids.length >= MinFolderViews);
}

// The folders as they stay once the views that are gone (closed for good) or no longer in the Views section (pinned)
// leave them: live is every view of the workspace that is not pinned, hidden ones included, so a view set aside for its
// Undo keeps its place. A folder left with one view dissolves.
export function pruneViewFolders(folders: readonly ViewFolder[], live: ReadonlySet<string>): ViewFolder[] {
    return dissolveSmall(folders.map((f) => ({ ...f, tabids: f.tabids.filter((id) => live.has(id)) })));
}

export function folderOf(folders: readonly ViewFolder[], tabId: string): ViewFolder {
    return folders.find((f) => f.tabids.includes(tabId)) ?? null;
}

// A row of the Views list: a view, or a folder with the views of it that the list shows.
export type SidebarItem = { kind: "view"; tabId: string } | { kind: "folder"; folder: ViewFolder; members: string[] };

export function itemKey(item: SidebarItem): string {
    return item.kind === "view" ? `tab:${item.tabId}` : `folder:${item.folder.id}`;
}

// The folders the list shows: one with MinFolderViews views or more among the visible ones. One with a single visible
// view (its other view is set aside, or belongs to another project) is not shown, and its view is a row like any other.
export function shownFolders(visible: readonly string[], folders: readonly ViewFolder[]): ViewFolder[] {
    const seen = new Set(visible);
    return folders.filter((f) => f.tabids.filter((id) => seen.has(id)).length >= MinFolderViews);
}

// The Views list, in order: a folder takes the place of its first view in the workspace's order, and its views are no
// longer listed beside it. Its members keep the folder's own order.
export function sidebarItems(visible: readonly string[], folders: readonly ViewFolder[]): SidebarItem[] {
    const seen = new Set(visible);
    const byTab = new Map<string, ViewFolder>();
    for (const folder of shownFolders(visible, folders)) {
        for (const id of folder.tabids) {
            if (seen.has(id)) {
                byTab.set(id, folder);
            }
        }
    }
    const items: SidebarItem[] = [];
    const emitted = new Set<string>();
    for (const tabId of visible) {
        const folder = byTab.get(tabId);
        if (folder == null) {
            items.push({ kind: "view", tabId });
            continue;
        }
        if (emitted.has(folder.id)) {
            continue;
        }
        emitted.add(folder.id);
        items.push({ kind: "folder", folder, members: folder.tabids.filter((id) => seen.has(id)) });
    }
    return items;
}

// The views of the list that Clear closes: those outside folders (FR-SHELL-080).
export function closableViews(visible: readonly string[], folders: readonly ViewFolder[]): string[] {
    const kept = new Set(shownFolders(visible, folders).flatMap((f) => f.tabids));
    return visible.filter((id) => !kept.has(id));
}

// Every view of the folders the list shows, for what must know which views a folder keeps.
export function folderedViews(visible: readonly string[], folders: readonly ViewFolder[]): Set<string> {
    const seen = new Set(visible);
    return new Set(
        shownFolders(visible, folders)
            .flatMap((f) => f.tabids)
            .filter((id) => seen.has(id))
    );
}

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

// The first tab of a folder in the list's order: the row of the list that stands for it, and the tab a view dropped
// before the folder lands before.
export function folderAnchor(visible: readonly string[], members: readonly string[]): string {
    const set = new Set(members);
    return visible.find((id) => set.has(id)) ?? null;
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

// How a drag chooses between reordering and making a folder: held this long over the middle of another row, a view
// rings it and a release there makes (or fills) a folder; anywhere else a release only reorders.
export const FolderDwellMs = 450;
// The middle share of a row's height that rings it; its upper and lower edges are the places between rows.
export const FolderBandShare = 0.5;

export type RowSlot = { key: string; top: number; height: number };

// The row whose middle band the pointer is in, never the dragged one.
export function folderCandidateAt(y: number, slots: readonly RowSlot[], draggedKey: string): string {
    for (const slot of slots) {
        if (slot.key === draggedKey) {
            continue;
        }
        const margin = (slot.height * (1 - FolderBandShare)) / 2;
        if (y >= slot.top + margin && y <= slot.top + slot.height - margin) {
            return slot.key;
        }
    }
    return null;
}

// The dwell of a drag over a row: which row it is on and since when. A move to another row (or to none) starts again.
export type Dwell = { key: string; since: number };

export function nextDwell(prev: Dwell, key: string, now: number): Dwell {
    if (key == null) {
        return null;
    }
    return prev != null && prev.key === key ? prev : { key, since: now };
}

export function dwellDone(dwell: Dwell, now: number, delay = FolderDwellMs): boolean {
    return dwell != null && now - dwell.since >= delay;
}
