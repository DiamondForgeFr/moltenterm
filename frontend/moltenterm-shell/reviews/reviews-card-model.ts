// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews card's one state (#1060, FR-REV-001 AC11, FR-REV-022 AC10, FR-REV-028 AC12): computed from the PR, every
// agent on its branch and the task asked, it decides the card's rail colour, its state sentence, its one primary action
// and the "…" menu. Everything else is a muted fact. Pure, so the sections (#1061), the merge queue (#1062) and the
// motion (#1063) read the same state. Sentences are phrases (key + vars), worded where they show.

import { phrase, type Phrase } from "../i18n/phrase";
import { blockedReasons, checkNames, checksOf, ReviewPr } from "./reviews-model";
import type { PrTask, PrTaskState } from "./reviews-task-model";
import type { AgentBarFacts, DraftTurn } from "./reviews-upcoming-model";

// In precedence order: the first that applies is the card's state.
export const CardStateKinds = [
    "agent-waiting",
    "agent-working",
    "interrupted",
    "conflicts",
    "failing",
    "review-required",
    "draft-ready",
    "ci-running",
    "ready",
] as const;

export type CardStateKind = (typeof CardStateKinds)[number];

// The rail: green you can move it forward, amber your turn, orange an agent works, red broken and nobody on it, grey
// waiting on the CI or a reviewer.
export type CardTone = "ready" | "you" | "agent" | "broken" | "wait";

// Whose turn the card is, for the sections by turn (#1061).
export type CardTurn = "yours" | "agents" | "blocked" | "waiting";

export type CardActionId =
    | "answer"
    | "follow"
    | "relaunch"
    | "start-agent"
    | "rebase"
    | "investigate"
    | "assisted-review"
    | "mark-ready"
    | "validate"
    | "open-work"
    | "stop"
    | "rerun"
    | "launch"
    | "github";

// An action of the card. disabled: why GitHub refuses it (shown, never hidden); confirm: what the developer confirms
// before it runs (#943: a soft signal asks, it never blocks); blockId: the agent's terminal it acts on.
export type CardAction = {
    id: CardActionId;
    label: Phrase;
    disabled?: Phrase;
    confirm?: Phrase;
    blockId?: string;
};

export type CardFactTone = "ok" | "soft" | "bad" | "muted";

export type CardFact = { id: string; text: Phrase; tone: CardFactTone };

export type CardState = {
    kind: CardStateKind;
    tone: CardTone;
    turn: CardTurn;
    sentence: Phrase;
    why?: Phrase;
    // The agent the state is about (states 1 to 3), when one is known.
    agent?: AgentBarFacts;
    primary: CardAction;
    // molten: the primary is the developer's move now (one orange button per card at most); else a calm button.
    molten: boolean;
    menu: CardAction[];
    facts: CardFact[];
    // What a stopped task left, one muted line ("Salomé stopped without fixing Backend").
    history?: Phrase;
};

export type CardInput = {
    pr: ReviewPr;
    // Every agent of the branch, most urgent first (branchAgents).
    agents: AgentBarFacts[];
    task?: PrTask;
    taskState?: PrTaskState;
    // The task's own agent (taskAgent), live or not.
    taskOwner?: AgentBarFacts;
    taskLive?: boolean;
    // A draft's turn from its board column or a recent commit, when no agent shows (draftTurn).
    boardTurn?: DraftTurn;
    // Board column, worded by the caller.
    boardStatus?: string;
    // Checks the list confirmed failing on the PR's head after a stopped task (headStillFails).
    headFails?: string[];
    // The PR can be rerun on GitHub Actions (rerunnable).
    rerunnable?: boolean;
    // Its rank in the suggested merge order.
    rank?: number;
};

const Tones: Record<CardStateKind, CardTone> = {
    "agent-waiting": "you",
    "agent-working": "agent",
    interrupted: "you",
    conflicts: "broken",
    failing: "broken",
    "review-required": "you",
    "draft-ready": "ready",
    "ci-running": "wait",
    ready: "ready",
};

const Turns: Record<CardStateKind, CardTurn> = {
    "agent-waiting": "yours",
    "agent-working": "agents",
    interrupted: "yours",
    conflicts: "blocked",
    failing: "blocked",
    "review-required": "yours",
    "draft-ready": "yours",
    "ci-running": "waiting",
    ready: "yours",
};

// Calm primaries: nothing is the developer's to do right now.
const CalmKinds = new Set<CardStateKind>(["agent-working", "ci-running"]);

// agentName: how the card names an agent: its first name, a sub-agent by its parent, a background agent by its
// parent session when known.
export function agentName(agent: AgentBarFacts): Phrase {
    if (agent == null) {
        return phrase("reviews.card.anAgent");
    }
    if (agent.kind === "panel" && agent.name) {
        return phrase("reviews.card.name", { name: agent.name });
    }
    if (agent.parentName) {
        return phrase("reviews.card.name", { name: agent.parentName });
    }
    return phrase("reviews.card.anAgent");
}

