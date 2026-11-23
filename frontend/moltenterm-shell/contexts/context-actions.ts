// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What choosing a ribbon does (FR-SHELL-158, FR-SHELL-159, #2476): land the window on a context, or open a context in
// another window. A window is the context of the workspace it shows, so choosing a context is landing on one of its
// workspaces.

import { getApi } from "@/app/store/global";
import { WorkspaceService } from "@/app/store/services";
import { switchFromSidebar } from "../sidebar/sidebar-switch";
import { ContextRibbon, ContextWorkspace, freeWorkspaceOfContext } from "./context-model";
import { assignWorkspaceToContext } from "./context-store";

// A workspace made for a context that holds none, or whose every workspace another window shows. It takes Wave's
// default name and icon, as the workspace of the application menu does.
async function makeWorkspaceIn(contextId: string): Promise<string> {
    const id = await WorkspaceService.CreateWorkspace("", "", "", true);
    if (!id) {
        throw new Error("no workspace id");
    }
    await assignWorkspaceToContext(id, contextId);
    return id;
}

// The window lands on the context's workspace: the one it last showed, else its first; a context with none gets one.
// The window that already shows a workspace comes forward instead, as a dot of the switcher does.
export async function chooseContext(ribbon: ContextRibbon): Promise<void> {
    if (ribbon.here) {
        return;
    }
    const target = ribbon.landing?.id ?? (await makeWorkspaceIn(ribbon.context.id));
    switchFromSidebar(target, 1);
}

// "Open a context in a new window…": another window on a workspace of the context that no window shows, or on a new
// one of that context when every one is shown (FR-SHELL-158). Never a second window on a workspace.
export async function openContextInNewWindow(
    contextId: string,
    entries: readonly ContextWorkspace[],
    last: string
): Promise<void> {
    const target = freeWorkspaceOfContext(contextId, entries, last)?.id ?? (await makeWorkspaceIn(contextId));
    await getApi().openWorkspaceWindow(target);
}
