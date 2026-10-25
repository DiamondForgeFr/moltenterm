// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What an agent MoltenTerm started works on (#1123, FR-MC-024), for its line in the project panel: "group merge: #1102
// → #1105 · 1 of 2 merged", "rebase of #1107", "review of #1107". The work comes before any branch or commit: a
// detached worktree's commit says nothing of it. The numbers are the ones the Reviews cards show (#1108): the ticket,
// else the PR. Read from the terminal's origin (pkg/molten/review/agentstart.go), the Review panel session's record
// (pkg/molten/mcpreview) and the merge queue's run. Pure, so it is tested without a window.

import { t, tCount } from "./i18n/i18n";
import { AgentOrigin, OriginMetaKey, readOrigin } from "./reviews/agent-origin";
import type { BatchRun } from "./reviews/reviews-batch-model";

// must match SessionMetaKey in pkg/molten/mcpreview/wire.go
export const ReviewSessionMetaKey = "molten:reviewsession";

// The ticket a branch name carries (feature/12-x, fix/12, 12-x), as the line map reads it.
const BranchTicket = /(?:^|\/)(\d+)(?:[-_]|$)/;

export function branchTicketNumber(branch: string): number {
    const m = BranchTicket.exec(branch ?? "");
    return m ? Number(m[1]) : 0;
}

// shownNumber: what a Reviews card names a PR by (#1108), its ticket, else its own number.
export function shownNumber(pr: number, ticket?: number, branch?: string): number {
    return ticket || branchTicketNumber(branch) || pr;
}

type ReviewSession = { repo?: string; number?: number; headref?: string };

function readReviewSession(value: any): ReviewSession {
    if (value == null || typeof value !== "object" || typeof value.number !== "number" || !(value.number > 0)) {
        return null;
    }
    return value as ReviewSession;
}

// The merge queue a batch agent's line reads, from its terminal's origin; null for any other terminal.
export function batchOriginOf(meta: Record<string, any>): AgentOrigin {
    const origin = readOrigin(meta?.[OriginMetaKey]);
    return origin?.kind === "batch" ? origin : null;
}

// batchWorkText: the run's PRs in order and how many merged. run is the queue's run only when this terminal is its
// agent's; otherwise the origin's count and base are all that is known.
export function batchWorkText(origin: AgentOrigin, run: BatchRun): string {
    const items = run?.items ?? [];
    if (items.length === 0) {
        return tCount("project.agents.work.batchCount", origin?.count ?? 0, { base: origin?.base ?? "" });
    }
    const list = items.map((it) => `#${shownNumber(it.number, it.ticket, it.headref)}`).join(" → ");
    const merged = items.filter((it) => it.state === "merged").length;
    return [
        t("project.agents.work.batch", { list }),
        tCount("project.agents.work.batchMerged", merged, { merged, count: items.length }),
    ].join(" · ");
}

// agentWorkText: the work of the terminal whose meta it is, "" when MoltenTerm did not start it for a known task.
// run: the merge queue's run whose agent this terminal is, if any.
export function agentWorkText(meta: Record<string, any>, run?: BatchRun): string {
    const origin = readOrigin(meta?.[OriginMetaKey]);
    if (origin != null) {
        const number = shownNumber(origin.number, 0, origin.branch);
        switch (origin.kind) {
            case "batch":
                return batchWorkText(origin, run);
            case "release":
                return origin.tag ? t("project.agents.work.release", { tag: origin.tag }) : "";
            case "restart":
                return t("project.agents.work.restart", { number });
            case "investigate":
                return t("project.agents.work.investigate", { number });
            case "finish":
                return t("project.agents.work.finish", { number });
            case "rebase":
                return t("project.agents.work.rebase", { number });
        }
        return "";
    }
    const review = readReviewSession(meta?.[ReviewSessionMetaKey]);
    if (review != null) {
        return t("project.agents.work.review", { number: shownNumber(review.number, 0, review.headref) });
    }
    return "";
}