// The terminal to show for an agent: its own panel, a sub-agent's or background agent's parent.
export function agentBlockId(agent: AgentBarFacts): string {
    if (agent == null) {
        return "";
    }
    return agent.kind === "panel" ? (agent.blockId ?? "") : (agent.parentBlockId ?? "");
}

function isWorking(agent: AgentBarFacts): boolean {
    return agent.state === "working" || agent.kind === "background";
}

// validateRefusal: why GitHub refuses the merge, as the menu says it (validateBlocked's reasons).
export function validateRefusal(pr: ReviewPr): Phrase {
    if (pr.draft) {
        return phrase("reviews.validate.draft");
    }
    if (pr.merge === "conflicts") {
        return phrase("reviews.validate.conflicts", { base: pr.base });
    }
    if (pr.merge === "blocked") {
        return phrase("reviews.merge.blockedWhy", { reasons: blockedReasons(pr).join("; ") });
    }
    return null;
}

function ciPending(pr: ReviewPr): boolean {
    return (pr.ci?.pending ?? 0) > 0 || pr.ci?.state === "pending" || pr.merge === "running";
}

function changesRequested(pr: ReviewPr): boolean {
    return (pr.reviewdecision ?? "").toUpperCase() === "CHANGES_REQUESTED";
}

function reviewRequired(pr: ReviewPr): boolean {
    return (pr.reviewdecision ?? "").toUpperCase() === "REVIEW_REQUIRED";
}

// pickKind: the card's state, the first of CardStateKinds that applies.
function pickKind(input: CardInput, waiting: AgentBarFacts, working: AgentBarFacts): CardStateKind {
    const { pr } = input;
    if (waiting != null) {
        return "agent-waiting";
    }
    if (working != null || (input.boardTurn?.owner === "agent" && pr.draft)) {
        return "agent-working";
    }
    // A stopped task whose session is still open; one whose session is gone falls to the PR's own state, with its
    // history, and reads as interrupted only when nothing else is left.
    if (input.taskState === "stuck" && input.taskLive) {
        return "interrupted";
    }
    if (pr.merge === "conflicts") {
        return "conflicts";
    }
    if (checksOf(pr.ci, "failure").length > 0 || changesRequested(pr)) {
        return "failing";
    }
    if (input.taskState === "stuck") {
        return "interrupted";
    }
    if (pr.merge === "blocked" && (reviewRequired(pr) || !ciPending(pr))) {
        return "review-required";
    }
    if (ciPending(pr) || pr.merge === "unknown") {
        return "ci-running";
    }
    if (pr.draft) {
        return "draft-ready";
    }
    return "ready";
}

function taskWhat(task: PrTask): Phrase {
    return phrase(`reviewsAgents.task.what.${task?.kind ?? "rebase"}`);
}

// The facts line: what is true and worth knowing, never a state; said says what the sentence already names.
function cardFacts(input: CardInput, kind: CardStateKind, said: Set<string>): CardFact[] {
    const { pr } = input;
    const facts: CardFact[] = [];
    const checks = pr.ci?.checks ?? [];
    const failed = checksOf(pr.ci, "failure");
    const success = pr.ci?.success ?? 0;
    const pending = pr.ci?.pending ?? 0;
    if (failed.length > 0 && !said.has("ci")) {
        facts.push({
            id: "ci",
            text: phrase("reviews.card.fact.ciFailing", { names: checkNames(failed) }),
            tone: "bad",
        });
    } else if (failed.length > 0 && success > 0) {
        facts.push({ id: "ci", text: phrase("reviews.card.fact.othersGreen", { count: success }), tone: "muted" });
    } else if (pending > 0 && kind !== "ci-running") {
        facts.push({
            id: "ci",
            text: phrase("reviews.card.fact.ciRunning", { success, total: checks.length, pending }),
            tone: "muted",
        });
    } else if (checks.length > 0 && failed.length === 0 && pending === 0) {
        facts.push({
            id: "ci",
            text: phrase("reviews.card.fact.ciGreen", { success, total: checks.length }),
            tone: "ok",
        });
    }
    if (pr.report?.state === "present") {
        facts.push({ id: "report", text: phrase("reviews.card.fact.report"), tone: "ok" });
    } else if (pr.report?.state === "missing") {
        facts.push({ id: "report", text: phrase("reviews.card.fact.noReport"), tone: "soft" });
    }
    if (pr.merge === "conflicts" && !said.has("conflicts")) {
        facts.push({ id: "conflicts", text: phrase("reviews.card.fact.conflicts", { base: pr.base }), tone: "bad" });
    }
    if (pr.merge === "behind") {
        facts.push({ id: "behind", text: phrase("reviews.card.fact.behind", { base: pr.base }), tone: "muted" });
    }
    if (changesRequested(pr) && !said.has("changes")) {
        facts.push({ id: "changes", text: phrase("reviews.card.fact.changes"), tone: "soft" });
    }
    if (pr.unpublished > 0) {
        facts.push({
            id: "unpublished",
            text: phrase(pr.unpublished === 1 ? "reviews.card.fact.unpublishedOne" : "reviews.card.fact.unpublished", {
                count: pr.unpublished,
            }),
            tone: "soft",
        });
    }
    if (input.rank != null) {
        facts.push({ id: "rank", text: phrase("reviews.card.fact.rank", { rank: input.rank }), tone: "muted" });
    }
    if (input.boardStatus && !said.has("board")) {
        facts.push({
            id: "board",
            text: phrase("reviews.card.fact.board", { status: input.boardStatus }),
            tone: "muted",
        });
    }
    return facts;
}

