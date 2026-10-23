// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The merged history (#960, FR-REV-030): every PR merged into the project's PR target, opened from Recently merged.
// wavesrv reads it from GitHub in pages and keeps it per project (pkg/molten/mission/reviews_history.go); this side
// groups it by the version that ships each PR (by month for a project without release tags), searches and filters it.
// It is not the version history (FR-REL-004), which lists MoltenTerm's own versions: this one belongs to the project.

import { globalStore } from "@/app/store/jotaiStore";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, PrimitiveAtom } from "jotai";
import { MissionRouteId } from "../mission/mission-client";
import type { ReviewMergedPr } from "./reviews-merged-model";

// must match the names in pkg/molten/mission/reviews_history.go
export const MergedHistoryCommand = "moltenmissionmergedhistory";

const MergedHistoryRpcTimeoutMs = 30000;
export const HistoryPageSize = 50;
// While wavesrv reads, the view asks again this often.
export const HistoryPollMs = 1000;

// must match MergedHistoryPr in pkg/molten/mission/reviews_history.go
export type MergedHistoryPr = ReviewMergedPr & {
    updatedat?: string;
    tickettitle?: string;
    ticketurl?: string;
    tickettype?: string;
    milestone?: string;
    reviewers?: string[];
    mergemethod?: "" | "merge" | "linear";
    summary?: string;
    labels?: string[];
    behaviour?: BehaviourChange;
    ticketparents?: HistoryTicketRef[];
};

// must match HistoryTicketRef and BehaviourChange in pkg/molten/mission/reviews_history_ship.go
export type HistoryTicketRef = { number: number; title?: string; url?: string; type?: string };
export type BehaviourChange = { from: "label" | "section" | "breaking"; label?: string; verify?: string };

// must match MergedHistoryAnswer in pkg/molten/mission/reviews_history.go
export type MergedHistoryAnswer = {
    dir: string;
    repo?: string;
    url?: string;
    target?: string;
    prs: MergedHistoryPr[];
    total: number;
    loading?: boolean;
    complete?: boolean;
    cut?: boolean;
    tags: string[];
    tagprefix?: string;
    error?: string;
    at?: number;
};

export function mergedHistoryGet(dir: string, force?: boolean): Promise<MergedHistoryAnswer> {
    return TabRpcClient.wshRpcCall(
        MergedHistoryCommand,
        { dir, force: force || undefined },
        { route: MissionRouteId, timeout: MergedHistoryRpcTimeoutMs }
    );
}

// The last answer of each project, so a history opened again shows at once while wavesrv reads what merged since.
export class MergedHistoryStore {
    private static instance: MergedHistoryStore = null;

    answersAtom = atom({}) as PrimitiveAtom<Record<string, MergedHistoryAnswer>>;

    private constructor() {}

    static getInstance(): MergedHistoryStore {
        if (MergedHistoryStore.instance == null) {
            MergedHistoryStore.instance = new MergedHistoryStore();
        }
        return MergedHistoryStore.instance;
    }

    static resetInstance(): void {
        MergedHistoryStore.instance = null;
    }

    store(answer: MergedHistoryAnswer) {
        if (!answer?.dir) {
            return;
        }
        globalStore.set(this.answersAtom, { ...globalStore.get(this.answersAtom), [answer.dir]: answer });
    }

    async load(dir: string, force?: boolean): Promise<MergedHistoryAnswer> {
        const answer = await mergedHistoryGet(dir, force);
        if (answer?.dir === dir) {
            this.store(answer);
        }
        return answer;
    }
}

export const AllKey = "all";
export const NextKey = "next";
export const UnknownKey = "unknown";

export type HistoryEntry =
    | { kind: "all"; key: string; count: number }
    | { kind: "next"; key: string; count: number }
    | { kind: "tag"; key: string; tag: string; count: number; nested: boolean }
    | { kind: "upcoming"; key: string; base: string }
    | { kind: "month"; key: string; month: string; count: number }
    | { kind: "unknown"; key: string; count: number };

// A tag's version without the prefix, and its release ("1.0.0" for "v1.0.0-6").
function splitTag(tag: string, prefix: string): { base: string; candidate: boolean } {
    const version = prefix && tag.startsWith(prefix) ? tag.slice(prefix.length) : tag;
    const dash = version.indexOf("-");
    return dash < 0 ? { base: version, candidate: false } : { base: version.slice(0, dash), candidate: true };
}

// keyOf is the entry a PR belongs to: the tag that ships it, the next version (the release branch included), the
// month of its merge when the project has no release tag, or unknown (the commit is not in this clone yet).
export function keyOf(pr: MergedHistoryPr, hasTags: boolean): string {
    if (!hasTags) {
        return `month:${(pr.mergedat ?? "").slice(0, 7)}`;
    }
    if (pr.ships === "tag" && pr.shipsin) {
        return `tag:${pr.shipsin}`;
    }
    if (pr.ships === "next" || pr.ships === "branch") {
        return NextKey;
    }
    return UnknownKey;
}

