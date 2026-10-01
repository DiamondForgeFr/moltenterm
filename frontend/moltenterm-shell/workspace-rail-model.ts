// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The entries of the workspace rail (FR-SHELL-001), from Wave's workspace list. Kept apart from the component so the
// rules can be tested without the app.

export type WorkspaceRailSource = { workspace: Workspace; windowId: string };

export type WorkspaceRailEntry = {
    id: string;
    name: string;
    icon: string;
    color: string;
    // Wave calls a workspace without a name and an icon "unsaved": it lives only with its window.
    saved: boolean;
    active: boolean;
    // Open in a window, this one or another.
    open: boolean;
};

export function isSavedWorkspace(ws: Workspace): boolean {
    return !!(ws?.name && ws?.icon);
}

function toEntry(ws: Workspace, windowId: string, activeId: string): WorkspaceRailEntry {
    return {
        id: ws.oid,
        name: ws.name || "Unsaved workspace",
        icon: ws.icon,
        color: ws.color,
        saved: isSavedWorkspace(ws),
        active: ws.oid === activeId,
        open: !!windowId,
    };
}

// The order is Wave's. An unsaved active workspace is not in Wave's list, so it comes first, where the user sees it.
export function makeWorkspaceRailEntries(sources: WorkspaceRailSource[], active: Workspace): WorkspaceRailEntry[] {
    const activeId = active?.oid;
    const entries = (sources ?? [])
        .filter((s) => s?.workspace?.oid)
        .map((s) => toEntry(s.workspace, s.windowId, activeId));
    if (active != null && !entries.some((e) => e.id === activeId)) {
        entries.unshift(toEntry(active, "this-window", activeId));
    }
    return entries;
}
