// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Agents and Sessions panels of Brokk's group (FR-BOSS-009, AC19, #2032): the Sessions tab of #2003 split in two. Both
// read the Sessions view's own data and rules through the card model (boss-card-model.ts: grouping by workspace, first
// names, states, the time a session has run), so there is no second source of truth. Agents lists the sessions that run an
// agent; Sessions lists the terminals and the SSH sessions, which the agents no longer crowd. Each is grouped by
// workspace, the current one first. Pure, so the rules are tested without a window.
//
// It is part of the bubble's up-front JavaScript: it imports nothing of the portrait.

import { CardGroup, CardRow } from "./boss-card-model";

// The current workspace first, the others as they were (the workspaces' order); the group of sessions no pane shows
// comes right after the current one.
export function currentFirst(groups: CardGroup[]): CardGroup[] {
    return [...groups.filter((g) => g.current), ...groups.filter((g) => !g.current)];
}

function keep(groups: CardGroup[], wanted: (row: CardRow) => boolean, flat: boolean): CardGroup[] {
    return currentFirst(
        groups
            .map((group) => ({
                ...group,
                rows: group.rows.filter(wanted).map((row) => (flat ? { ...row, depth: 0 } : row)),
            }))
            .filter((group) => group.rows.length > 0)
    );
}

// The sessions that run an agent: first name, agent, model, ticket or project, state.
export function agentGroups(groups: CardGroup[]): CardGroup[] {
    return keep(groups, (row) => row.kind === "agent", false);
}

// The terminals and the SSH sessions that run no agent: name, host, state.
export function sessionGroups(groups: CardGroup[]): CardGroup[] {
    return keep(groups, (row) => row.kind !== "agent", true);
}

export function rowCount(groups: CardGroup[]): number {
    return groups.reduce((total, group) => total + group.rows.length, 0);
}

// What an agent works on, in one word: the ticket when its session names one, else the project.
export function taskOf(row: Pick<CardRow, "ticket" | "project">): string {
    return row.ticket > 0 ? `#${row.ticket}` : row.project;
}

// The workspace of a group, as a row of a panel shows it: a coloured dot and the name. The group of sessions no pane
// shows has none.
export function groupHasWorkspace(group: Pick<CardGroup, "unplaced" | "id">): boolean {
    return !group.unplaced && group.id !== "";
}
