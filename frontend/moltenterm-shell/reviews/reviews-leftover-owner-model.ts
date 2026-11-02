// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A leftover whose worktree a live agent holds (#1143, FR-REV-022 AC16): Clean up asks that owner to check and remove
// it (pkg/molten/review/leftover_ask.go), and the leftover's card then follows the request with the PR card's own
// states and actions (reviews-card-model.ts): "Asked {name} · waiting" with Follow {name} in Agents on it while the
// owner works on it; "{name} is waiting for you" with Answer {name}, which shows its terminal, in Yours when it needs
// the developer. Pure, so the sections and the card read the same state.

import { phrase, type Phrase } from "../i18n/phrase";
import type { CardAction, CardTone, CardTurn } from "./reviews-card-model";
import type { UpcomingLeftover } from "./reviews-upcoming-model";

// must match LeftoverAsk… in pkg/molten/review/leftover_ask.go
export const LeftoverAskCommand = "moltenleftoverask";
export const LeftoverAsksCommand = "moltenleftoverasks";
export const LeftoverAskEvent = "molten:leftover:ask";

// must match LeftoverOwner in pkg/molten/mission/leftover_owner.go
export type LeftoverOwner = {
    via: "agent" | "parent" | "terminal" | "process";
    pid: number;
    blockid?: string;
    firstname?: string;
    agent?: string;
    process?: string;
    folder?: string;
};

export type LeftoverAskState = "asked" | "needsyou" | "done" | "unreachable" | "free";

export type LeftoverAsk = {
    dir: string;
    number: number;
    worktree: string;
    branch?: string;
    owner: LeftoverOwner;
    state: LeftoverAskState;
    why?: "question" | "stopped" | "outcome";
    reason?: string;
    delivery?: string;
    askedat: number;
    endedat?: number;
};

export type LeftoverAsksAnswer = { dir: string; asks: LeftoverAsk[] };

export type LeftoverAskRequest = {
    dir: string;
    repo?: string;
    number: number;
    url?: string;
    worktree: string;
    closed?: boolean;
    base?: string;
    local?: boolean;
};

// ownerReachable: a MoltenTerm terminal runs the owner, so Clean up can ask it.
export function ownerReachable(owner: LeftoverOwner): boolean {
    return owner != null && !!owner.blockid && owner.via !== "process";
}

// heldByLiveOwner: the leftover's worktree is locked by a running process.
export function heldByLiveOwner(leftover: UpcomingLeftover): boolean {
    return leftover?.lock === "live" && leftover.owner != null;
}

// ownerName: how the card names the owner, as reviews-card-model.ts names an agent.
export function ownerName(owner: LeftoverOwner): Phrase {
    if (owner?.firstname) {
        return phrase("reviews.card.name", { name: owner.firstname });
    }
    return phrase("reviews.card.anAgent");
}

export function askOf(asks: LeftoverAsksAnswer, leftover: UpcomingLeftover): LeftoverAsk {
    if (!leftover?.worktree) {
        return null;
    }
    return (asks?.asks ?? []).find((a) => a.number === leftover.pr && a.worktree === leftover.worktree) ?? null;
}

// The card of a leftover whose owner was asked: the subset of the PR card's state (CardState) it draws.
export type LeftoverOwnerCard = {
    kind: "agent-working" | "agent-waiting";
    tone: CardTone;
    turn: CardTurn;
    sentence: Phrase;
    why?: Phrase;
    primary: CardAction;
    molten: boolean;
    history: Phrase;
};

function whyOf(ask: LeftoverAsk): Phrase {
    if (ask.reason) {
        return phrase("reviewsAgents.leftovers.owner.reason", { reason: ask.reason });
    }
    if (ask.why === "question") {
        return phrase("reviewsAgents.leftovers.owner.question");
    }
    return phrase("reviewsAgents.leftovers.owner.stopped");
}

// leftoverOwnerCard: the card's state while a request to its owner stands; null when none does (the Leftovers group's
// own card). time: when it was asked, worded by the caller.
export function leftoverOwnerCard(ask: LeftoverAsk, time: string): LeftoverOwnerCard {
    if (ask == null || ask.owner == null || (ask.state !== "asked" && ask.state !== "needsyou")) {
        return null;
    }
    const name = ownerName(ask.owner);
    const history = phrase("reviewsAgents.leftovers.owner.history", { name, time });
    if (ask.state === "needsyou") {
        return {
            kind: "agent-waiting",
            tone: "you",
            turn: "yours",
            sentence: phrase("reviews.card.state.agentWaiting", { name }),
            why: whyOf(ask),
            primary: {
                id: "answer",
                label: phrase("reviews.card.action.answer", { name }),
                blockId: ask.owner.blockid,
            },
            molten: true,
            history,
        };
    }
    return {
        kind: "agent-working",
        tone: "agent",
        turn: "agents",
        sentence: phrase("reviewsAgents.leftovers.owner.asked", { name }),
        primary: {
            id: "follow",
            label: phrase("reviews.card.action.follow", { name }),
            blockId: ask.owner.blockid,
        },
        molten: false,
        history,
    };
}

export type LeftoverTurnRow = { leftover: UpcomingLeftover; ask: LeftoverAsk };

// leftoverTurnRows: the leftovers whose owner was asked, by the section their card goes to; the others stay in the
// Leftovers group.
export function leftoverTurnRows(
    leftovers: readonly UpcomingLeftover[],
    asks: LeftoverAsksAnswer
): Partial<Record<CardTurn, LeftoverTurnRow[]>> {
    const rtn: Partial<Record<CardTurn, LeftoverTurnRow[]>> = {};
    for (const leftover of leftovers ?? []) {
        const ask = askOf(asks, leftover);
        const card = leftoverOwnerCard(ask, "");
        if (card == null) {
            continue;
        }
        (rtn[card.turn] ??= []).push({ leftover, ask });
    }
    return rtn;
}

// leftoverAway: the leftover's card is in a PR section (its owner asked), not in the Leftovers group; a request done
// keeps it out until wavesrv answers after it.
export function leftoverAway(leftover: UpcomingLeftover, asks: LeftoverAsksAnswer, upcomingAt: number): boolean {
    const ask = askOf(asks, leftover);
    if (ask == null) {
        return false;
    }
    if (ask.state === "done") {
        return (upcomingAt ?? 0) <= (ask.endedat ?? 0);
    }
    return ask.state === "asked" || ask.state === "needsyou";
}

// unreachableOwner: who holds a lock MoltenTerm cannot ask (no MoltenTerm terminal runs it).
export function unreachableOwner(leftover: UpcomingLeftover): LeftoverOwner {
    if (!heldByLiveOwner(leftover) || ownerReachable(leftover.owner)) {
        return null;
    }
    return leftover.owner;
}
