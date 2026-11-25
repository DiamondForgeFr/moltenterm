// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The rules of the column panel of the bookmarks (FR-BRW-019, #2531, mockup section 3), apart from any component: which
// columns a selection shows, how many fit, how the path shrinks, how a search lists the bookmarks, and what a drop does.
// A column shows what one place holds: its folders, its bookmarks, then its child places under a heading; a folder
// shows its bookmarks in the next column. The first column is the app's.

import {
    Bookmark,
    BookmarkFolder,
    BookmarkStore,
    bookmarksAt,
    foldersAt,
    Here,
    LevelApp,
    LevelContext,
    LevelProject,
    LevelWorkspace,
    PlaceLevel,
    PlaceRef,
    placeKey,
    refsHere,
    sameRef,
} from "./bookmarks";
import { chainOf, childrenOf, matchRun, nodeOf, PlaceCatalog, PlaceNode } from "./bookmark-places";

export const MaxColumns = 3;
// About what a column needs to stay readable.
export const ColumnMinPx = 180;
export const PanelDefaultPx = 640;
export const PanelMinPx = 360;
export const PanelMaxPx = 960;

// What the panel has chosen: the places below the app, widest first, and a folder of the last one when one is open.
export type PanelSelection = { path: PlaceRef[]; folder: string };

export const AppSelection: PanelSelection = { path: [], folder: "" };

// The panel opens on the current place: the chain of here that the catalog knows, down to the project or the workspace.
export function selectionOfHere(catalog: PlaceCatalog, here: Here): PanelSelection {
    const path = refsHere(here)
        .filter((r) => r.level !== LevelApp)
        .filter((r) => nodeOf(catalog, r) != null);
    return { path, folder: "" };
}

// The place a selection ends on: the app when nothing below it is chosen.
export function deepestRef(selection: PanelSelection): PlaceRef {
    return selection.path[selection.path.length - 1] ?? { level: LevelApp, id: "" };
}

// The selection that lands on a place (and one of its folders): the chain of places above it, then it.
export function selectionOfPlace(catalog: PlaceCatalog, ref: PlaceRef, folder: string): PanelSelection {
    const path = chainOf(catalog, ref)
        .filter((n) => n.ref.level !== LevelApp)
        .map((n) => n.ref);
    return { path, folder };
}

export type ColumnItem =
    | { kind: "folder"; key: string; folder: BookmarkFolder; ref: PlaceRef; count: number; selected: boolean }
    | { kind: "bookmark"; key: string; bookmark: Bookmark; ref: PlaceRef; folder: string }
    | { kind: "heading"; key: string; level: PlaceLevel }
    | { kind: "node"; key: string; node: PlaceNode; count: number; selected: boolean; here: boolean };

// One column: the place it shows and, for a folder column, the folder.
export type Column = { key: string; ref: PlaceRef; folder: string; items: ColumnItem[] };

function nodeItems(
    store: BookmarkStore,
    catalog: PlaceCatalog,
    node: PlaceNode,
    chosen: PlaceRef,
    hereRefs: readonly PlaceRef[]
): ColumnItem[] {
    const kids = childrenOf(catalog, node);
    if (kids.length === 0) {
        return [];
    }
    return [
        { kind: "heading", key: `h:${node.key}`, level: kids[0].ref.level },
        ...kids.map(
            (kid): ColumnItem => ({
                kind: "node",
                key: kid.key,
                node: kid,
                count: store.records.filter((b) => b.places.some((p) => sameRef(p, kid.ref))).length,
                selected: chosen != null && sameRef(chosen, kid.ref),
                here: hereRefs.some((r) => sameRef(r, kid.ref)),
            })
        ),
    ];
}

