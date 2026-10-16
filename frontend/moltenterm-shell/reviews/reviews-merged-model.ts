// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's Recently merged (#843): the PRs merged into the target lately, from the collector's GitHub read,
// with where each one ships, read by wavesrv from the project's git (pkg/molten/mission/reviews_merged.go). The
// collapsed or expanded section is remembered on this computer.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { t } from "../i18n/i18n";
import type { ReviewNote } from "../review/review-notes";
import type { AgentSignature } from "./reviews-model";

// must match ReviewMergedDays in pkg/molten/mission/reviews_merged.go
export const MergedDays = 7;

// must match the ReviewShips… constants in pkg/molten/mission/reviews_merged.go
export type MergedShips = "" | "tag" | "branch" | "next";

// must match ReviewMergedPr in pkg/molten/mission/reviews_merged.go
export type ReviewMergedPr = {
    number: number;
    title: string;
    url: string;
    branch: string;
    base: string;
    author?: string;
    mergedat: string;
    mergedby?: string;
    mergeoid?: string;
    ticket?: number;
    ticketfrom?: "closing" | "branch";
    ships?: MergedShips;
    shipsin?: string;
    // from the body's signature block (#847): the last agent first, and the developer's validation
    agents?: AgentSignature[];
    reviewed?: { name: string; date: string; url?: string };
};

export type ShipsLabel = { label: string; tone: "success" | "neutral"; title: string };

// shipsLabel says where a merged PR ships; null while git has not answered (or lacks the commit).
export function shipsLabel(pr: ReviewMergedPr): ShipsLabel {
    switch (pr.ships) {
        case "tag":
            return {
                label: t("reviews.merged.shipsTag", { tag: pr.shipsin }),
                tone: "success",
                title: t("reviews.merged.shipsTagTitle", { tag: pr.shipsin }),
            };
        case "branch":
            return {
                label: t("reviews.merged.shipsBranch", { branch: pr.shipsin }),
                tone: "neutral",
                title: t("reviews.merged.shipsBranchTitle", { branch: pr.shipsin }),
            };
        case "next":
            return {
                label: t("reviews.merged.shipsNext"),
                tone: "neutral",
                title: t("reviews.merged.shipsNextTitle"),
            };
    }
    return null;
}

// notesByPr counts the review notes kept on each PR, so a merged row offers them.
export function notesByPr(notes: readonly ReviewNote[]): Record<number, number> {
    const rtn: Record<number, number> = {};
    for (const note of notes ?? []) {
        const n = note.pr?.number;
        if (n > 0) {
            rtn[n] = (rtn[n] ?? 0) + 1;
        }
    }
    return rtn;
}

export const MergedOpenStorageKey = "moltenterm:reviews:mergedopen";

function readOpen(): boolean {
    try {
        return globalThis.localStorage?.getItem(MergedOpenStorageKey) !== "closed";
    } catch {
        return true;
    }
}

// Whether Recently merged is expanded (AC2), shared by the windows of this computer; expanded when storage fails.
export class MergedOpenPref {
    private static instance: MergedOpenPref = null;

    openAtom = atom(readOpen()) as PrimitiveAtom<boolean>;

    private constructor() {
        globalThis.addEventListener?.("storage", (e: StorageEvent) => {
            if (e.key === MergedOpenStorageKey) {
                globalStore.set(this.openAtom, readOpen());
            }
        });
    }

    static getInstance(): MergedOpenPref {
        if (MergedOpenPref.instance == null) {
            MergedOpenPref.instance = new MergedOpenPref();
        }
        return MergedOpenPref.instance;
    }

    static resetInstance(): void {
        MergedOpenPref.instance = null;
    }

    set(open: boolean) {
        globalStore.set(this.openAtom, open);
        try {
            globalThis.localStorage?.setItem(MergedOpenStorageKey, open ? "open" : "closed");
        } catch {
            // The choice still holds for this session.
        }
    }
}