// The merge action of the menu: Validate on a ready PR, Mark ready on a draft; refused or confirmed as it must be.
function mergeAction(input: CardInput, working: AgentBarFacts): CardAction {
    const { pr } = input;
    const notes: Phrase[] = [];
    if (working != null) {
        notes.push(phrase("reviews.card.confirm.agentWorking", { name: agentName(working) }));
    }
    if (pr.draft) {
        if (pr.report?.state === "missing") {
            notes.push(phrase("reviews.card.confirm.noReport"));
        }
        return {
            id: "mark-ready",
            label: phrase("reviews.card.action.markReady"),
            confirm: notes.length > 0 ? { join: notes, sep: " " } : undefined,
        };
    }
    const refused = validateRefusal(pr);
    if (refused != null) {
        return { id: "validate", label: phrase("reviews.validate.button"), disabled: refused };
    }
    return {
        id: "validate",
        label: phrase("reviews.validate.button"),
        confirm: notes.length > 0 ? { join: notes, sep: " " } : undefined,
    };
}

function action(id: CardActionId, key: string, vars?: Record<string, string | number | Phrase>): CardAction {
    return { id, label: phrase(key, vars) };
}

const AssistedReview = (): CardAction => action("assisted-review", "reviews.card.action.assistedReview");
const Launch = (): CardAction => action("launch", "reviews.card.action.launch");
const Github = (): CardAction => action("github", "reviews.card.action.github");

// The agent's own actions in the menu: its work beside the diff, and Stop (panels only: a terminal to act on).
function agentActions(agent: AgentBarFacts): CardAction[] {
    if (agent?.kind !== "panel" || !agent.blockId) {
        return [];
    }
    return [
        { ...action("open-work", "reviews.card.action.openWork"), blockId: agent.blockId },
        { ...action("stop", "reviews.card.action.stop", { name: agentName(agent) }), blockId: agent.blockId },
    ];
}

// Relaunch {name} (the agent's task again), distinct from Rerun failed jobs (GitHub's jobs): only for a stopped task.
function relaunchAction(input: CardInput): CardAction {
    if (input.task == null || input.taskState !== "stuck") {
        return null;
    }
    if (input.taskLive) {
        return action("relaunch", "reviews.card.action.relaunch", { name: input.task.name || "" });
    }
    return action("start-agent", "reviews.card.action.startAgent");
}

