// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The merges the Reviews list knows before GitHub is read again (#898): a PR MoltenTerm merged (the Validate sheet, each
// batch step) leaves the list to review at once and shows in Recently merged; a PR the collector's read lists as merged
// leaves it too, even when the open PRs it read came from an older cache. Everything that reads the list (the rows, the
// rail's counts, the keyboard's walk, the merge order) goes through withLocalMerges.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { t } from "../i18n/i18n";
import { MergedDays, type ReviewMergedPr } from "./reviews-merged-model";
import type { ReviewsAnswer } from "./reviews-model";

const DayMs = 24 * 60 * 60 * 1000;

export type LocalMerge = {
    number: number;
    // ms since the epoch: when this window learnt it, and when the PR merged (0: unknown)
    at: number;
    mergedat?: number;
    base?: string;
    oid?: string;
    title?: string;
    url?: string;
    branch?: string;
    ticket?: number;
    // merged by MoltenTerm, not elsewhere (a Validate refused on a PR merged away)
    byyou?: boolean;
    // merged by the merge queue (#1123): "group" when the group merge put it there, "queue" when a Validate did.
    byqueue?: "group" | "queue";
};

// By mergeKey.
export type LocalMerges = Record<string, LocalMerge>;

// What is known of a PR's merge, for an open Review tab (#898).
export type KnownMerge = { at?: number; by?: string; byyou?: boolean; base?: string; oid?: string };

// mergedByQueueText: what a Recently merged row says of a PR the merge queue merged (#1123), "" otherwise.
export function mergedByQueueText(byqueue: LocalMerge["byqueue"]): string {
    if (byqueue === "group") {
        return t("reviews.merged.byGroup");
    }
    if (byqueue === "queue") {
        return t("reviews.merged.byQueue");
    }
    return "";
}

export function mergeKey(dir: string, number: number): string {
    return `${dir}#${number}`;
}

export class ReviewsMerges {
    private static instance: ReviewsMerges = null;

    mergesAtom = atom({}) as PrimitiveAtom<LocalMerges>;

    private constructor() {}

    static getInstance(): ReviewsMerges {
        if (ReviewsMerges.instance == null) {
            ReviewsMerges.instance = new ReviewsMerges();
        }
        return ReviewsMerges.instance;
    }

    static resetInstance(): void {
        ReviewsMerges.instance = null;
    }

    // note records a merge once; a later note fills what the first one lacked (a merge commit, a time).
    note(dir: string, merge: Omit<LocalMerge, "at">) {
        if (!dir || !(merge?.number > 0)) {
            return;
        }
        const key = mergeKey(dir, merge.number);
        const merges = globalStore.get(this.mergesAtom);
        const known = merges[key];
        if (
            known != null &&
            (known.oid || !merge.oid) &&
            (known.mergedat || !merge.mergedat) &&
            (known.byqueue || !merge.byqueue)
        ) {
            return;
        }
        globalStore.set(this.mergesAtom, {
            ...merges,
            [key]: { ...known, ...dropEmpty(merge), at: known?.at ?? Date.now() },
        });
    }

    isMerged(dir: string, number: number): boolean {
        return globalStore.get(this.mergesAtom)[mergeKey(dir, number)] != null;
    }
}

function dropEmpty<T extends object>(value: T): Partial<T> {
    const rtn: Partial<T> = {};
    for (const [k, v] of Object.entries(value)) {
        if (v != null && v !== "") {
            (rtn as any)[k] = v;
        }
    }
    return rtn;
}

function localMergesOf(dir: string, merges: LocalMerges): LocalMerge[] {
    const prefix = `${dir}#`;
    return Object.entries(merges ?? {})
        .filter(([key]) => key.startsWith(prefix))
        .map(([, merge]) => merge);
}

// mergedNumbers: the PRs of the answer's project known merged, here or in the answer's own Recently merged.
export function mergedNumbers(answer: ReviewsAnswer, merges: LocalMerges): Set<number> {
    const rtn = new Set<number>();
    if (answer == null) {
        return rtn;
    }
    for (const pr of answer.merged ?? []) {
        rtn.add(pr.number);
    }
    for (const merge of localMergesOf(answer.dir, merges)) {
        rtn.add(merge.number);
    }
    return rtn;
}

function isoOf(at: number): string {
    return at > 0 ? new Date(at).toISOString() : "";
}

function mergedPrOf(merge: LocalMerge, target: string): ReviewMergedPr {
    return {
        number: merge.number,
        title: merge.title ?? "",
        url: merge.url ?? "",
        branch: merge.branch ?? "",
        base: merge.base || target || "",
        mergedat: isoOf(merge.mergedat || merge.at),
        mergeoid: merge.oid,
        ticket: merge.ticket,
    };
}

// withLocalMerges is the answer the list shows: without the PRs known merged, and with this window's merges in
// Recently merged until GitHub lists them. The answer itself when nothing changes.
export function withLocalMerges(answer: ReviewsAnswer, merges: LocalMerges, now = Date.now()): ReviewsAnswer {
    if (answer == null) {
        return answer;
    }
    const merged = mergedNumbers(answer, merges);
    if (merged.size === 0) {
        return answer;
    }
    const ready = answer.ready ?? [];
    const drafts = answer.drafts ?? [];
    const listed = new Set((answer.merged ?? []).map((pr) => pr.number));
    // An old batch run still shown can name merges older than Recently merged's window.
    const since = now - MergedDays * DayMs;
    const added = localMergesOf(answer.dir, merges)
        .filter((m) => !listed.has(m.number) && (m.mergedat || m.at) >= since)
        .map((m) => mergedPrOf(m, answer.target));
    const keptReady = ready.filter((pr) => !merged.has(pr.number));
    const keptDrafts = drafts.filter((pr) => !merged.has(pr.number));
    if (added.length === 0 && keptReady.length === ready.length && keptDrafts.length === drafts.length) {
        return answer;
    }
    const newest = (a: ReviewMergedPr, b: ReviewMergedPr) =>
        a.mergedat < b.mergedat ? 1 : a.mergedat > b.mergedat ? -1 : 0;
    return {
        ...answer,
        ready: keptReady,
        drafts: keptDrafts,
        merged: added.length === 0 ? answer.merged : [...added, ...(answer.merged ?? [])].sort(newest),
    };
}

// knownMerge is what the list and this window know of a PR's merge, null when neither says it merged.
export function knownMerge(answer: ReviewsAnswer, merges: LocalMerges, dir: string, number: number): KnownMerge {
    const local = merges?.[mergeKey(dir, number)];
    const listed = answer?.dir === dir ? (answer.merged ?? []).find((pr) => pr.number === number) : null;
    if (local == null && listed == null) {
        return null;
    }
    const listedAt = Date.parse(listed?.mergedat ?? "");
    return {
        at: Number.isNaN(listedAt) ? local?.mergedat || local?.at : listedAt,
        by: listed?.mergedby,
        byyou: local?.byyou ?? false,
        base: listed?.base || local?.base,
        oid: listed?.mergeoid || local?.oid,
    };
}
