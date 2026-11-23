// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { WorkspaceService } from "@/app/store/services";
import { createWindowForWorkspace, getWaveWindowByWorkspaceId } from "./emain-window";
import { handleAppIpc } from "./moltenterm-privileged-ipc";

// must match the channel in emain/preload.ts
const OpenWorkspaceWindowChannel = "moltenterm-open-workspace-window";

export type OpenWorkspaceWindowResult = "opened" | "focused" | "invalid";

export type OpenWorkspaceWindowDeps = {
    exists: (workspaceId: string) => Promise<boolean>;
    // The window showing the workspace, when there is one.
    windowOf: (workspaceId: string) => { show: () => void; focus: () => void } | null;
    open: (workspaceId: string) => Promise<void>;
};

function makeDeps(): OpenWorkspaceWindowDeps {
    return {
        exists: async (workspaceId) => (await WorkspaceService.GetWorkspace(workspaceId).catch((): Workspace => null)) != null,
        windowOf: (workspaceId) => getWaveWindowByWorkspaceId(workspaceId) ?? null,
        open: createWindowForWorkspace,
    };
}

// "Open a context in a new window…" (FR-SHELL-158): the window opens on a workspace the window asked for. A workspace
// another window already shows brings that window forward, never a second window on the same workspace.
export async function openWorkspaceWindow(
    value: unknown,
    deps: OpenWorkspaceWindowDeps = makeDeps()
): Promise<OpenWorkspaceWindowResult> {
    if (typeof value !== "string" || value === "" || !(await deps.exists(value))) {
        return "invalid";
    }
    const shown = deps.windowOf(value);
    if (shown != null) {
        shown.show();
        shown.focus();
        return "focused";
    }
    await deps.open(value);
    return "opened";
}

export function initContextsIpc() {
    handleAppIpc(OpenWorkspaceWindowChannel, (_event, value: unknown) => openWorkspaceWindow(value));
}
