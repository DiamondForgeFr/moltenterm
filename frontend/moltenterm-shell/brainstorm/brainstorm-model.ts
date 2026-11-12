// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The rules of the brainstorm mode (FR-BOSS-010 AC2 and AC3, DS-BOSS-011, #2246), pure so that they are tested without
// a window: what breaks through the pause, what the summary line counts, what the sidebar does, which answers go to
// wavesrv and under which key.

import type { AgentStatesData } from "../agent-state-model";
import type { MoltentermNotification } from "../notifications-model";
import type { BrainstormPrompt, BrainstormSummary } from "./brainstorm-boot";
import {
    BlockQuestions,
    GraphBlock,
    opensBrainstorm,
    questionsOf,
    readGraphBlock,
    textMark,
} from "./brainstorm-graph-model";

// How many brainstorms the picker offers to resume on entry (AC10a, #2248).
export const PickerRecent = 3;

// What the developer's start of a brainstorm offers (AC10a): the most recent ones to resume, or nothing when none is
// saved (he then says his opening line). The one last left comes first (AC10e, #2284).
export function pickerOf(list: BrainstormSummary[], lastSlug = ""): BrainstormPrompt {
    const saved = (list ?? []).filter((entry) => entry?.slug);
    if (saved.length === 0) {
        return null;
    }
    const last = saved.findIndex((entry) => entry.slug === lastSlug);
    if (last > 0) {
        saved.unshift(...saved.splice(last, 1));
    }
    return { kind: "picker", recent: saved.slice(0, PickerRecent), total: saved.length };
}

// When a brainstorm last changed, as the widget and the questions say it: the day and the time.
export function lastChange(at: number, locale: string): string {
    if (!at) {
        return "";
    }
    try {
        return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(at));
    } catch {
        return new Date(at).toLocaleString();
    }
}

// The brainstorms the widget lists beside the open one, the one changed last first.
export function othersOf(list: BrainstormSummary[], currentSlug: string): BrainstormSummary[] {
    return (list ?? []).filter((entry) => entry?.slug && entry.slug !== currentSlug);
}

// His questions in a complete answer (#2248), once per answer; null when it asks none. Only a final answer asks: a
// block still being written could change.
export function answerQuestions(input: { markdown: string; final: boolean; allowed: boolean }): BlockQuestions {
    if (!input.allowed || !input.final) {
        return null;
    }
    const read = readGraphBlock(input.markdown);
    if (read.block == null) {
        return null;
    }
    const questions = questionsOf(read.block);
    return questions.fork == null && questions.resume == null && questions.forget == null ? null : questions;
}

// Only what cannot wait breaks through the pause, discreetly at the layer's edge and never as a toast (decided
// 2026-11-11): a serious security alert, which in MoltenTerm is a run refused until the developer trusts it, and an agent
// that crashed. Everything else waits in the center, and the badge counts it.
export function breaksThrough(entry: MoltentermNotification): boolean {
    if (entry == null || entry.read || entry.resolved != null || entry.archived != null) {
        return false;
    }
    if (entry.source === "trust") {
        return true;
    }
    return entry.kind === "error" && (entry.source === "agent" || entry.source === "sessions");
}

// The agents that went into error since `before`: an agent that crashed during the mode.
export function newlyCrashed(before: AgentStatesData, after: AgentStatesData): string[] {
    const rtn: string[] = [];
    for (const [blockId, info] of Object.entries(after?.states ?? {})) {
        if (info?.state !== "error") {
            continue;
        }
        if (before?.states?.[blockId]?.state === "error") {
            continue;
        }
        rtn.push(blockId);
    }
    return rtn;
}

// What arrived during the mode: unread notifications that are new or changed since the mode began, each counted once.
export type Tally = { ids: ReadonlySet<string> };

export const EmptyTally: Tally = { ids: new Set() };

export function tallied(tally: Tally, entries: MoltentermNotification[], seen: Map<string, number>): Tally {
    let ids: Set<string> = null;
    for (const e of entries) {
        if (e.read || e.archived != null || e.resolved != null || seen.get(e.id) === e.updated || tally.ids.has(e.id)) {
            continue;
        }
        ids ??= new Set(tally.ids);
        ids.add(e.id);
    }
    return ids == null ? tally : { ids };
}

// The sidebar slides in when the mode opens, if it was docked (AC2); it comes back on exit only if MoltenTerm slid it
// and the developer did not show it again meanwhile: the developer's own toggle wins.
export function sidebarOnOpen(enabled: boolean, hidden: boolean): "slide" | "stay" {
    return enabled && !hidden ? "slide" : "stay";
}

export function sidebarOnClose(slidByMode: boolean, hiddenNow: boolean): "restore" | "stay" {
    return slidByMode && hiddenNow ? "restore" : "stay";
}

// One reading of his answer, as the brainstorm takes it: the block it carries once complete, and when to tell wavesrv.
export type AnswerStep =
    // Nothing to do yet (the block is still being written, or the mode is off and the answer opens nothing).
    | { kind: "wait" }
    // A turn for wavesrv: his words without the block, the block if any, and the key that applies it once.
    | { kind: "turn"; key: string; text: string; block: GraphBlock; dropped: string };

// When a reading goes to wavesrv: as soon as a valid block is complete (the graph grows while he finishes his line),
// else once his agent is done (a turn of words only, or a block that was dropped). Outside the mode only an answer that
// opens a brainstorm goes. `turn` is his transcript's, which names the answer across readings.
export function answerStep(input: {
    markdown: string;
    turn: number;
    final: boolean;
    open: boolean;
    allowed: boolean;
}): AnswerStep {
    if (!input.allowed) {
        return { kind: "wait" };
    }
    const read = readGraphBlock(input.markdown);
    if (read.block != null) {
        if (!input.open && !opensBrainstorm(read.block)) {
            return { kind: "wait" };
        }
        return {
            kind: "turn",
            key: `${input.turn}:g${textMark(JSON.stringify(read.block))}`,
            text: read.text,
            block: read.block,
            dropped: "",
        };
    }
    if (!input.open || !input.final || read.problem === "open") {
        return { kind: "wait" };
    }
    return {
        kind: "turn",
        key: `${input.turn}:t${textMark(read.text)}`,
        text: read.text,
        block: null,
        dropped: read.problem === "invalid" ? (read.reason ?? "invalid") : "",
    };
}