// The columns of a selection: the app's, then one per chosen place, then the open folder's. The deepest chosen place's own
// children are listed in its column, so a place with nothing below it ends the chain.
export function panelColumns(
    store: BookmarkStore,
    catalog: PlaceCatalog,
    selection: PanelSelection,
    here: Here
): Column[] {
    // The dot says where the window stands: its workspace and its project. The context and the app only group.
    const hereRefs = refsHere(here).filter((r) => r.level === LevelWorkspace || r.level === LevelProject);
    const chain: PlaceRef[] = [{ level: LevelApp, id: "" }, ...selection.path];
    const columns: Column[] = chain.map((ref, i) => {
        const node = nodeOf(catalog, ref);
        const chosen = selection.path[i] ?? null;
        const openFolder = i === chain.length - 1 ? selection.folder : "";
        const folders = foldersAt(store, ref).map(
            (folder): ColumnItem => ({
                kind: "folder",
                key: `f:${placeKey(ref)}:${folder.id}`,
                folder,
                ref,
                count: bookmarksAt(store, ref, folder.id).length,
                selected: openFolder === folder.id,
            })
        );
        const marks = bookmarksAt(store, ref, "").map(
            (bookmark): ColumnItem => ({
                kind: "bookmark",
                key: `b:${placeKey(ref)}:${bookmark.id}`,
                bookmark,
                ref,
                folder: "",
            })
        );
        return {
            key: placeKey(ref),
            ref,
            folder: "",
            items: [...folders, ...marks, ...(node == null ? [] : nodeItems(store, catalog, node, chosen, hereRefs))],
        };
    });
    if (selection.folder !== "") {
        const ref = deepestRef(selection);
        columns.push({
            key: `${placeKey(ref)}#${selection.folder}`,
            ref,
            folder: selection.folder,
            items: bookmarksAt(store, ref, selection.folder).map(
                (bookmark): ColumnItem => ({
                    kind: "bookmark",
                    key: `b:${placeKey(ref)}:${selection.folder}:${bookmark.id}`,
                    bookmark,
                    ref,
                    folder: selection.folder,
                })
            ),
        });
    }
    return columns;
}

// How many columns fit in a panel of this width: at most three, fewer when narrow.
export function columnCapacity(widthPx: number): number {
    return Math.max(1, Math.min(MaxColumns, Math.floor((widthPx || 0) / ColumnMinPx)));
}

// The last columns that fit; the higher levels stay in the path.
export function visibleColumns(columns: readonly Column[], capacity: number): Column[] {
    return columns.slice(Math.max(0, columns.length - capacity));
}

export type Crumb = { key: string; name: string; selection: PanelSelection };

// The path above the columns: the app, each chosen place, then the open folder.
export function pathCrumbs(
    catalog: PlaceCatalog,
    selection: PanelSelection,
    folderName: (ref: PlaceRef, id: string) => string
): Crumb[] {
    const crumbs: Crumb[] = [{ key: "app", name: catalog.app.name, selection: AppSelection }];
    selection.path.forEach((ref, i) => {
        crumbs.push({
            key: placeKey(ref),
            name: nodeOf(catalog, ref)?.name ?? "",
            selection: { path: selection.path.slice(0, i + 1), folder: "" },
        });
    });
    if (selection.folder !== "") {
        crumbs.push({
            key: `folder:${selection.folder}`,
            name: folderName(deepestRef(selection), selection.folder),
            selection,
        });
    }
    return crumbs;
}

// The path that never overflows: when the names do not fit the room (in characters), the middle goes ("Whole app › … ›
// site-web") and the hidden crumbs stay behind the "…". The first and the last always show, and as many of the last
// ones as fit.
export function shrinkCrumbs(crumbs: readonly Crumb[], room: number): { shown: Crumb[]; hidden: Crumb[]; folded: boolean } {
    const separator = 3;
    const width = (list: readonly Crumb[]) => list.reduce((sum, c) => sum + c.name.length + separator, 0);
    if (crumbs.length <= 2 || width(crumbs) <= room) {
        return { shown: [...crumbs], hidden: [], folded: false };
    }
    const first = crumbs[0];
    const tail: Crumb[] = [crumbs[crumbs.length - 1]];
    let used = width([first]) + separator + width(tail);
    for (let i = crumbs.length - 2; i >= 1; i--) {
        const more = crumbs[i].name.length + separator;
        if (used + more > room) {
            break;
        }
        tail.unshift(crumbs[i]);
        used += more;
    }
    const hidden = crumbs.slice(1, crumbs.length - tail.length);
    return { shown: [first, ...tail], hidden, folded: hidden.length > 0 };
}

