// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The order of the sidebar's agents (FR-SHELL-084, #2296): stable, never moved by focus, activity or state. The
// developer's own order comes first, kept in the workspace's meta as agent terminal ids; the agents it does not hold
// follow in the order this page first saw them, so a new agent goes to the end of its project. A move stays inside the
// agent's project group. Pure, so the rules are tested without the app.

import type { AgentStateInfo } from "../agent-state-model";

export const AgentOrderMetaKey = "molten:agentorder";
// The saved list also keeps agents absent now (a terminal that restarts its agent finds its place again), up to this.
export const MaxSavedOrder = 200;

export function readAgentOrder(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const seen = new Set<string>();
    for (const v of raw) {
        if (typeof v === "string" && v !== "") {
            seen.add(v);
        }
    }
    return Array.from(seen);
}

// The ids in the order this page first saw them: the earlier ones keep their place, the new ones go last in the order
// they came. The same array when nothing came or went, so a render that changes nothing changes nothing.
export function arrivalOrder(prev: string[], agents: AgentStateInfo[]): string[] {
    const now = new Set((agents ?? []).map((a) => a.blockid));
    const kept = (prev ?? []).filter((id) => now.has(id));
    const known = new Set(kept);
    const added = (agents ?? []).map((a) => a.blockid).filter((id) => !known.has(id));
    if (added.length === 0 && kept.length === (prev ?? []).length) {
        return prev;
    }
    return [...kept, ...added];
}

// The agents in the developer's order, then the others by arrival.
export function orderAgents(agents: AgentStateInfo[], saved: string[], arrival: string[]): AgentStateInfo[] {
    const savedAt = new Map((saved ?? []).map((id, i) => [id, i]));
    const arrivedAt = new Map((arrival ?? []).map((id, i) => [id, i]));
    const rank = (a: AgentStateInfo): [number, number] =>
        savedAt.has(a.blockid) ? [0, savedAt.get(a.blockid)] : [1, arrivedAt.get(a.blockid) ?? Infinity];
    return (agents ?? [])
        .map((a, i) => ({ a, i, r: rank(a) }))
        .sort((x, y) => x.r[0] - y.r[0] || x.r[1] - y.r[1] || x.i - y.i)
        .map((x) => x.a);
}

// The shown order after `dragged` lands before or after `target`, both of `group` (the ids of one project group, as
// shown); null when the move is refused (another group, or no change). The group keeps the places it holds in the list.
export function moveWithin(
    shown: string[],
    group: string[],
    dragged: string,
    target: string,
    after: boolean
): string[] {
    if (dragged === target || !group.includes(dragged) || !group.includes(target)) {
        return null;
    }
    const rest = group.filter((id) => id !== dragged);
    const at = rest.indexOf(target) + (after ? 1 : 0);
    const next = [...rest.slice(0, at), dragged, ...rest.slice(at)];
    if (next.every((id, i) => id === group[i])) {
        return null;
    }
    return placeGroup(shown, group, next);
}

// One step up (-1) or down (+1) inside the group; null at its edge.
export function moveBy(shown: string[], group: string[], id: string, delta: -1 | 1): string[] {
    const i = group.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= group.length) {
        return null;
    }
    return moveWithin(shown, group, id, group[j], delta > 0);
}

export function canMove(group: string[], id: string, delta: -1 | 1): boolean {
    const j = group.indexOf(id) + delta;
    return group.includes(id) && j >= 0 && j < group.length;
}

// The list to save: the new shown order, then the earlier saved ids absent now, up to MaxSavedOrder.
export function savedAfterMove(shown: string[], saved: string[]): string[] {
    const here = new Set(shown);
    return [...shown, ...(saved ?? []).filter((id) => !here.has(id))].slice(0, MaxSavedOrder);
}

function placeGroup(shown: string[], group: string[], next: string[]): string[] {
    const members = new Set(group);
    let k = 0;
    return shown.map((id) => (members.has(id) ? next[k++] : id));
}
