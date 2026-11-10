// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The hooks behind the counts of every project of the workspace (FR-SHELL-087, #2174). Each project's answer is read
// from the stores the panel and the rail already fill (reviews, upcoming work, agent states); the projects other than
// the current one are kept fresh by OtherProjectsWatch (sidebar/pr-counts.tsx), as the rail and the sidebar do for the
// current one.

import { atoms } from "@/app/store/global";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { AgentStates } from "../agent-state-store";
import { useT } from "../i18n/i18n";
import { projectLabel, projectRepoDir, readProjects } from "../sidebar/workspace-projects";
import { readWorkspaceProject } from "../workspace-project";
import { makeCardContext, useMinuteNow } from "./reviews-agent-bar";
import { BatchRuns } from "./reviews-batch-client";
import { CardState } from "./reviews-card-model";
import { ReviewsAnswers } from "./reviews-client";
import { ReviewsMerges, withLocalMerges } from "./reviews-merges";
import type { ReviewCounts } from "./reviews-model";
import { rebaseAskKey, reviewCounts, ReviewsAnswer, splitReviews } from "./reviews-model";
import { prOwner, scopeSplit, type ScopeNames } from "./reviews-owners-model";
import { CardContext, cardStates } from "./reviews-sections-model";
import { ReviewsModel } from "./reviews-store";
import { UpcomingAnswers } from "./reviews-upcoming-client";
import { sumReviewCounts, waitingOnYou, workspaceProjectDirs, type ElsewhereWaits } from "./reviews-workspace-model";

// The repository of each project of the window's workspace, the current one first.
export function useWorkspaceProjectDirs(): string[] {
    const workspace = useAtomValue(atoms.workspace);
    return useMemo(() => {
        const current = readWorkspaceProject(workspace).repo;
        const dirs = workspaceProjectDirs(readProjects(workspace), projectRepoDir, current);
        return current && dirs.includes(current) ? [current, ...dirs.filter((d) => d !== current)] : dirs;
    }, [workspace]);
}

export type ProjectReviews = {
    dir: string;
    answer: ReviewsAnswer;
    ctx: CardContext;
};

// Each project's answer as the list shows it (the PRs known merged left out), with the context its cards read.
export function useWorkspaceReviews(): ProjectReviews[] {
    const dirs = useWorkspaceProjectDirs();
    const t = useT();
    const answers = useAtomValue(ReviewsAnswers.getInstance().answersAtom);
    const merges = useAtomValue(ReviewsMerges.getInstance().mergesAtom);
    const upcomings = useAtomValue(UpcomingAnswers.getInstance().answersAtom);
    const states = useAtomValue(AgentStates.getInstance().dataAtom);
    const runs = useAtomValue(BatchRuns.getInstance().runsAtom);
    const now = useMinuteNow();
    return useMemo(
        () =>
            dirs.map((dir) => ({
                dir,
                answer: withLocalMerges(answers[dir] ?? null, merges),
                ctx: makeCardContext(dir, t, upcomings[dir] ?? null, states, now, runs),
            })),
        [dirs, answers, merges, upcomings, states, runs, now, t]
    );
}

// The rail's Integration badge: what waits for review and can merge now, over every project (FR-SHELL-087).
export function useWorkspaceReviewCounts(): ReviewCounts {
    const projects = useWorkspaceReviews();
    const readied = useAtomValue(ReviewsModel.getInstance().readiedAtom);
    return useMemo(() => sumReviewCounts(projects.map((p) => reviewCounts(p.answer, readied))), [projects, readied]);
}

// What the view's filter hides in the workspace's other projects (FR-REV-034 with FR-SHELL-087): how many pull requests,
// and in which project some of them wait for the developer. The filter follows the agents, which belong to the project
// of their repository: the pull requests of the other projects count and are signalled like those of this one.
export function useOutsideOtherProjects(dir: string, names: ScopeNames): { hidden: number; waits: ElsewhereWaits[] } {
    const workspace = useAtomValue(atoms.workspace);
    const projects = useWorkspaceReviews();
    const readied = useAtomValue(ReviewsModel.getInstance().readiedAtom);
    const asks = useAtomValue(ReviewsModel.getInstance().rebaseAsksAtom);
    return useMemo(() => {
        const rtn = { hidden: 0, waits: [] as ElsewhereWaits[] };
        if (names == null) {
            return rtn;
        }
        const entries = readProjects(workspace);
        for (const { dir: other, answer, ctx } of projects) {
            if (other === dir || answer?.state !== "ok") {
                continue;
            }
            const split = splitReviews(answer, readied);
            const out = scopeSplit(split, names, (pr) => prOwner(pr, ctx.upcoming));
            rtn.hidden += out.hidden.length;
            const cards = cardStates(out.hidden, asks, (n) => rebaseAskKey(other, n), ctx);
            const count = waitingOnYou(out.hidden, cards);
            const project = entries.find((p) => p.dir !== "" && projectRepoDir(p) === other);
            if (count > 0 && project != null) {
                rtn.waits.push({ projectId: project.id, label: projectLabel(project), count });
            }
        }
        return rtn;
    }, [workspace, projects, dir, names, readied, asks]);
}

// How many pull requests wait for the developer in each project, by repository folder: a chip shows its project's.
export function useProjectWaiting(): Record<string, number> {
    const projects = useWorkspaceReviews();
    const readied = useAtomValue(ReviewsModel.getInstance().readiedAtom);
    const asks = useAtomValue(ReviewsModel.getInstance().rebaseAsksAtom);
    return useMemo(() => {
        const rtn: Record<string, number> = {};
        for (const { dir, answer, ctx } of projects) {
            if (answer?.state !== "ok") {
                continue;
            }
            const split = splitReviews(answer, readied);
            const listed = [...split.ready, ...split.drafts];
            const cards: Record<number, CardState> = cardStates(listed, asks, (n) => rebaseAskKey(dir, n), ctx);
            rtn[dir] = waitingOnYou(listed, cards);
        }
        return rtn;
    }, [projects, readied, asks]);
}