// One step up: out of the open folder, else out of the deepest chosen place.
export function selectionUp(selection: PanelSelection): PanelSelection {
    if (selection.folder !== "") {
        return { path: selection.path, folder: "" };
    }
    return { path: selection.path.slice(0, -1), folder: "" };
}

// Choosing a place in a column: the places above it stay, the ones below it go.
export function chooseNode(selection: PanelSelection, columnIndex: number, node: PlaceRef): PanelSelection {
    return { path: [...selection.path.slice(0, columnIndex), node], folder: "" };
}

export function chooseFolder(selection: PanelSelection, columnIndex: number, folderId: string): PanelSelection {
    return { path: selection.path.slice(0, columnIndex), folder: folderId };
}

// Where a place sits for a bookmark's path: the names above it, as a result of the search shows.
export function bookmarkPaths(catalog: PlaceCatalog, store: BookmarkStore, b: Bookmark): string[] {
    return b.places.map((p) => {
        const names = chainOf(catalog, p).map((n) => n.name);
        const folder = foldersAt(store, p).find((f) => f.id === p.folder)?.name;
        return [...names, ...(folder ? [folder] : [])].join(" › ");
    });
}

export type BookmarkHit = { bookmark: Bookmark; paths: string[]; score: number; positions: number[] };

// The search covers every bookmark of the app: the title first, then the address and the note.
export function searchBookmarks(
    store: BookmarkStore,
    catalog: PlaceCatalog,
    typed: string,
    limit = 60
): BookmarkHit[] {
    if (typed.trim() === "") {
        return [];
    }
    const hits: BookmarkHit[] = [];
    for (const bookmark of store.records) {
        const own = matchRun(bookmark.title, typed);
        const other =
            own == null
                ? (matchRun(bookmark.url, typed) ?? (bookmark.description ? matchRun(bookmark.description, typed) : null))
                : null;
        if (own == null && other == null) {
            continue;
        }
        hits.push({
            bookmark,
            paths: bookmarkPaths(catalog, store, bookmark),
            score: own != null ? own.score : other.score - 50,
            positions: own?.positions ?? [],
        });
    }
    hits.sort((a, b) => b.score - a.score || a.bookmark.title.localeCompare(b.bookmark.title));
    return hits.slice(0, limit);
}

// What dropping a bookmark on a target does: it moves from the place it was dragged out of, or with Alt it is also placed
// there and stays where it was. Dropping where it already is changes nothing.
export type DropAction =
    | { kind: "move"; id: string; from: PlaceRef; to: PlaceRef; folder: string }
    | { kind: "place"; id: string; to: PlaceRef; folder: string }
    | { kind: "none" };

export function dropAction(
    store: BookmarkStore,
    drag: { id: string; from: PlaceRef },
    target: { ref: PlaceRef; folder: string },
    alt: boolean
): DropAction {
    const bookmark = store.records.find((b) => b.id === drag.id);
    if (bookmark == null) {
        return { kind: "none" };
    }
    const there = bookmark.places.find((p) => sameRef(p, target.ref));
    if (there != null && there.folder === target.folder && (alt || sameRef(drag.from, target.ref))) {
        return { kind: "none" };
    }
    if (alt) {
        return { kind: "place", id: drag.id, to: target.ref, folder: target.folder };
    }
    return { kind: "move", id: drag.id, from: drag.from, to: target.ref, folder: target.folder };
}

// What the context menus act on: a column's place and folder.
export type PasteMode = "cut" | "copy";
export type BookmarkClip = { id: string; mode: PasteMode; from: PlaceRef };

export function levelHeadingKey(level: PlaceLevel): string {
    switch (level) {
        case LevelContext:
            return "browser.bookmarks.panel.contexts";
        case LevelWorkspace:
            return "browser.bookmarks.panel.workspaces";
        case LevelProject:
            return "browser.bookmarks.panel.projects";
        default:
            return "browser.bookmarks.panel.contexts";
    }
}
