// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The "PR merged" mark of the Sessions list (FR-SHELL-058, #932): a session whose worktree branch has a merged pull
// request is a finished one. wavesrv asks GitHub (the cleanup's rule: the branch's head is the PR's head, or one it
// carried) when the list shows a new worktree branch and every few minutes while it is shown.

import { fireAndForget } from "@/util/util";
import { useEffect, useState } from "react";
import { useT } from "../i18n/i18n";
import { TreeBranch, TreePr, treePrs } from "../mission/mission-client";
import { whileShown } from "../tab-activity";
import { everyInPanel } from "../view360/offcarpet-model";
import type { DurableSession } from "./sessions-model";

const RefreshMs = 5 * 60 * 1000;

export function mergedPrKey(path: string, branch: string): string {
    return `${path}\n${branch}`;
}

// The local sessions' worktree branches, each once.
export function treesOf(sessions: DurableSession[]): TreeBranch[] {
    const seen = new Set<string>();
    const rtn: TreeBranch[] = [];
    for (const s of sessions ?? []) {
        const wt = s.worktree;
        if (s.connection || !wt?.path || !wt.branch) {
            continue;
        }
        const key = mergedPrKey(wt.path, wt.branch);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        rtn.push({ path: wt.path, branch: wt.branch });
    }
    return rtn;
}

export function mergedPrMap(merged: TreePr[]): Map<string, number> {
    return new Map((merged ?? []).filter((m) => m.pr > 0).map((m) => [mergedPrKey(m.path, m.branch), m.pr]));
}

// The merged PR of a session's worktree branch, or 0.
export function sessionMergedPr(s: DurableSession, merged: Map<string, number>): number {
    const wt = s.worktree;
    if (s.connection || !wt?.path || !wt.branch) {
        return 0;
    }
    return merged.get(mergedPrKey(wt.path, wt.branch)) ?? 0;
}

// A finished session: its worktree branch's pull request is merged. The branch chip's family, in the success colour.
export function MergedPrMark({ session, pr }: { session: DurableSession; pr: number }) {
    const t = useT();
    if (!(pr > 0)) {
        return null;
    }
    return (
        <span
            className="inline-flex shrink-0 items-center gap-1 rounded-4 border border-success/50 px-1.5 text-11 leading-[16px] whitespace-nowrap text-success"
            title={t("sessions.view.prMergedTitle", { pr, branch: session.worktree?.branch ?? "" })}
            data-testid="session-pr-merged"
        >
            <i className="fa fa-solid fa-code-merge shrink-0 text-11" />
            {t("sessions.view.prMerged", { pr })}
        </span>
    );
}

export function useMergedPrs(sessions: DurableSession[], panelId: string): Map<string, number> {
    const [merged, setMerged] = useState<Map<string, number>>(() => new Map());
    const trees = treesOf(sessions);
    const treesKey = trees.map((tr) => mergedPrKey(tr.path, tr.branch)).join("\n\n");
    useEffect(() => {
        if (trees.length === 0) {
            setMerged(new Map());
            return;
        }
        let cancelled = false;
        const read = () =>
            fireAndForget(async () => {
                try {
                    const res = await treePrs(trees);
                    if (!cancelled) {
                        setMerged(mergedPrMap(res?.merged));
                    }
                } catch {
                    // GitHub or wavesrv did not answer: no mark rather than a wrong one.
                }
            });
        read();
        const stop = everyInPanel(panelId, whileShown(RefreshMs), read, "merged-prs");
        return () => {
            cancelled = true;
            stop();
        };
    }, [treesKey, panelId]);
    return merged;
}
