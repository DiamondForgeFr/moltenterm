// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The trunk and release branches' GitHub CI (#836), read by wavesrv (pkg/molten/mission/branch_ci.go): the latest run
// of each workflow on develop and main, its jobs, how long they usually take, and the release waiting for it.

import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { useCallback, useEffect, useState } from "react";
import { isReviewable } from "../reviews/reviews-model";
import { whileShown } from "../tab-activity";
import { everyInPanel, usePanelBlockId } from "../view360/offcarpet-model";
import { CheckState, PullRequest } from "./github";
import { MissionRouteId } from "./mission-client";

// must match BranchCiCommand in pkg/molten/mission/branch_ci.go
export const MissionBranchCiCommand = "moltenmissionbranchci";

const BranchCiTimeoutMs = 50000;
const BranchCiActivePollMs = 20000;
const BranchCiIdlePollMs = 120000;

// must match ReleaseCiAwait in pkg/molten/mission/branch_ci.go
export type ReleaseCiAwait = { tag: string; branch: string; sha: string; workflows?: string[] };

export type BranchCiJob = {
    name: string;
    state: CheckState;
    status?: string;
    startedat?: string;
    completedat?: string;
    url?: string;
    usualms?: number;
    failedsteps?: string[];
};

export type BranchCiRun = {
    databaseId: number;
    workflowName: string;
    event: string;
    status: string;
    conclusion: string;
    headBranch: string;
    headSha: string;
    displayTitle: string;
    createdAt: string;
    updatedAt: string;
    startedAt: string;
    url: string;
    attempt: number;
    usualms?: number;
    ci: { state: CheckState | "none"; success: number; failure: number; pending: number };
    jobs: BranchCiJob[];
    jobserror?: string;
    awaitedby?: string;
};

export type BranchCiBranch = { branch: string; roles: ("trunk" | "release")[]; runs: BranchCiRun[]; error?: string };

export type BranchCiAnswer = { dir: string; state?: string; branches: BranchCiBranch[]; awaits?: ReleaseCiAwait };

export function branchCi(dir: string): Promise<BranchCiAnswer> {
    return TabRpcClient.wshRpcCall(
        MissionBranchCiCommand,
        { dir },
        { route: MissionRouteId, timeout: BranchCiTimeoutMs }
    );
}

function isActive(run: BranchCiRun): boolean {
    return run.status !== "completed";
}

// The branches' CI, read on show, whenever `bump` changes (the snapshot was refreshed), every 20 s while a run goes on
// and every 2 min otherwise.
export function useBranchCi(dir: string, bump: string): { answer: BranchCiAnswer; error: unknown; reload: () => void } {
    const [answer, setAnswer] = useState<BranchCiAnswer>(null);
    const [error, setError] = useState<unknown>(null);
    const [tick, setTick] = useState(0);
    const panelId = usePanelBlockId();
    const reload = useCallback(() => setTick((n) => n + 1), []);
    useEffect(() => {
        setAnswer(null);
        setError(null);
    }, [dir]);
    useEffect(() => {
        if (!dir) {
            return;
        }
        let cancelled = false;
        fireAndForget(async () => {
            try {
                const next = await branchCi(dir);
                if (!cancelled) {
                    setAnswer(next);
                    setError(null);
                }
            } catch (e) {
                if (!cancelled) {
                    setError(e);
                }
            }
        });
        return () => {
            cancelled = true;
        };
    }, [dir, bump, tick]);
    const active = (answer?.branches ?? []).some((b) => b.runs.some(isActive));
    useEffect(
        () =>
            everyInPanel(
                panelId,
                whileShown(active ? BranchCiActivePollMs : BranchCiIdlePollMs),
                reload,
                "mission-branch-ci"
            ),
        [active, reload, panelId]
    );
    return { answer, error, reload };
}

// The pull requests the Reviews panel lists as waiting for a review: ready ones of the repository, on its target.
export function waitingReviewCount(prs: PullRequest[], target: string): number {
    return (prs ?? []).filter((pr) => !pr.isDraft && isReviewable(pr, target)).length;
}

function timeOf(s: string): number {
    if (!s || s.startsWith("0001-")) {
        return NaN;
    }
    return new Date(s).getTime();
}

// How long a job has run: until it ended, else until now; null before it started.
export function jobElapsedMs(job: BranchCiJob, now: number): number {
    const start = timeOf(job.startedat);
    if (Number.isNaN(start)) {
        return null;
    }
    const end = job.status === "completed" ? timeOf(job.completedat) : now;
    return Number.isNaN(end) ? null : Math.max(0, end - start);
}

export function runElapsedMs(run: BranchCiRun, now: number): number {
    let start = timeOf(run.startedAt);
    if (Number.isNaN(start)) {
        start = timeOf(run.createdAt);
    }
    if (Number.isNaN(start)) {
        return null;
    }
    const end = isActive(run) ? now : timeOf(run.updatedAt);
    return Number.isNaN(end) ? null : Math.max(0, end - start);
}
