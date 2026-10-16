// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Restart work (FR-REV-011, DS-REV-009): the rules of the Review tab's button and status line, kept apart from the
// components so they can be tested without the app. The work itself is wavesrv's (pkg/molten/review/restart.go).

import type { AgentStateInfo } from "../agent-state-model";
import { agentLabel, agentStateLabel } from "../agent-state-model";
import { t } from "../i18n/i18n";
import { serverText } from "../i18n/server-text";
import type { ReviewRestartResult, ReviewRound, ReviewState } from "./review-client";

// The strings of Restart work in the interface language; the prompt and the brief the agent gets stay in English
// (wavesrv's).
export const RestartText = {
    button: () => t("review.restart.button"),
    restarting: () => t("review.restart.restarting"),
    noRound: () => t("review.restart.noRound"),
    enabled: (round: number) => t("review.restart.enabled", { round }),
    again: (round: number) => t("review.restart.again", { round }),
    working: (agent: string, state: string, round: number) => t("review.restart.working", { agent, state, round }),
    noAgentNow: (round: number) => t("review.restart.noAgentNow", { round }),
    inWorktree: (folder: string) => t("review.restart.inWorktree", { folder }),
    pushed: (round: number) => t("review.restart.pushed", { round }),
    showSince: () => t("review.restart.showSince"),
    showAgent: () => t("review.restart.showAgent"),
    dismiss: () => t("review.restart.dismiss"),
};

// restartOutcome says what the last click did, from the result's status and reason (pkg/molten/review/restart.go);
// wavesrv's English message is only the detail of an error.
export function restartOutcome(result: ReviewRestartResult, error?: string): string {
    if (error) {
        return t("review.restart.outcome.failed", { message: error });
    }
    if (result == null) {
        return "";
    }
    const vars = {
        agent: result.agentname || result.agent || "",
        folder: folderName(result.worktree),
        brief: result.briefpath ?? "",
        branch: result.branch ?? "",
        state: agentStateLabel(result.agentstate ?? "working"),
        message: serverText(result.messagetext, result.message ?? ""),
        chosen: result.chosenname ?? "",
    };
    // #845: an agent already on the branch took the round, not the one the developer chose.
    const notChosen =
        result.chosenname && result.agent && result.chosenagent !== result.agent
            ? " " + t("review.restart.outcome.notChosen", vars)
            : "";
    switch (result.reason || result.status) {
        case "started":
            return t(result.hidden ? "review.restart.outcome.startedHidden" : "review.restart.outcome.started", vars);
        case "sent":
            return t("review.restart.outcome.sent", vars) + notChosen;
        case "typed":
            return t("review.restart.outcome.typed", vars) + notChosen;
        case "noagent":
            return t("review.restart.outcome.noagent", vars);
        case "agentmissing":
            return t("review.restart.outcome.agentmissing", vars);
        case "noround":
            return t("review.restart.outcome.noround");
        case "inflight":
            return t("review.restart.outcome.inflight");
        case "agentbusy":
            return t("review.restart.outcome.agentbusy", vars);
        case "notready":
            return t("review.restart.outcome.notready", vars);
        case "maincheckout":
            return t("review.restart.outcome.maincheckout", vars);
        case "worktree":
            return t("review.restart.outcome.worktree", vars);
        case "brief":
            return t("review.restart.outcome.brief", vars);
        case "terminal":
            return t("review.restart.outcome.terminal");
        case "notstarted":
            return t("review.restart.outcome.notstarted", vars);
        case "nottyped":
            return t("review.restart.outcome.nottyped", vars);
    }
    return t("review.restart.outcome.failed", vars);
}

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
        return RestartText.noRound();
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
