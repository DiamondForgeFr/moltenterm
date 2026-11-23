// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The entries of the workspace rail (FR-SHELL-001), from Wave's workspace list. Kept apart from the component so the
// rules can be tested without the app.

import { ContextInfo, contextIdOf } from "./contexts/context-model";
import { t } from "./i18n/i18n";
import { workspaceShownName } from "./workspace-default-name";

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
    // The context the workspace is in (FR-SHELL-158); "" when the entries were made without the contexts.
    contextId?: string;
};

export function isSavedWorkspace(ws: Workspace): boolean {
    return !!(ws?.name && ws?.icon);
}

function toEntry(
    ws: Workspace,
    windowId: string,
    activeId: string,
    contexts: readonly ContextInfo[]
): WorkspaceRailEntry {
    return {
        id: ws.oid,
        name: workspaceShownName(ws.name, t) || t("rail.unsavedWorkspace"),
        icon: ws.icon,
        color: ws.color,
        saved: isSavedWorkspace(ws),
        active: ws.oid === activeId,
        open: !!windowId,
        contextId: contexts == null ? "" : contextIdOf(contexts, ws.meta),
    };
}

// The order is Wave's. An unsaved active workspace is not in Wave's list, so it comes first, where the user sees it.
// With the contexts, each entry knows its own (FR-SHELL-158).
export function makeWorkspaceRailEntries(
    sources: WorkspaceRailSource[],
    active: Workspace,
    contexts?: readonly ContextInfo[]
): WorkspaceRailEntry[] {
    const activeId = active?.oid;
    const entries = (sources ?? [])
        .filter((s) => s?.workspace?.oid)
        .map((s) => toEntry(s.workspace, s.windowId, activeId, contexts));
    if (active != null && !entries.some((e) => e.id === activeId)) {
        entries.unshift(toEntry(active, "this-window", activeId, contexts));
    }
    return entries;
}
