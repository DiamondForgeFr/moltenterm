// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The rules of the brainstorm mode (FR-BOSS-010 AC2 and AC3, DS-BOSS-011, #2246), pure so that they are tested without
// a window: what breaks through the pause, what the summary line counts, what the sidebar does, which answers go to
// wavesrv and under which key.

import type { AgentStatesData } from "../agent-state-model";
import type { MoltentermNotification } from "../notifications-model";
import { GraphBlock, opensBrainstorm, readGraphBlock, textMark } from "./brainstorm-graph-model";

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
        return { kind: "turn", key: `${input.turn}:g${textMark(JSON.stringify(read.block))}`, text: read.text, block: read.block, dropped: "" };
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
