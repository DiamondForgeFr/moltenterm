// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The sections of Integration's All projects (#2314, FR-SHELL-087): one Upcoming, one Notes and one Recently merged for
// the whole workspace, each listing the cards of every project in that state, each card marked with its project. The
// project's own view reads one project's answers; here every project's are merged, in the order the section sorts a
// project's own cards (what waits for the developer first, then the most recent). Pure, to be tested without the app.

import type { AgentStatesData } from "../agent-state-model";
import { filterNotes, type ReviewNote, type ReviewNotes } from "../review/review-notes";
import { projectLabel, projectRepoDir, type WorkspaceProjectEntry } from "../sidebar/workspace-projects";
import type { LeftoverAsksAnswer } from "./reviews-leftover-owner-model";
import { type LeftoverTarget, leftoverTargets } from "./reviews-leftovers-model";
import type { ReviewsAnswer } from "./reviews-model";
import { branchOwner, inScope, type ScopeNames } from "./reviews-owners-model";
import {
    type MergedGroup,
    mergedGroups,
    upcomingEntries,
    type UpcomingEntry,
    upcomingEntryCommitAt,
    upcomingEntryRank,
} from "./reviews-sections-model";
import { branchAgent, type UpcomingAnswer, type UpcomingLeftover, upcomingRows } from "./reviews-upcoming-model";

// What a project's mark says (the chip on its cards): its name, the branch its pull requests target, and whether the
// workspace has a colour to show beside the name.
export type ProjectMarkFacts = { id: string; label: string; target: string; place: boolean };

// One project of the workspace, with everything its probe follows: the answers the sections read.
export type AllSource = {
    project: WorkspaceProjectEntry;
    // The repository the project's pull requests and agents work on (projectRepoDir).
    dir: string;
    answer: ReviewsAnswer;
    upcoming: UpcomingAnswer;
    notes: ReviewNotes;
    // Why the notes could not be read, "" when they could.
    notesError: string;
    // The notes a rename or a delete answers with, so the section shows them without waiting for the event.
    setNotes: (notes: ReviewNotes) => void;
    asks: LeftoverAsksAnswer;
};

// markOf: the facts of a project's chip. place: whether the workspace has a colour of its own.
export function markOf(source: Pick<AllSource, "project" | "answer">, place: boolean): ProjectMarkFacts {
    return {
        id: source.project.id,
        label: projectLabel(source.project),
        target: source.answer?.target ?? "",
        place,
    };
}

export function sourceOf(
    project: WorkspaceProjectEntry,
    parts: Partial<Omit<AllSource, "project" | "dir">>
): AllSource {
    return {
        project,
        dir: projectRepoDir(project),
        answer: parts.answer ?? null,
        upcoming: parts.upcoming ?? null,
        notes: parts.notes ?? null,
        notesError: parts.notesError ?? "",
        setNotes: parts.setNotes ?? (() => {}),
        asks: parts.asks ?? null,
    };
}

// mergeByRecency: the lists' items as one list, the most recent first. Each list keeps its own order (the order its
// project gave it); on the same time the earlier list comes first.
export function mergeByRecency<T>(lists: readonly (readonly T[])[], at: (item: T) => number): T[] {
    const heads = lists.map(() => 0);
    const rtn: T[] = [];
    for (;;) {
        let best = -1;
        for (let i = 0; i < lists.length; i++) {
            if (heads[i] >= lists[i].length) {
                continue;
            }
            if (best < 0 || at(lists[i][heads[i]]) > at(lists[best][heads[best]])) {
                best = i;
            }
        }
        if (best < 0) {
            return rtn;
        }
        rtn.push(lists[best][heads[best]]);
        heads[best]++;
    }
}

// ---- Upcoming ----

export type AllUpcomingCard = { entry: UpcomingEntry; source: AllSource };

export type AllUpcoming = {
    cards: AllUpcomingCard[];
    // The branches the cards stand for (a session's card stands for several).
    count: number;
    waiting: number;
    // Whether some project's upcoming work has been answered, and whether all of them have.
    started: boolean;
    ready: boolean;
};

// allUpcoming: every project's upcoming entries as one list. What waits for the developer comes first, then the
// entries with an agent, then the others, the most recent first in each; a project's entries keep their order.
export function allUpcoming(sources: readonly AllSource[], states: AgentStatesData, names: ScopeNames): AllUpcoming {
    const waits = (blockId: string) => states?.states?.[blockId]?.state === "waiting";
    let count = 0;
    const perProject = sources.map((source) => {
        const rows = upcomingRows(source.upcoming, source.answer).filter((b) =>
            inScope(branchOwner(source.upcoming, b.branch), names)
        );
        count += rows.length;
        const entries = upcomingEntries(rows, (branch) => branchAgent(source.upcoming, states, branch), waits);
        return entries.map((entry) => ({ entry, source }));
    });
    const cards: AllUpcomingCard[] = [];
    for (const rank of [0, 1, 2]) {
        cards.push(
            ...mergeByRecency(
                perProject.map((list) => list.filter((card) => upcomingEntryRank(card.entry) === rank)),
                (card) => upcomingEntryCommitAt(card.entry)
            )
        );
    }
    return {
        cards,
        count,
        waiting: cards.filter((card) => card.entry.waiting).length,
        started: sources.some((s) => s.upcoming != null),
        ready: sources.every((s) => s.upcoming != null),
    };
}

