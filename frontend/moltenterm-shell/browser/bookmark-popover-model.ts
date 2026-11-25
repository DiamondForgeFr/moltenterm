// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The rules of the bookmark popover that the component only draws (FR-BRW-019, #2531, mockup sections 2, 2 bis and 2 ter):
// where a new bookmark goes, which rows the places block lists and what each toggle does, and what the place finder
// offers for what was typed, with the keys that move in it.

import {
    Bookmark,
    bookmarkablePage,
    BookmarkDraft,
    BookmarkStore,
    Here,
    isAt,
    LevelProject,
    LevelWorkspace,
    pageState,
    PlaceRef,
    projectPlaceId,
    refsHere,
    sameRef,
} from "./bookmarks";
import type { Applied } from "./bookmarks-store";
import { nearHere, PlaceCatalog, PlaceNode, recentNodes, searchPlaces } from "./bookmark-places";

// What the popover shows: section 2 for a bookmark (just added, or opened from the add button's filled state), section 2 bis
// for a page bookmarked only at places that are not visible from here, or the reason a page could not be bookmarked.
export type PopoverRequest =
    | { kind: "bookmark"; id: string; fresh: boolean; initial?: Bookmark }
    | { kind: "elsewhere"; id: string }
    | { kind: "problem"; problem: string };

export type AddFlowInput = {
    store: BookmarkStore;
    here: Here;
    url: string;
    title: string;
    add: (draft: BookmarkDraft, ref: PlaceRef) => Promise<Applied<Bookmark>>;
};

// A click on the add button: a page that is a bookmark here opens it, a page bookmarked only elsewhere asks whether to place
// it here or copy it (never a silent duplicate), and any other page is bookmarked at once at the default place. null for a
// page that cannot be bookmarked (the start page, a page that is not http or https).
export async function addFlow(input: AddFlowInput): Promise<PopoverRequest> {
    const page = bookmarkablePage(input.url);
    if (page === "") {
        return null;
    }
    const state = pageState(input.store, input.here, page);
    if (state.kind === "here") {
        return { kind: "bookmark", id: state.bookmark.id, fresh: false };
    }
    if (state.kind === "elsewhere") {
        return { kind: "elsewhere", id: state.bookmark.id };
    }
    const added = await input.add({ url: input.url, title: input.title, description: "" }, defaultPlace(input.here));
    if (added.problem != null) {
        return { kind: "problem", problem: added.problem };
    }
    return { kind: "bookmark", id: added.result.id, fresh: true, initial: added.result };
}

// A new bookmark goes to the tab's project, or to the workspace when none is linked: the places of the project's own
// bookmarks before places existed, and the narrowest place that is always there.
export function defaultPlace(here: Here): PlaceRef {
    if (here.workspaceId && here.projectId) {
        return { level: LevelProject, id: projectPlaceId(here.workspaceId, here.projectId) };
    }
    return { level: LevelWorkspace, id: here.workspaceId };
}

export type PlaceRow = {
    ref: PlaceRef;
    checked: boolean;
    // A place of the bookmark that is not one of the levels of here: it shows as a checked row with its path.
    elsewhere: boolean;
    folder: string;
};

// The rows of the places block: the levels of here, checked or not, then the other places the bookmark is at.
export function placeRows(b: Bookmark, here: Here): PlaceRow[] {
    const refs = refsHere(here);
    const rows: PlaceRow[] = refs.map((ref) => {
        const place = b.places.find((p) => sameRef(p, ref));
        return { ref, checked: place != null, elsewhere: false, folder: place?.folder ?? "" };
    });
    for (const place of b.places) {
        if (!refs.some((r) => sameRef(r, place))) {
            rows.push({ ref: { level: place.level, id: place.id }, checked: true, elsewhere: true, folder: place.folder });
        }
    }
    return rows;
}

export type ToggleAction = { kind: "place" } | { kind: "unplace" } | { kind: "removeEverywhere" };

// Checking places the same bookmark; unchecking takes it off that place only, and off the last one it deletes it (a
// bookmark with no place would be seen nowhere).
export function toggleAction(b: Bookmark, ref: PlaceRef, checked: boolean): ToggleAction {
    if (checked) {
        return { kind: "place" };
    }
    if (isAt(b, ref) && b.places.length <= 1) {
        return { kind: "removeEverywhere" };
    }
    return { kind: "unplace" };
}

export type FinderGroup = "results" | "near" | "recent";
export type FinderItem = { node: PlaceNode; positions: number[]; there: boolean; group: FinderGroup };

// What the finder lists: with nothing typed, the places near here, then the recent ones not already listed; with a text,
// what it finds in every context, workspace and project. A place the bookmark is already at is listed, marked.
export function finderItems(
    catalog: PlaceCatalog,
    here: Here,
    b: Bookmark,
    typed: string,
    recentKeys: readonly string[]
): FinderItem[] {
    const there = (node: PlaceNode) => isAt(b, node.ref);
    if (typed.trim() !== "") {
        return searchPlaces(catalog, typed).map((m) => ({
            node: m.node,
            positions: m.positions,
            there: there(m.node),
            group: "results" as const,
        }));
    }
    const near = nearHere(catalog, here);
    const seen = new Set(near.map((n) => n.key));
    const recent = recentNodes(catalog, recentKeys).filter((n) => !seen.has(n.key));
    return [
        ...near.map((node) => ({ node, positions: [] as number[], there: there(node), group: "near" as const })),
        ...recent.map((node) => ({ node, positions: [] as number[], there: there(node), group: "recent" as const })),
    ];
}

// ↑ ↓ move through the list (wrapping), Home and End jump; -1 when the key is not one of them.
export function nextFinderIndex(key: string, index: number, count: number): number {
    if (count === 0) {
        return -1;
    }
    switch (key) {
        case "ArrowDown":
            return index < 0 ? 0 : (index + 1) % count;
        case "ArrowUp":
            return index < 0 ? count - 1 : (index - 1 + count) % count;
        case "Home":
            return 0;
        case "End":
            return count - 1;
        default:
            return -1;
    }
}
