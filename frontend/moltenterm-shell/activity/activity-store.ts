// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The activity source (FR-BOSS-009, AC85; FR-SHELL-122, #2233, #2261, #2294): the derived atoms that say what runs in
// the window's workspace and what waits for the developer, over what the windows already hold. The agent states and the
// Integration panel's answers are kept current by their own stores; the running work is read when a watcher comes and
// on each run or CI event (running-work.ts); the upcoming work, where the sub-agents are listed, is kept current by
// activity-upcoming.ts, on the activity scheduler and not at all while no agent is open. This starts no timer of its
// own: a reader of the source holds both readings through watch().

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { atom, Atom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { AgentStates } from "../agent-state-store";
import { tabShownName } from "../project/project-model";
import { ReviewsMerges, withLocalMerges } from "../reviews/reviews-merges";
import type { ReviewsAnswer } from "../reviews/reviews-model";
import { SharedReviewsAnswersAtom, SharedUpcomingAnswersAtom } from "../reviews/reviews-state-atoms";
import { workspaceProjectDirs } from "../reviews/reviews-workspace-model";
import { RunningWork } from "../running-work";
import { projectRepoDir, readProjects } from "../sidebar/workspace-projects";
import { readWorkspaceProject } from "../workspace-project";
import {
    activityItems,
    activityKey,
    ActivitySummary,
    activityWaiting,
    openAgentsKey,
    summarizeActivity,
} from "./activity-model";
import { watchActivityUpcoming } from "./activity-upcoming";

// The repository folders of the window's workspace: the projects whose pull requests the Integration panel follows.
export function activityDirs(ws: Workspace): string[] {
    return workspaceProjectDirs(readProjects(ws), projectRepoDir, readWorkspaceProject(ws).repo);
}

// The folders a run of the window's workspace may carry when it names no workspace: its projects' folders and their
// repositories.
export function activityFolders(ws: Workspace): string[] {
    const rtn: string[] = [];
    for (const dir of [...readProjects(ws).map((p) => p.dir), ...activityDirs(ws), readWorkspaceProject(ws).dir]) {
        if (dir && !rtn.includes(dir)) {
            rtn.push(dir);
        }
    }
    return rtn;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
    return a.join("\n") === b.join("\n");
}

export class ActivitySource {
    private static instance: ActivitySource = null;

    dirsAtom: Atom<string[]>;
    foldersAtom: Atom<string[]>;
    workspaceIdAtom: Atom<string>;
    summaryAtom: Atom<ActivitySummary>;
    countAtom: Atom<number>;
    // What the upcoming work's reading depends on, and whether it is worth asking (#2294).
    upcomingKeyAtom: Atom<string>;
    openAgentAtom: Atom<boolean>;
    busyAtom: Atom<boolean>;
    watchers = 0;
    stopUpcoming: () => void = null;

    private constructor() {
        const agentsAtom = AgentStates.getInstance().dataAtom;
        const workAtom = RunningWork.getInstance().itemsAtom;
        const mergesAtom = ReviewsMerges.getInstance().mergesAtom;
        let lastDirs: string[] = [];
        this.dirsAtom = atom((get) => {
            const dirs = activityDirs(get(atoms.workspace));
            if (sameList(dirs, lastDirs)) {
                return lastDirs;
            }
            lastDirs = dirs;
            return dirs;
        });
        let lastFolders: string[] = [];
        this.foldersAtom = atom((get) => {
            const folders = activityFolders(get(atoms.workspace));
            if (sameList(folders, lastFolders)) {
                return lastFolders;
            }
            lastFolders = folders;
            return folders;
        });
        this.workspaceIdAtom = atom((get) => get(atoms.workspace)?.oid ?? "");
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
            const agents = get(agentsAtom).states;
            const tabNames: Record<string, string> = {};
            for (const info of Object.values(agents)) {
                if (info.state === "waiting" && info.tabid && tabNames[info.tabid] == null) {
                    tabNames[info.tabid] = tabShownName(
                        get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", info.tabid)))
                    );
                }
            }
            const inputs = {
                agents,
                work: get(workAtom),
                answers: followed,
                dirs,
                workspaceid: get(this.workspaceIdAtom),
                folders: get(this.foldersAtom),
                upcoming: get(SharedUpcomingAnswersAtom),
                tabNames,
            };
            const next = summarizeActivity(activityItems(inputs), activityWaiting(inputs));
            const key = activityKey(next);
            if (last != null && key === lastKey) {
                return last;
            }
            last = next;
            lastKey = key;
            return next;
        });
        this.countAtom = atom((get) => get(this.summaryAtom).count);
        this.upcomingKeyAtom = atom(
            (get) =>
                `${get(this.dirsAtom).join("\n")}|${openAgentsKey(get(agentsAtom).states, get(this.workspaceIdAtom))}`
        );
        this.openAgentAtom = atom((get) => openAgentsKey(get(agentsAtom).states, get(this.workspaceIdAtom)) !== "");
        this.busyAtom = atom((get) => get(this.summaryAtom).subagents > 0);
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

    // A reader holds the running-work and the upcoming-work readings current while it shows; the returned function lets
    // go. The readings are held once, whatever the number of readers.
    watch(): () => void {
        const stopWork = RunningWork.getInstance().watch();
        this.watchers++;
        if (this.watchers === 1) {
            this.stopUpcoming = watchActivityUpcoming({
                keyAtom: this.upcomingKeyAtom,
                openAtom: this.openAgentAtom,
                busyAtom: this.busyAtom,
                dirsAtom: this.dirsAtom,
            });
        }
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            stopWork();
            this.watchers--;
            if (this.watchers === 0) {
                this.stopUpcoming?.();
                this.stopUpcoming = null;
            }
        };
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
