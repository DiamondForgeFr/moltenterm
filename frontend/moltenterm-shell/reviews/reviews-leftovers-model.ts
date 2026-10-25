// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What a merged PR left behind (#1088, FR-REV-022 AC14): wavesrv finds the branches whose merged PR's head is their tip
// (pkg/molten/mission/upcoming_done.go); a card names what remains of each (worktree, agent session, branches) and Clean
// up runs the cleanup after a merge (FR-REV-013) on those only. Kept apart from the components to be tested alone.

import type { TFunction } from "../i18n/i18n";
import { serverText } from "../i18n/server-text";
import type { ReviewCleanupResult, ReviewCleanupStepId, ReviewCleanupStepResult } from "../review/review-cleanup";
import type { ReviewsAnswer } from "./reviews-model";
import type { AgentBarFacts, UpcomingAnswer, UpcomingLeftover } from "./reviews-upcoming-model";

// The cleanup's steps a leftover needs: never the ticket, the local trunk or the other PRs, which belong to a merge.
export const LeftoverCleanupSteps: ReviewCleanupStepId[] = [
    "review-worktree",
    "agent-worktree",
    "local-branch",
    "remote-branch",
];

// The agent states whose session closes without asking: nothing is going on in it.
const RestingStates = new Set(["idle", "done"]);

// Skips that leave nothing behind: worth no line on the card.
const QuietCodes = new Set([
    "noreviewtree",
    "noagenttree",
    "nolocalbranch",
    "alreadygone",
    "deletedbymerge",
    "prunconfirmed",
    "inkepttree",
]);

export function leftoverKey(dir: string, pr: number): string {
    return `${dir}#${pr}`;
}

// The leftovers to show: a branch whose PR the Reviews list shows open again is that PR's, not a leftover.
export function leftoverRows(upcoming: UpcomingAnswer, reviews: ReviewsAnswer): UpcomingLeftover[] {
    if (upcoming?.leftovers == null) {
        return [];
    }
    const withPr = new Set<string>();
    for (const pr of [...(reviews?.ready ?? []), ...(reviews?.drafts ?? [])]) {
        withPr.add(pr.branch);
    }
    return upcoming.leftovers.filter((l) => !withPr.has(l.branch));
}

export type LeftoverPart = { kind: "worktree" | "agent" | "local" | "remote"; text: string; title?: string };

function folderName(path: string): string {
    const parts = (path ?? "").split(/[\\/]/).filter((p) => !!p);
    return parts[parts.length - 1] ?? path;
}

// agentText says an agent on a leftover's branch and its state; an idle one reads "inactive", so closing it reads safe.
export function agentText(t: TFunction, agent: AgentBarFacts): string {
    if (agent.kind === "background") {
        return t("reviewsAgents.leftovers.agent.background");
    }
    if (agent.kind === "subagent") {
        const name = agent.parentName || t("reviewsAgents.subagent.name");
        return agent.subState === "running"
            ? t("reviewsAgents.leftovers.agent.subagentWorking", { name })
            : t("reviewsAgents.leftovers.agent.subagentResting", { name });
    }
    const name = agent.name || t("reviews.card.anAgent");
    switch (agent.state) {
        case "working":
            return t("reviewsAgents.leftovers.agent.working", { name });
        case "waiting":
            return t("reviewsAgents.leftovers.agent.waiting", { name });
        case "done":
            return t("reviewsAgents.leftovers.agent.done", { name });
    }
    return t("reviewsAgents.leftovers.agent.idle", { name });
}

// leftoverParts: what remains of a merged PR, in the order Clean up removes it.
export function leftoverParts(t: TFunction, leftover: UpcomingLeftover, agents: AgentBarFacts[]): LeftoverPart[] {
    const parts: LeftoverPart[] = [];
    if (leftover.worktree) {
        parts.push({
            kind: "worktree",
            text: t("reviewsAgents.leftovers.part.worktree", { folder: folderName(leftover.worktree) }),
            title: leftover.worktree,
        });
    }
    for (const agent of agents ?? []) {
        parts.push({ kind: "agent", text: agentText(t, agent) });
    }
    if (leftover.local) {
        parts.push({ kind: "local", text: t("reviewsAgents.leftovers.part.local", { branch: leftover.branch }) });
    }
    if (leftover.remote) {
        parts.push({ kind: "remote", text: t("reviewsAgents.leftovers.part.remote", { branch: leftover.branch }) });
    }
    return parts;
}

// busyAgents: the agents still at work on the branch; cleaning up would pull the folder from under them.
export function busyAgents(agents: AgentBarFacts[]): AgentBarFacts[] {
    return (agents ?? []).filter((a) => {
        if (a.kind === "background") {
            return true;
        }
        if (a.kind === "subagent") {
            return a.subState === "running";
        }
        return a.state === "working" || a.state === "waiting";
    });
}

// keptAgentStep: the agent worktree the cleanup kept, for work it would lose or for panels open in it.
export function keptAgentStep(result: ReviewCleanupResult): ReviewCleanupStepResult {
    const step = result?.steps?.find((s) => s.id === "agent-worktree");
    if (step == null || step.state !== "skipped" || (step.code !== "kept" && step.code !== "inuse")) {
        return null;
    }
    return step;
}

// panelsClosable: the kept worktree holds nothing to lose and only agent sessions at rest (or ones the developer chose
// to stop), which Clean up closes without asking. A terminal without an agent may run anything: it asks.
export function panelsClosable(step: ReviewCleanupStepResult, busyConfirmed: boolean): boolean {
    const panels = step?.panels ?? [];
    if (step?.code !== "inuse" || panels.length === 0) {
        return false;
    }
    return panels.every((p) => !!p.agent && (busyConfirmed || RestingStates.has(p.agent)));
}

// cleanupNotes: what the cleanup left and why, one line per step that did not finish its part; the kept agent worktree
// is said by its confirmation instead.
export function cleanupNotes(t: TFunction, result: ReviewCleanupResult, leftover: UpcomingLeftover): string[] {
    const notes: string[] = [];
    for (const step of result?.steps ?? []) {
        if (step.state === "done" || QuietCodes.has(step.code)) {
            continue;
        }
        if (step.id === "agent-worktree" && keptAgentStep(result) === step) {
            continue;
        }
        if (step.state === "failed" || step.id === "pr") {
            const why = serverText(step.errortext, step.error) || step.code || "";
            notes.push(t("reviewsAgents.leftovers.failed", { error: why }));
            continue;
        }
        notes.push(
            t(`review.validate.cleanup.${step.id}.did.${step.code || "none"}`, {
                branch: step.branch || leftover.branch,
                path: step.path ?? "",
                ticket: step.ticket ?? "",
                base: step.base ?? "",
            })
        );
    }
    return notes;
}

// cleanedUp: the leftover's worktree and branches went; the card leaves until wavesrv answers again.
export function cleanedUp(result: ReviewCleanupResult): boolean {
    const steps = result?.steps ?? [];
    if (steps.length === 0 || steps.some((s) => s.state === "failed")) {
        return false;
    }
    return !steps.some((s) => s.state === "skipped" && !QuietCodes.has(s.code));
}
