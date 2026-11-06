// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What feeds Brokk's visits and what the avatar tells of them (FR-BOSS-009, AC1, AC11, #2002): the adapters between the
// stores the window already holds (the rows To handle, the agent states) and the visit model, and the badge the avatar
// carries. Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import type { AgentStatesData } from "../agent-state-model";
import { badgeCount } from "../notification-rules";
import type { Badge } from "./boss-overview";
import type { ToHandleItem } from "./boss-to-handle-model";
import { finishedEvents, unseenItems, visitEventsOfRows } from "./brokk-watch";
import { BrokkEvent, comingOf, VisitSettings } from "./brokk-visit-events";

const FinishedPrefix = "finished:";

function blockOfFinished(event: BrokkEvent): string {
    return event.key.slice(FinishedPrefix.length);
}

// The agents that finished and have not worked since: "an agent finished" is good news that waits on the badge until the
// agent works again, its session ends, or the developer opens Brokk (the hub forgets them then). `previous` is the set
// as it was, `before` and `now` the agent states around the change.
export function finishedSetAfter(
    previous: BrokkEvent[],
    before: AgentStatesData,
    now: AgentStatesData,
    at: number
): BrokkEvent[] {
    const kept = previous.filter((event) => now?.states?.[blockOfFinished(event)]?.state === "done");
    const known = new Set(kept.map((event) => event.key));
    const fresh = finishedEvents(before, now, at).filter((event) => !known.has(event.key));
    return fresh.length === 0 && kept.length === previous.length ? previous : [...kept, ...fresh];
}

// The rows the avatar's badge counts that are no event of the table (a question that is no agent's, a hand-off
// request): they feed no visit, and still count, as they did on the bubble (FR-BOSS-001, AC5).
export function unmappedRowCount(items: ToHandleItem[]): number {
    return items.filter((item) => !item.seen && visitEventsOfRows([item]).length === 0).length;
}

export type AvatarBadge = Badge;

// The avatar's badge: what the model counts (every event not set to Rien, finished agents included) and the rows that
// are no event. Red when a counted row is a failure, amber otherwise; 9+ beyond nine.
export function avatarBadgeOf(items: ToHandleItem[], eventCount: number, settings: VisitSettings): AvatarBadge {
    let failing = false;
    for (const item of unseenItems({ items, info: [], parked: 0 })) {
        if (item.tone !== "error") {
            continue;
        }
        const [event] = visitEventsOfRows([item]);
        if (event == null || comingOf(event.kind, settings) !== "rien") {
            failing = true;
        }
    }
    const count = eventCount + unmappedRowCount(items);
    return { count, text: badgeCount(count), tone: failing ? "error" : "waiting" };
}
