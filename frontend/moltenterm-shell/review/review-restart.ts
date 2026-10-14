// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Restart work (FR-REV-011, DS-REV-009): the rules of the Review tab's button and status line, kept apart from the
// components so they can be tested without the app. The work itself is wavesrv's (pkg/molten/review/restart.go).

import type { AgentStateInfo } from "../agent-state-model";
import { agentLabel, agentStateLabel } from "../agent-state-model";
import type { ReviewRestartResult, ReviewRound, ReviewState } from "./review-client";

// The strings of Restart work, in one place until the interface languages land (#623).
export const RestartText = {
    button: "Restart work",
    restarting: "Restarting…",
    noRound: "Publish a review round first: Restart work hands its comments to an agent",
    enabled: (round: number) =>
        `Hand review round ${round}'s comments to an agent in the branch's worktree: it applies them, commits, pushes and replies on each thread`,
    again: (round: number) => `Hand review round ${round}'s comments to the agent again`,
    working: (name: string, state: string, round: number) => `${name} ${state} on review round ${round}`,
    noAgentNow: (round: number) => `Review round ${round} was handed to an agent; its terminal is closed`,
    inWorktree: (folder: string) => `in ${folder}`,
    pushed: (round: number) => `New commits since review round ${round}`,
    showSince: "Show the changes since the round",
    showAgent: "Show the agent",
    dismiss: "Dismiss",
};

export type ReviewRestartState = {
    status: "idle" | "restarting" | "done";
    result?: ReviewRestartResult;
    error?: string;
};

export type RestartRound = { round: ReviewRound; number: number };

// lastPublished is the round Restart work hands over: the last one published, with its number (1 for the first).
export function lastPublished(state: ReviewState): RestartRound {
    const rounds = state?.rounds ?? [];
    for (let i = rounds.length - 1; i >= 0; i--) {
        if (rounds[i].publishedat) {
            return { round: rounds[i], number: i + 1 };
        }
    }
    return null;
}

export function restartButtonTitle(last: RestartRound): string {
    if (last == null) {
        return RestartText.noRound;
    }
    return last.round.restartedat ? RestartText.again(last.number) : RestartText.enabled(last.number);
}

// pushedSinceRound: the agent pushed after the round was handed over (the PR's head is not the round's any more).
export function pushedSinceRound(last: RestartRound, head: string): boolean {
    return last?.round?.restartedat != null && last.round.restartedat > 0 && !!head && head !== last.round.headoid;
}

export function folderName(path: string): string {
    const parts = (path ?? "").split(/[/\\]/).filter((p) => p !== "");
    return parts[parts.length - 1] ?? "";
}

// restartLine is the status line's text about the agent: its live state while its terminal is there.
export function restartLine(last: RestartRound, agent: AgentStateInfo): string {
    if (last?.round?.restartedat == null || !last.round.restartedat) {
        return "";
    }
    if (agent == null) {
        return RestartText.noAgentNow(last.number);
    }
    return RestartText.working(agentLabel(agent), agentStateLabel(agent.state ?? "idle"), last.number);
}

// restartResultTone: how the last click's outcome shows.
export function restartResultTone(result: ReviewRestartResult): "ok" | "warn" | "fail" {
    switch (result?.status) {
        case "started":
        case "sent":
            return "ok";
        case "typed":
        case "busy":
        case "noagent":
            return "warn";
    }
    return "fail";
}
