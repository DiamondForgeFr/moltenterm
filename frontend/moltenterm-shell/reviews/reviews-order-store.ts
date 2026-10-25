// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The developer's sort of the Reviews panel (FR-REV-001 AC13, #1061; FR-REV-024 AC-5): by state, or by the suggested
// merge order, remembered on this computer and shared by its windows. Storage may be unavailable: by state then.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import type { ReviewsSort } from "./reviews-sections-model";

export const ReviewsSortStorageKey = "moltenterm:reviews:sort";

function readSort(): ReviewsSort {
    try {
        return globalThis.localStorage?.getItem(ReviewsSortStorageKey) === "merge" ? "merge" : "state";
    } catch {
        return "state";
    }
}

export class ReviewsSortPref {
    private static instance: ReviewsSortPref = null;

    sortAtom = atom(readSort()) as PrimitiveAtom<ReviewsSort>;

    private constructor() {
        globalThis.addEventListener?.("storage", (e: StorageEvent) => {
            if (e.key === ReviewsSortStorageKey) {
                globalStore.set(this.sortAtom, readSort());
            }
        });
    }

    static getInstance(): ReviewsSortPref {
        if (ReviewsSortPref.instance == null) {
            ReviewsSortPref.instance = new ReviewsSortPref();
        }
        return ReviewsSortPref.instance;
    }

    static resetInstance(): void {
        ReviewsSortPref.instance = null;
    }

    set(sort: ReviewsSort) {
        globalStore.set(this.sortAtom, sort);
        try {
            globalThis.localStorage?.setItem(ReviewsSortStorageKey, sort);
        } catch {
            // The choice still holds for this session.
        }
    }
}

// The sections the developer folded or unfolded (#1061), by project and section, for this session: a section they
// never touched follows its default (the bottom sections fold when the panel's content is longer than the panel).
export class ReviewsFolds {
    private static instance: ReviewsFolds = null;

    foldsAtom = atom({}) as PrimitiveAtom<Record<string, boolean>>;

    private constructor() {}

    static getInstance(): ReviewsFolds {
        if (ReviewsFolds.instance == null) {
            ReviewsFolds.instance = new ReviewsFolds();
        }
        return ReviewsFolds.instance;
    }

    static resetInstance(): void {
        ReviewsFolds.instance = null;
    }

    set(dir: string, section: string, open: boolean) {
        globalStore.set(this.foldsAtom, { ...globalStore.get(this.foldsAtom), [`${dir}\n${section}`]: open });
    }
}

// Whether a section is open: the developer's choice this session, else its default.
export function sectionOpen(folds: Record<string, boolean>, dir: string, section: string, byDefault: boolean): boolean {
    return folds?.[`${dir}\n${section}`] ?? byDefault;
}