// cardState: the card's one state, its sentence, its primary action, its menu and its facts.
export function cardState(input: CardInput): CardState {
    const { pr } = input;
    const agents = input.agents ?? [];
    const waiting = agents.find((a) => a.kind === "panel" && a.state === "waiting");
    const working = agents.find(isWorking);
    const kind = pickKind(input, waiting, working);
    const failed = checksOf(pr.ci, "failure");
    const said = new Set<string>();
    let sentence: Phrase;
    let why: Phrase;
    let agent: AgentBarFacts;
    let primary: CardAction;
    let menu: CardAction[] = [];
    let history: Phrase;
    const relaunch = relaunchAction(input);
    if (input.task != null && input.taskState === "stuck" && !input.taskLive && kind !== "interrupted") {
        history = phrase("reviews.card.history.gone", { name: input.task.name || "", what: taskWhat(input.task) });
    }
    switch (kind) {
        case "agent-waiting":
            agent = waiting;
            sentence = phrase("reviews.card.state.agentWaiting", { name: agentName(waiting) });
            primary = {
                ...action("answer", "reviews.card.action.answer", { name: agentName(waiting) }),
                blockId: waiting.blockId,
            };
            menu = [...agentActions(waiting), Github()];
            break;
        case "agent-working": {
            agent = working;
            const name = agentName(working);
            const task = input.task;
            const onTask =
                working != null && task != null && input.taskState === "running" && input.taskOwner === working;
            sentence =
                working == null
                    ? phrase("reviews.card.state.agentAway")
                    : onTask
                      ? phrase(`reviews.card.state.agentOn.${task.kind}`, { name, base: pr.base })
                      : phrase("reviews.card.state.agentWorking", { name });
            if (onTask && task.kind === "rebase") {
                said.add("conflicts");
            } else if (pr.merge === "conflicts") {
                why = phrase("reviews.card.why.conflicts", { base: pr.base });
                said.add("conflicts");
            } else if (failed.length > 0) {
                why = phrase("reviews.card.why.ciFailing", { names: checkNames(failed) });
                said.add("ci");
            } else if (input.boardStatus) {
                why = phrase("reviews.card.why.board", { status: input.boardStatus });
                said.add("board");
            } else if (working == null) {
                why = phrase("reviews.card.why.recentCommit");
            }
            const blockId = agentBlockId(working);
            primary = blockId
                ? { ...action("follow", "reviews.card.action.follow", { name }), blockId }
                : AssistedReview();
            menu = [
                ...agentActions(working),
                ...(primary.id === "follow" ? [AssistedReview()] : []),
                mergeAction(input, working ?? null),
                Launch(),
                Github(),
            ];
            break;
        }
        case "interrupted": {
            agent = input.taskLive ? input.taskOwner : null;
            const name = input.task?.name || "";
            sentence = phrase("reviews.card.state.interrupted");
            // The agent's own line says what the stopped rebase left.
            if (input.task?.kind === "rebase") {
                said.add("conflicts");
            }
            why = phrase(input.taskLive ? "reviews.card.why.interrupted" : "reviews.card.why.interruptedGone", {
                name,
                what: taskWhat(input.task),
            });
            primary = relaunch ?? action("start-agent", "reviews.card.action.startAgent");
            menu = [...agentActions(agent), Github()];
            break;
        }
        case "conflicts":
            sentence = phrase("reviews.card.state.conflicts", { base: pr.base });
            why = phrase("reviews.card.why.nobody");
            said.add("conflicts");
            primary = action("rebase", "reviews.card.action.rebase");
            menu = [AssistedReview(), mergeAction(input, null), Github()];
            break;
        case "failing": {
            said.add("ci");
            if (failed.length > 0) {
                sentence = phrase("reviews.card.state.failing", { names: checkNames(failed) });
                if ((input.headFails?.length ?? 0) > 0) {
                    why = phrase("reviews.card.why.onHead");
                }
            } else {
                sentence = phrase("reviews.card.state.changes");
                said.add("changes");
            }
            primary = action("investigate", "reviews.card.action.investigate");
            menu = [
                ...(input.rerunnable && failed.length > 0
                    ? [action("rerun", "reviews.card.action.rerun", { names: checkNames(failed) })]
                    : []),
                ...(relaunch != null ? [relaunch] : []),
                mergeAction(input, null),
                AssistedReview(),
                Github(),
            ];
            break;
        }
        case "review-required":
            if (reviewRequired(pr)) {
                sentence = phrase("reviews.card.state.reviewRequired");
                why = phrase("reviews.card.why.approval");
            } else {
                sentence = phrase("reviews.card.state.blockedRule");
                why = phrase("reviews.card.why.reasons", { reasons: blockedReasons(pr).join("; ") });
            }
            primary = AssistedReview();
            menu = [mergeAction(input, null), Launch(), Github()];
            break;
        case "draft-ready":
            sentence = phrase("reviews.card.state.draftReady");
            why = phrase("reviews.card.why.yours");
            primary = mergeAction(input, null);
            menu = [AssistedReview(), Launch(), Github()];
            break;
        case "ci-running": {
            const running = checksOf(pr.ci, "pending");
            const total = pr.ci?.checks?.length ?? 0;
            if (running.length > 0 || (pr.ci?.pending ?? 0) > 0) {
                sentence = phrase("reviews.card.state.ciRunning");
                why =
                    running.length > 0
                        ? phrase("reviews.card.why.running", {
                              count: running.length,
                              total,
                              names: checkNames(running),
                          })
                        : undefined;
            } else {
                sentence = phrase("reviews.card.state.mergeChecking");
            }
            said.add("ci");
            primary = AssistedReview();
            menu = [mergeAction(input, null), Launch(), Github()];
            break;
        }
        case "ready":
            sentence = phrase("reviews.card.state.ready");
            primary = mergeAction(input, null);
            menu = [AssistedReview(), Launch(), Github()];
            break;
    }
    return {
        kind,
        tone: Tones[kind],
        turn: Turns[kind],
        sentence,
        why,
        agent,
        primary,
        molten: !CalmKinds.has(kind) && primary.disabled == null,
        menu: menu.filter((a) => a != null && a.id !== primary.id),
        facts: cardFacts(input, kind, said),
        history,
    };
}