// ---- Leftovers ----

export type AllLeftover = { target: LeftoverTarget; source: AllSource };

// allLeftovers: the leftovers of every project that has a repository, in the order of the workspace's projects.
export function allLeftovers(
    sources: readonly AllSource[],
    states: AgentStatesData,
    cleanedAt: (dir: string, leftover: UpcomingLeftover) => number
): AllLeftover[] {
    return sources
        .filter((source) => !!source.answer?.repo)
        .flatMap((source) =>
            leftoverTargets({
                dir: source.dir,
                reviews: source.answer,
                upcoming: source.upcoming,
                states,
                cleanedAt: (leftover) => cleanedAt(source.dir, leftover),
                asks: source.asks,
            }).map((target) => ({ target, source }))
        );
}

// ---- Notes ----

export type AllNote = { note: ReviewNote; source: AllSource };

// allNotes: the notes of every project the filter keeps, the newest first. only: a project the notes are limited to,
// when "Show notes" on a merged pull request asked for those of that project alone.
export function allNotes(sources: readonly AllSource[], filter: string, only?: string): AllNote[] {
    const rtn: AllNote[] = [];
    for (const source of sources) {
        if (only && source.project.id !== only) {
            continue;
        }
        for (const note of filterNotes(source.notes?.notes, filter)) {
            rtn.push({ note, source });
        }
    }
    return rtn.sort((a, b) => (b.note.keptat ?? 0) - (a.note.keptat ?? 0));
}

// noteCount: the notes of every project, before any filter.
export function noteCount(sources: readonly AllSource[]): number {
    return sources.reduce((sum, source) => sum + (source.notes?.notes?.length ?? 0), 0);
}

// notesRead: whether the notes of every project that has a repository have been read, or failed to be.
export function notesRead(sources: readonly AllSource[]): boolean {
    return sources.every((source) => !source.answer?.repo || source.notes != null || source.notesError !== "");
}

// ---- Recently merged ----

export type AllMergedGroup = { key: string; group: MergedGroup; source: AllSource };

const MergedKindRank: Record<MergedGroup["kind"], number> = { next: 0, tag: 1, unknown: 2 };

// allMergedGroups: the merged pull requests by the version that ships them, each version a project's own (its history
// and its notes belong to that project): the next versions first, then the tags, then what git cannot place yet; in
// each, the workspace's order of projects, and a project's tags newest first.
export function allMergedGroups(sources: readonly AllSource[]): AllMergedGroup[] {
    const groups = sources.flatMap((source) =>
        mergedGroups(source.answer?.merged ?? []).map((group) => ({
            key: `${source.project.id}:${group.key}`,
            group,
            source,
        }))
    );
    return groups
        .map((entry, i) => ({ entry, i }))
        .sort((a, b) => MergedKindRank[a.entry.group.kind] - MergedKindRank[b.entry.group.kind] || a.i - b.i)
        .map((x) => x.entry);
}

export function mergedCount(sources: readonly AllSource[]): number {
    return sources.reduce((sum, source) => sum + (source.answer?.merged?.length ?? 0), 0);
}

// ---- What is wrong with a project ----

// What is wrong with a project of the workspace: it has no folder yet, its answer could not be read (no gh, logged out,
// not a repository, a failed read), or a run was refused in it and waits for the developer to approve its commands. One
// line each at the top of the list, never a block.
export type ProjectProblem =
    | { kind: "nofolder"; project: WorkspaceProjectEntry }
    | { kind: "unreadable"; project: WorkspaceProjectEntry; note: string }
    | { kind: "trust"; project: WorkspaceProjectEntry; dir: string };

// projectProblems: the problems in the workspace's order of projects. noteOf: why a project's answer could not be read,
// "" when it could; trustDirOf: the folder whose commands wait for the developer's approval, "" for none.
export function projectProblems(
    projects: readonly WorkspaceProjectEntry[],
    noteOf: (projectId: string) => string,
    trustDirOf: (projectId: string) => string
): ProjectProblem[] {
    const rtn: ProjectProblem[] = [];
    for (const project of projects) {
        if (project.dir === "") {
            rtn.push({ kind: "nofolder", project });
            continue;
        }
        const note = noteOf(project.id);
        if (note) {
            rtn.push({ kind: "unreadable", project, note });
        }
        const dir = trustDirOf(project.id);
        if (dir) {
            rtn.push({ kind: "trust", project, dir });
        }
    }
    return rtn;
}
