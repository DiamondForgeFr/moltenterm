// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the Sessions card tells and when it steps away (FR-BOSS-002, DS-BOSS-002): the rows are the Sessions view's own
// data and rules (sessions-model.ts: grouping by workspace in the workspaces' order, first names, states, the time a
// session has run), shortened to a line and a half; the card is a layer over the app, hidden by a second click, Escape,
// a click outside or its close control, and the focus goes back to where it was unless the developer put it elsewhere.
// Pure, so the rules are tested without a window.

import { agentStateLabel } from "../agent-state-model";
import { t } from "../i18n/i18n";
import {
    agentCell,
    canReconnect,
    connChip,
    displayFolder,
    DurableSession,
    DurableSessionsData,
    formatAge,
    groupSessions,
    HiddenGroupId,
    modelText,
    reasonTitle,
    rowName,
    SessionConnState,
} from "../sessions/sessions-model";

export const CardTestId = "boss-card";
// Marks the bubble and the pennant: a press on them is the toggle's, never an outside press.
export const AnchorAttr = "data-boss-anchor";
// Marks the card, so the focus restore knows the focus is still in a card that is going away.
export const CardAttr = "data-boss-card";

export type CardRow = {
    id: string;
    depth: number;
    name: string;
    kind: "agent" | "command" | "shell";
    // The agent that runs ("Claude Code"), "" for a session with none.
    agentName: string;
    // The model and effort of the agent, "" when unknown.
    model: string;
    // The ticket the session works on, 0 when it names none.
    ticket: number;
    // The connection of an SSH session is lost and can be made again.
    canReconnect: boolean;
    workspaceId: string;
    // The agent's state, "" for a session that runs no agent.
    state: string;
    stateText: string;
    project: string;
    branch: string;
    up: string;
    // The host of a session that does not run on this computer, "" for a local one.
    host: string;
    hostState: SessionConnState;
    hostTitle: string;
    // The session has a pane (Go to), or none (Show it).
    shown: boolean;
    canShow: boolean;
    // Why Go to is unavailable, as the Sessions view says it.
    blockedTitle: string;
};

export type CardGroup = {
    id: string;
    title: string;
    color: string;
    current: boolean;
    // The sessions no pane shows.
    unplaced: boolean;
    rows: CardRow[];
};

function lastSegment(path: string): string {
    const parts = (path ?? "").split(/[/\\]+/).filter((p) => p !== "");
    return parts[parts.length - 1] ?? "";
}

// The project a session works in: the repository's main checkout when it runs in a worktree, else the repository its
// pull request names, else its folder.
export function sessionProject(s: DurableSession, home: string): string {
    const main = lastSegment(s.worktree?.main);
    if (main !== "") {
        return main;
    }
    const repo = lastSegment(s.context?.repo);
    if (repo !== "") {
        return repo;
    }
    const folder = displayFolder(s, home);
    return folder === "~" ? t("sessions.home") : lastSegment(folder);
}

export function sessionBranch(s: DurableSession): string {
    return s.worktree?.branch || s.context?.branch || "";
}

export function cardRow(s: DurableSession, depth: number, home: string, nowMs: number): CardRow {
    const cell = agentCell(s);
    const name = rowName(s, home);
    const project = sessionProject(s, home);
    const conn = connChip(s);
    return {
        id: s.id,
        depth,
        name,
        kind: cell.kind,
        agentName: cell.kind === "agent" ? cell.label : "",
        model: cell.kind === "agent" ? modelText(s) : "",
        ticket: s.context?.ticket ?? 0,
        canReconnect: canReconnect(s),
        workspaceId: s.workspaceid ?? "",
        state: cell.kind === "agent" ? s.agentstate || "idle" : "",
        stateText: cell.kind === "agent" ? agentStateLabel(s.agentstate || "idle") : cell.label,
        // A shell named after its folder says its project once.
        project: project === name ? "" : project,
        branch: sessionBranch(s),
        up: formatAge(s.startedat, nowMs),
        host: s.connection ?? "",
        hostState: conn.state,
        hostTitle: conn.title,
        shown: s.shown,
        canShow: s.canshow,
        blockedTitle: s.canshow ? "" : reasonTitle(s.reason),
    };
}

// Every running session in the Sessions view's groups: the ones no pane shows first, then a group per workspace in the
// workspaces' order, a sub-session under the session that handed it work.
export function cardGroups(
    data: DurableSessionsData,
    currentWorkspaceId: string,
    home: string,
    nowMs: number
): CardGroup[] {
    return groupSessions(data?.sessions ?? [], currentWorkspaceId).map((group) => ({
        id: group.id,
        title: group.title,
        color: group.color ?? "",
        current: group.current === true,
        unplaced: group.id === HiddenGroupId,
        rows: group.sessions.map((s) => cardRow(s, Math.min(group.depths?.[s.id] ?? 0, 3), home, nowMs)),
    }));
}

export function cardRowCount(groups: CardGroup[]): number {
    return groups.reduce((total, group) => total + group.rows.length, 0);
}

// The slice of an element the card's rules read, so they run against stand-ins in the tests.
export type NodeLike = {
    contains?: (other: any) => boolean;
    closest?: (selector: string) => any;
};

// A press lands outside the card unless it is in the card or on the bubble or the pennant, whose click toggles it.
export function isOutsidePress(target: NodeLike, card: NodeLike): boolean {
    if (target == null) {
        return false;
    }
    if (card?.contains?.(target) === true) {
        return false;
    }
    return target.closest?.(`[${AnchorAttr}]`) == null;
}

export type CardKeyInput = {
    key: string;
    // The focus is in the card, on the bubble or the pennant, or nowhere (the page body).
    focusAtHome: boolean;
};

// Escape hides the card wherever the focus is. When it is at home the key is the card's alone; when it is in a
// terminal the key goes on to the terminal as well: a vim user's Escape is never taken.
export function cardKeyAction(input: CardKeyInput): { hide: boolean; consume: boolean } {
    if (input.key !== "Escape") {
        return { hide: false, consume: false };
    }
    return { hide: true, consume: input.focusAtHome };
}

export type FocusTarget = { focus: (options?: { preventScroll?: boolean }) => void; isConnected?: boolean };

export type FocusDom = { activeElement?: any; body?: any };

// The element to give the focus back to: the one that held it when the card opened, none for the page itself.
export function focusTargetOf(element: any, dom: FocusDom): FocusTarget {
    if (element == null || element === dom?.body || typeof element.focus !== "function") {
        return null;
    }
    return element;
}

// The developer's own choice stands: the focus goes back only when nothing has taken it since the card closed (it is
// on the page body, gone with the card, or still in the card that is leaving).
export function focusIsFree(dom: FocusDom): boolean {
    const active = dom?.activeElement;
    if (active == null || active === dom?.body || active.isConnected === false) {
        return true;
    }
    return active.closest?.(`[${CardAttr}]`) != null;
}

export function restoreFocus(target: FocusTarget, dom: FocusDom): boolean {
    if (target == null || target.isConnected === false || !focusIsFree(dom)) {
        return false;
    }
    target.focus({ preventScroll: true });
    return true;
}