// historyEntries is the left column: All, the next version, then each release newest first with its candidates
// under it (a release not cut yet heads its candidates, as in the version history), then unknown. A project without
// release tags gets its months instead. Counts are those of the PRs shown; entries no PR of the history has are left
// out.
export function historyEntries(
    all: readonly MergedHistoryPr[],
    shown: readonly MergedHistoryPr[],
    tags: readonly string[],
    prefix: string
): HistoryEntry[] {
    const hasTags = (tags ?? []).length > 0;
    const counts = new Map<string, number>();
    for (const pr of shown) {
        const key = keyOf(pr, hasTags);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const present = new Set(all.map((pr) => keyOf(pr, hasTags)));
    const rtn: HistoryEntry[] = [{ kind: "all", key: AllKey, count: shown.length }];
    if (!hasTags) {
        const months = [...present].sort().reverse();
        for (const key of months) {
            rtn.push({ kind: "month", key, month: key.slice("month:".length), count: counts.get(key) ?? 0 });
        }
        return rtn;
    }
    if (present.has(NextKey)) {
        rtn.push({ kind: "next", key: NextKey, count: counts.get(NextKey) ?? 0 });
    }
    // The tags come oldest version first: each release groups its candidates, newest first.
    const groups = new Map<string, { release: string; candidates: string[] }>();
    const order: string[] = [];
    for (const tag of tags) {
        if (!present.has(`tag:${tag}`)) {
            continue;
        }
        const { base, candidate } = splitTag(tag, prefix);
        let group = groups.get(base);
        if (group == null) {
            group = { release: null, candidates: [] };
            groups.set(base, group);
            order.push(base);
        }
        if (candidate) {
            group.candidates.unshift(tag);
        } else {
            group.release = tag;
        }
    }
    for (const base of order.reverse()) {
        const group = groups.get(base);
        const nested = group.candidates.length > 0;
        if (group.release) {
            rtn.push({
                kind: "tag",
                key: `tag:${group.release}`,
                tag: group.release,
                count: counts.get(`tag:${group.release}`) ?? 0,
                nested: false,
            });
        } else if (nested) {
            rtn.push({ kind: "upcoming", key: `upcoming:${base}`, base });
        }
        for (const tag of group.candidates) {
            rtn.push({ kind: "tag", key: `tag:${tag}`, tag, count: counts.get(`tag:${tag}`) ?? 0, nested: true });
        }
    }
    if (present.has(UnknownKey)) {
        rtn.push({ kind: "unknown", key: UnknownKey, count: counts.get(UnknownKey) ?? 0 });
    }
    return rtn;
}

export type HistoryFilters = {
    text: string;
    milestone: string;
    person: string;
    // YYYY-MM-DD, inclusive; "" for none
    from: string;
    to: string;
};

export const NoFilters: HistoryFilters = { text: "", milestone: "", person: "", from: "", to: "" };

export function hasFilters(f: HistoryFilters): boolean {
    return !!(f.text.trim() || f.milestone || f.person || f.from || f.to);
}

// The people a PR names: its author, who merged it, its reviewers and the agents that signed it.
export function peopleOf(pr: MergedHistoryPr): string[] {
    const rtn = [pr.author, pr.mergedby, ...(pr.reviewers ?? [])];
    for (const agent of pr.agents ?? []) {
        rtn.push(agent.firstname, agent.agent);
    }
    return rtn.filter((p) => p != null && p !== "");
}

function mergedDay(pr: MergedHistoryPr): string {
    const d = new Date(pr.mergedat);
    if (Number.isNaN(d.getTime())) {
        return "";
    }
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// matchesText: every word of the search is in the PR; "#123" (or "123") names a ticket or a PR number.
export function matchesText(pr: MergedHistoryPr, text: string): boolean {
    const words = (text ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w !== "");
    if (words.length === 0) {
        return true;
    }
    const hay = [pr.title, pr.tickettitle, pr.branch, pr.milestone, pr.tickettype, pr.shipsin, ...peopleOf(pr)]
        .filter((s) => s)
        .join("\n")
        .toLowerCase();
    return words.every((word) => {
        const num = /^#?(\d+)$/.exec(word);
        if (num) {
            const n = Number(num[1]);
            return pr.number === n || pr.ticket === n;
        }
        return hay.includes(word);
    });
}

export function filterHistory(prs: readonly MergedHistoryPr[], f: HistoryFilters): MergedHistoryPr[] {
    return prs.filter((pr) => {
        if (f.milestone && pr.milestone !== f.milestone) {
            return false;
        }
        if (f.person && !peopleOf(pr).includes(f.person)) {
            return false;
        }
        const day = mergedDay(pr);
        if (f.from && day < f.from) {
            return false;
        }
        if (f.to && day > f.to) {
            return false;
        }
        return matchesText(pr, f.text);
    });
}

export function inEntry(prs: readonly MergedHistoryPr[], key: string, hasTags: boolean): MergedHistoryPr[] {
    if (key === AllKey || key == null) {
        return [...prs];
    }
    return prs.filter((pr) => keyOf(pr, hasTags) === key);
}

// The choices the filters offer, sorted.
export function filterChoices(prs: readonly MergedHistoryPr[]): { milestones: string[]; people: string[] } {
    const milestones = new Set<string>();
    const people = new Set<string>();
    for (const pr of prs) {
        if (pr.milestone) {
            milestones.add(pr.milestone);
        }
        for (const p of peopleOf(pr)) {
            people.add(p);
        }
    }
    const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
    return { milestones: sorted(milestones), people: sorted(people) };
}

// byDay groups the PRs shown by the local day of their merge, newest first (the PRs come newest first).
export function byDay(prs: readonly MergedHistoryPr[]): { day: string; prs: MergedHistoryPr[] }[] {
    const rtn: { day: string; prs: MergedHistoryPr[] }[] = [];
    for (const pr of prs) {
        const day = mergedDay(pr);
        const last = rtn[rtn.length - 1];
        if (last != null && last.day === day) {
            last.prs.push(pr);
        } else {
            rtn.push({ day, prs: [pr] });
        }
    }
    return rtn;
}
