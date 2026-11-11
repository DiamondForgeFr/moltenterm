// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The activity source (FR-BOSS-009, AC85; FR-SHELL-122, #2233): the derived atoms that say what runs, over what the
// windows already hold. The agent states and the Integration panel's answers are kept current by their own stores; the
// running work is read when a watcher comes and on each run or CI event (running-work.ts). This adds no timer and no
// poll: a reader of the source holds the work reading through watch().

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, Atom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { AgentStates } from "../agent-state-store";
import { ReviewsMerges, withLocalMerges } from "../reviews/reviews-merges";
import type { ReviewsAnswer } from "../reviews/reviews-model";
import { SharedReviewsAnswersAtom } from "../reviews/reviews-state-atoms";
import { workspaceProjectDirs } from "../reviews/reviews-workspace-model";
import { RunningWork } from "../running-work";
import { projectRepoDir, readProjects } from "../sidebar/workspace-projects";
import { readWorkspaceProject } from "../workspace-project";
import { activityItems, activityKey, ActivitySummary, summarizeActivity } from "./activity-model";

// The repository folders of the window's workspace: the projects whose pull requests the Integration panel follows.
export function activityDirs(ws: Workspace): string[] {
    return workspaceProjectDirs(readProjects(ws), projectRepoDir, readWorkspaceProject(ws).repo);
}

export class ActivitySource {
    private static instance: ActivitySource = null;

    dirsAtom: Atom<string[]>;
    summaryAtom: Atom<ActivitySummary>;
    countAtom: Atom<number>;

    private constructor() {
        const agentsAtom = AgentStates.getInstance().dataAtom;
        const workAtom = RunningWork.getInstance().itemsAtom;
        const mergesAtom = ReviewsMerges.getInstance().mergesAtom;
        let lastDirs: string[] = [];
        this.dirsAtom = atom((get) => {
            const dirs = activityDirs(get(atoms.workspace));
            if (dirs.join("\n") === lastDirs.join("\n")) {
                return lastDirs;
            }
            lastDirs = dirs;
            return dirs;
        });
        // The summary is the same object while the same items run: an agent's message or a PR's title moving makes no
        // reader draw again.
        let last: ActivitySummary = null;
        let lastKey = "";
        this.summaryAtom = atom((get) => {
            const dirs = get(this.dirsAtom);
            const answers = get(SharedReviewsAnswersAtom);
            const merges = get(mergesAtom);
            const followed: Record<string, ReviewsAnswer> = {};
            for (const dir of dirs) {
                followed[dir] = withLocalMerges(answers[dir] ?? null, merges);
            }
            const next = summarizeActivity(
                activityItems({ agents: get(agentsAtom).states, work: get(workAtom), answers: followed, dirs })
            );
            const key = activityKey(next);
            if (last != null && key === lastKey) {
                return last;
            }
            last = next;
            lastKey = key;
            return next;
        });
        this.countAtom = atom((get) => get(this.summaryAtom).count);
    }

    static getInstance(): ActivitySource {
        if (ActivitySource.instance == null) {
            ActivitySource.instance = new ActivitySource();
        }
        return ActivitySource.instance;
    }

    static resetInstance(): void {
        ActivitySource.instance = null;
    }

    // A reader holds the running-work reading current while it shows; the returned function lets go.
    watch(): () => void {
        return RunningWork.getInstance().watch();
    }

    summary(): ActivitySummary {
        return globalStore.get(this.summaryAtom);
    }
}

// What runs, for a component: it holds the source while it shows.
export function useActivity(): ActivitySummary {
    const source = ActivitySource.getInstance();
    useEffect(() => source.watch(), [source]);
    return useAtomValue(source.summaryAtom, { store: globalStore });
}

// How many items run: the sidebar's floor needs no more, and draws again only when the number moves.
export function useActivityCount(): number {
    const source = ActivitySource.getInstance();
    useEffect(() => source.watch(), [source]);
    return useAtomValue(source.countAtom, { store: globalStore });
}
