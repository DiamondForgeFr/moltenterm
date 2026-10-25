// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The merge queue's agent on the cards (#1128, FR-REV-026 AC13): while the running queue works on a PR, its card is
// the agent's like a PR another agent works on, in "Agents on it" with the agent's line, and goes back to its own
// section once the queue leaves it. The queue's agent works in a detached worktree, so wavesrv never places it on the
// PR's branch: the card learns it from the queue's run. Pure, so it is tested without a window.

import type { AgentStatesData } from "../agent-state-model";
import { shownNumber } from "../agent-work-model";
import { phrase, Phrase } from "../i18n/phrase";
import { batchActive, BatchItem, BatchItemState, BatchRun } from "./reviews-batch-model";
import type { ReviewPr } from "./reviews-model";
import { AgentBarFacts, panelFacts } from "./reviews-upcoming-model";

// The steps where the queue works on its current PR. Waiting its turn, set aside on a failing check or out of the
// queue, the PR keeps its own section.
const WorkStates = new Set<BatchItemState>(["checking", "rebasing", "waitingchecks", "merging"]);

// batchWorkItem: the PR's item while the running queue works on it, null otherwise. Before the queue started its
// agent (it does at the first rebase), a PR is the agent's only once it is being rebased or conflicts with the base,
// which the agent rebases next: a queue without an agent that merges a green PR is no agent's work.
export function batchWorkItem(run: BatchRun, pr: ReviewPr): BatchItem {
    if (!batchActive(run) || pr == null || pr.base !== run.base) {
        return null;
    }
    const item = run.items?.[run.current];
    if (item == null || item.number !== pr.number || !WorkStates.has(item.state)) {
        return null;
    }
    const hasAgent = !!(run.blockid || run.agentname);
    if (!hasAgent && item.state !== "rebasing" && pr.merge !== "conflicts") {
        return null;
    }
    return item;
}

// batchWork: the queue's work, as the agent's line says it: "group merge: #1102 → #1105".
export function batchWork(run: BatchRun): Phrase {
    const list = (run.items ?? []).map((it) => `#${shownNumber(it.number, it.ticket, it.headref)}`).join(" → ");
    const group = (run.items ?? []).some((it) => it.source === "batch");
    return phrase(group ? "reviews.batch.work.group" : "reviews.batch.work.queue", { list });
}

// batchAgentFacts: the queue's agent as a line of the card whose PR it works on. Its terminal's state when the
// windows know it, working while the queue works on the PR (its checks run while the agent sits idle), waiting when
// it asks the developer. Without a terminal it is named but not reached.
export function batchAgentFacts(run: BatchRun, item: BatchItem, states: AgentStatesData): AgentBarFacts {
    const info = run.blockid ? states?.states?.[run.blockid] : null;
    const known = panelFacts(run.blockid, info);
    const facts: AgentBarFacts = known ?? {
        kind: "panel",
        agent: run.agent,
        name: run.agentname || "",
        state: "working",
        since: 0,
    };
    const waiting = item.waiting || known?.state === "waiting";
    return {
        ...facts,
        blockId: known != null ? run.blockid : "",
        name: facts.name || run.agentname || "",
        state: waiting ? "waiting" : "working",
        since: item.startedat || facts.since,
        held: undefined,
        errored: false,
        batch: true,
        work: batchWork(run),
    };
}

// withBatchAgent: the PR's agents with the queue's agent after them while it works on the PR.
export function withBatchAgent(
    agents: AgentBarFacts[],
    run: BatchRun,
    pr: ReviewPr,
    states: AgentStatesData
): AgentBarFacts[] {
    const item = batchWorkItem(run, pr);
    if (item == null) {
        return agents;
    }
    return [...(agents ?? []), batchAgentFacts(run, item, states)];
}

// The card's state sentence while the queue works on its PR (the agent asking is the card's "waits for you").
export function batchStatePhrase(run: BatchRun, item: BatchItem, name: Phrase): Phrase {
    const vars = { name, base: run.base };
    switch (item.state) {
        case "checking":
            return phrase("reviews.card.state.batch.checking", vars);
        case "rebasing":
            return phrase("reviews.card.state.batch.rebasing", vars);
        case "waitingchecks":
            return phrase(
                (item.rebases ?? 0) > 0
                    ? "reviews.card.state.batch.waitingRebased"
                    : "reviews.card.state.batch.waitingChecks",
                vars
            );
    }
    return phrase("reviews.card.state.batch.merging", vars);
}

// batchPointerShown: a finished run the developer hid whose agent's session is still open keeps a one-line pointer
// in "Agents on it" until the session closes.
export function batchPointerShown(run: BatchRun, states: AgentStatesData): boolean {
    if (run == null || batchActive(run) || !run.dismissed || !run.blockid) {
        return false;
    }
    return states?.states?.[run.blockid] != null;
}
