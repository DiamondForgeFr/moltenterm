// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// When the app asks Brokk for an expression (FR-BOSS-007, AC3): a smile when a hand-off is approved or a pull request
// merges, a frown when an agent fails, a doubtful look after a long wait, a nod when the developer approves. Each rule
// reads a fact MoltenTerm already holds; none reads what an agent wrote. Pure, so the rules run against stand-ins
// (brokk-expressions.ts listens and asks).

import type { AgentStatesData } from "../agent-state-model";
import type { BrokkExpression } from "./brokk-state-model";

// An agent that waits for the developer this long gets a doubtful look, once.
export const LongWaitMs = 10 * 60 * 1000;

function keyOf(info: { blockid: string; since?: number }): string {
    return `${info.blockid}:${info.since ?? 0}`;
}

// The agents in error, each by its block and the time it entered the state: the same failure is one failure.
export function errorKeys(data: AgentStatesData): Set<string> {
    const keys = new Set<string>();
    for (const info of Object.values(data?.states ?? {})) {
        if (info?.state === "error") {
            keys.add(keyOf(info));
        }
    }
    return keys;
}

// A failure that was not there at the last reading. Without a reading before (a window starting), none: an agent that
// failed before the window opened is not news.
export function newFailure(before: ReadonlySet<string>, now: ReadonlySet<string>): boolean {
    if (before == null) {
        return false;
    }
    for (const key of now) {
        if (!before.has(key)) {
            return true;
        }
    }
    return false;
}

export type LongWaits = {
    // The waits that just crossed the limit and were not told yet.
    due: string[];
    // When the next wait crosses it, or null when none will.
    nextAt: number;
};

export function longWaits(data: AgentStatesData, now: number, told: ReadonlySet<string>): LongWaits {
    const due: string[] = [];
    let nextAt: number = null;
    for (const info of Object.values(data?.states ?? {})) {
        if (info?.state !== "waiting" || !(info.since > 0)) {
            continue;
        }
        const key = keyOf(info);
        if (told.has(key)) {
            continue;
        }
        const limit = info.since + LongWaitMs;
        if (limit <= now) {
            due.push(key);
        } else if (nextAt == null || limit < nextAt) {
            nextAt = limit;
        }
    }
    return { due, nextAt };
}

// The waits no longer there are forgotten, so that a block that waits again is told again.
export function stillWaiting(data: AgentStatesData, told: ReadonlySet<string>): Set<string> {
    const keys = new Set<string>();
    for (const info of Object.values(data?.states ?? {})) {
        if (info?.state === "waiting" && told.has(keyOf(info))) {
            keys.add(keyOf(info));
        }
    }
    return keys;
}

// The count rose since the last reading; the first reading is no rise.
export function rose(before: number, now: number): boolean {
    return before != null && now > before;
}

export function mergedCount(afterMerge: Record<string, { merged?: number[] }>): number {
    return Object.values(afterMerge ?? {}).reduce((sum, after) => sum + (after?.merged?.length ?? 0), 0);
}

// What the developer's answer on a To handle row tells him: an approved hand-off is good news, an answer given to an
// agent is an approval he nods at. A refusal or a dismissal says nothing.
export function expressionAfterAnswer(run: { kind: string; decision?: string }): BrokkExpression {
    if (run.kind === "handoff") {
        return run.decision === "once" || run.decision === "always" ? "smile" : null;
    }
    return run.kind === "answer" ? "nod" : null;
}
