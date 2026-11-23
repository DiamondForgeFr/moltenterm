// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Brokk's scope in a window (FR-BOSS-009, FR-SHELL-158, #2476): he stays one character for the whole app, but in a
// window he only talks about that window's context. The rows To handle, the agents behind his visits, the badge and the
// counts are those of the workspaces of the window's context; a row that names no workspace (a download, an update, the
// plan usage) is the app's and stays. Notifications are unchanged. These are the rules, apart from the stores.

import type { AgentStatesData } from "../agent-state-model";
import type { InfoItem, ToHandleItem, ToHandleList } from "../boss/boss-to-handle-model";

// What the window knows of where every workspace is.
export type ContextScopeFacts = {
    // workspace id → the id of its context, for every workspace (the one on screen included).
    contextOf: Record<string, string>;
    // A project folder → the context of the workspace whose project it is: a pull request names a folder, not a workspace.
    dirContext: Record<string, string>;
    // False until the first reading: nothing is hidden before the window knows where the workspaces are.
    loaded: boolean;
};

export const EmptyScopeFacts: ContextScopeFacts = { contextOf: {}, dirContext: {}, loaded: false };

export function trimDir(dir: string): string {
    return (dir ?? "").replace(/[/\\]+$/, "");
}

// Whether a row of the window's context: its workspace, else its folder; a row that tells neither, or that names a
// workspace nobody knows yet, stays.
export function rowInContext(
    facts: ContextScopeFacts,
    contextId: string,
    row: { workspaceid?: string; dir?: string }
): boolean {
    if (!facts.loaded || !contextId) {
        return true;
    }
    const where = row.workspaceid
        ? facts.contextOf[row.workspaceid]
        : row.dir
          ? facts.dirContext[trimDir(row.dir)]
          : undefined;
    return where == null || where === contextId;
}

// The rows To handle of the window's context. The number of rows set aside with Later stays the list's own: those rows
// are not listed, so none can be told apart.
export function scopeToHandle(list: ToHandleList, facts: ContextScopeFacts, contextId: string): ToHandleList {
    if (!facts.loaded || !contextId) {
        return list;
    }
    const items = list.items.filter((item: ToHandleItem) => rowInContext(facts, contextId, item));
    const info = list.info.filter((item: InfoItem) => rowInContext(facts, contextId, item));
    if (items.length === list.items.length && info.length === list.info.length) {
        return list;
    }
    return { ...list, items, info };
}

// The agents of the window's context. The same object when none is left out, so what reads it does not run again.
export function scopeAgents(data: AgentStatesData, facts: ContextScopeFacts, contextId: string): AgentStatesData {
    if (!facts.loaded || !contextId) {
        return data;
    }
    let left = false;
    const states: AgentStatesData["states"] = {};
    for (const [block, info] of Object.entries(data.states)) {
        if (rowInContext(facts, contextId, info)) {
            states[block] = info;
        } else {
            left = true;
        }
    }
    return left ? { ...data, states } : data;
}

// The keys of the events a window leaves out because they are of another context (FR-BOSS-009, #2476): the rows To handle
// that are not its context's, and the agents that are not its context's, whose finish is an event too. Sorted, so that
// the same set is the same text. Brokk's hub is fed every event and shows only the others: an event that is merely
// out of the window's scope has not ended, so what was told of it is not forgotten for every view.
export function hiddenEventKeys(
    list: ToHandleList,
    data: AgentStatesData,
    facts: ContextScopeFacts,
    contextId: string
): string[] {
    if (!facts.loaded || !contextId) {
        return [];
    }
    const keys: string[] = [];
    for (const item of list.items) {
        if (!rowInContext(facts, contextId, item)) {
            keys.push(item.key);
        }
    }
    for (const [block, info] of Object.entries(data.states)) {
        if (!rowInContext(facts, contextId, info)) {
            keys.push(`finished:${block}`);
        }
    }
    return keys.sort();
}
