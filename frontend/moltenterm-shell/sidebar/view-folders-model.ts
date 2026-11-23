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

// The first tab of a folder in the list's order: the row of the list that stands for it, and the tab a view dropped
// before the folder lands before.
export function folderAnchor(visible: readonly string[], members: readonly string[]): string {
    const set = new Set(members);
    return visible.find((id) => set.has(id)) ?? null;
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
