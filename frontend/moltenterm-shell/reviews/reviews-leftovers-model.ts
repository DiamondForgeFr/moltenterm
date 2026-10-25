// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What a merged PR left behind (#1088, FR-REV-022 AC14): wavesrv finds the branches whose merged PR's head is their tip
// (pkg/molten/mission/upcoming_done.go), and since #1121 (AC15) a closed PR's branch whose content is in the base, a
// worktree locked by a session that ended, the PR's local copies and its review worktree; a card names what remains of each (worktree, agent session, branches) and Clean
// up runs the cleanup after a merge (FR-REV-013) on those only. Kept apart from the components to be tested alone.

import type { TFunction } from "../i18n/i18n";
import { serverText } from "../i18n/server-text";
import type { ReviewCleanupResult, ReviewCleanupStepId, ReviewCleanupStepResult } from "../review/review-cleanup";
import type { ReviewsAnswer } from "./reviews-model";
import type { AgentBarFacts, UpcomingAnswer, UpcomingLeftover } from "./reviews-upcoming-model";

// The cleanup's steps a leftover needs: never the ticket, the local trunk or the other PRs, which belong to a merge.
// Origin's branch goes last, once the agent worktree is gone: deleting it first makes the worktree's commits unpushed,
// so the risk the developer confirmed for a kept worktree would no longer match and its removal would be refused.
export const LeftoverCleanupSteps: ReviewCleanupStepId[] = ["review-worktree", "agent-worktree", "local-branch"];
export const LeftoverRemoteStep: ReviewCleanupStepId = "remote-branch";

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

// leftoverSteps: the cleanup's steps a leftover's facts need (#1121), origin's branch aside (LeftoverRemoteStep). The
// review worktree is always asked: wavesrv finds it by the PR's number, and it is quiet when there is none.
export function leftoverSteps(leftover: UpcomingLeftover): ReviewCleanupStepId[] {
    const steps: ReviewCleanupStepId[] = [];
    for (const step of LeftoverCleanupSteps) {
        if (step === "agent-worktree" && !leftover.worktree) {
            continue;
        }
        if (step === "local-branch" && !leftover.local) {
            continue;
        }
        steps.push(step);
    }
    if ((leftover.copies ?? []).length > 0) {
        steps.push("copy-branches");
    }
    return steps;
}

// leftoverState: the card's state line, which says why the PR's leftovers are leftovers.
export function leftoverState(t: TFunction, leftover: UpcomingLeftover): string {
    if (leftover.state === "closed") {
        return t("reviewsAgents.leftovers.stateClosed", { number: leftover.pr, base: leftover.base ?? "" });
    }
    return t("reviewsAgents.leftovers.state", { number: leftover.pr });
}

export type LeftoverPart = {
    kind: "worktree" | "review" | "agent" | "local" | "copy" | "remote";
    text: string;
    title?: string;
};

function worktreeText(t: TFunction, leftover: UpcomingLeftover): string {
    const folder = folderName(leftover.worktree);
    switch (leftover.lock) {
        case "ended":
            return t("reviewsAgents.leftovers.part.lockEnded", { folder });
        case "held":
            return t("reviewsAgents.leftovers.part.lockHeld", { folder });
    }
    return t("reviewsAgents.leftovers.part.worktree", { folder });
}

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
    if (leftover.reviewtree) {
        parts.push({
            kind: "review",
            text: t("reviewsAgents.leftovers.part.reviewTree", { folder: folderName(leftover.reviewtree) }),
            title: leftover.reviewtree,
        });
    }
    if (leftover.worktree) {
        parts.push({ kind: "worktree", text: worktreeText(t, leftover), title: leftover.worktree });
    }
    for (const agent of agents ?? []) {
        parts.push({ kind: "agent", text: agentText(t, agent) });
    }
    if (leftover.local) {
        parts.push({ kind: "local", text: t("reviewsAgents.leftovers.part.local", { branch: leftover.branch }) });
    }
    for (const copy of leftover.copies ?? []) {
        parts.push({ kind: "copy", text: t("reviewsAgents.leftovers.part.copy", { branch: copy }) });
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
        const special = leftoverNote(t, step, leftover);
        if (special != null) {
            notes.push(special);
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

// leftoverNote: the steps whose sentence is the Leftovers group's own (#1121): the copies kept, and a closed PR's
// branches kept for commits that are not in the base (Validate's sentence speaks of the merged pull request).
function leftoverNote(t: TFunction, step: ReviewCleanupStepResult, leftover: UpcomingLeftover): string {
    if (step.id === "copy-branches" && step.code === "copieskept") {
        return t("reviewsAgents.leftovers.copiesKept", { branches: (step.names ?? []).join(", ") });
    }
    if (leftover.state !== "closed" || step.code !== "kept") {
        return null;
    }
    const vars = { branch: step.branch || leftover.branch, base: step.base || leftover.base || "" };
    if (step.id === "local-branch") {
        return t("reviewsAgents.leftovers.keptNotInBase", vars);
    }
    if (step.id === "remote-branch") {
        return t("reviewsAgents.leftovers.remoteKeptNotInBase", vars);
    }
    return null;
}

// cleanedUp: the leftover's worktree and branches went; the card leaves until wavesrv answers again.
export function cleanedUp(result: ReviewCleanupResult): boolean {
    const steps = result?.steps ?? [];
    if (steps.length === 0 || steps.some((s) => s.state === "failed")) {
        return false;
    }
    return !steps.some((s) => s.state === "skipped" && !QuietCodes.has(s.code));
}
