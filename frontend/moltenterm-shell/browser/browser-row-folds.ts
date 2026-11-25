// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// How the web page panel's row folds when the panel narrows (#2489, FR-BRW-025 AC4). The folds themselves are container
// queries in browser.css (CSS cannot read a constant), one per step; the widths below are the ones the "⋯" menu tests
// when it opens, and browser-row-folds.test.ts holds the two together. A step folds at and below its width, measured on
// the row's content box, as a container query measures it.
//
//   1. the labels of Share and Open in go, and the connection button's word (their icons stay);
//   2. Share and Open in move into the "⋯", with Copy link, and the test context chip goes;
//   3. Forward and Maximize move into the "⋯";
//   4. Reload, the add-bookmark button (#2531, right after Reload) and the Bookmarks panel button move into the "⋯" last.
//
// Back, Comment, the 360 view button, the command panel trigger, Close and the connection button never fold: the host
// shrinks first (the widths leave it room for the start of its name).

// Each is 28 px above what it was before the add-bookmark button (#2531) took that room from the host's name.
export const FoldLabelsMaxPx = 567;
export const FoldPairMaxPx = 467;
export const FoldNavMaxPx = 427;
export const FoldLastMaxPx = 377;

export type RowFolds = { labels: boolean; pair: boolean; nav: boolean; last: boolean };

export function rowFoldsAt(width: number): RowFolds {
    return {
        labels: width <= FoldLabelsMaxPx,
        pair: width <= FoldPairMaxPx,
        nav: width <= FoldNavMaxPx,
        last: width <= FoldLastMaxPx,
    };
}

export type MenuPart =
    | "forward"
    | "maximize"
    | "reload"
    | "bookmarkPage"
    | "bookmarks"
    | "copyLink"
    | "share"
    | "engine";

// What the row folded into its "⋯" at this width, in the order the menu lists it. Nothing while the "⋯" is not shown.
export function menuPartsAt(width: number): MenuPart[] {
    const folds = rowFoldsAt(width);
    if (!folds.pair) {
        return [];
    }
    const parts: MenuPart[] = [];
    if (folds.nav) {
        parts.push("forward");
    }
    if (folds.last) {
        parts.push("reload", "bookmarkPage");
    }
    if (folds.nav) {
        parts.push("maximize");
    }
    parts.push("copyLink");
    if (folds.last) {
        parts.push("bookmarks");
    }
    parts.push("share", "engine");
    return parts;
}
