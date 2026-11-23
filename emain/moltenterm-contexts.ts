// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Electron main's part of the contexts (FR-SHELL-158, #2476): a workspace it makes for a window goes into that window's
// context, and a new blank window starts in the context of the window that was focused. The rules are the windows'
// (frontend/moltenterm-shell/contexts/context-model.ts); a write is one call to wavesrv's route "molten:contexts".

import { ClientService, WorkspaceService } from "@/app/store/services";
import {
    ContextAssignCommand,
    contextIdOf,
    ContextsRoute,
    readContexts,
} from "../frontend/moltenterm-shell/contexts/context-model";
import { ElectronWshClient } from "./emain-wsh";

const ContextsCallTimeoutMs = 10000;

export type ContextsBackend = {
    clientMeta: () => Promise<Record<string, any>>;
    workspaceMeta: (workspaceId: string) => Promise<Record<string, any>>;
    assign: (workspaceId: string, contextId: string) => Promise<void>;
};

const RealBackend: ContextsBackend = {
    clientMeta: async () => (await ClientService.GetClientData())?.meta,
    workspaceMeta: async (workspaceId) => (await WorkspaceService.GetWorkspace(workspaceId))?.meta,
    assign: async (workspaceId, contextId) => {
        await ElectronWshClient.wshRpcCall(
            ContextAssignCommand,
            { workspaceid: workspaceId, contextid: contextId },
            { route: ContextsRoute, timeout: ContextsCallTimeoutMs }
        );
    },
};

// Puts a workspace just made in the context of another one (the window's, or the one it replaces). The first context
// holds every workspace that names none, so nothing is written for it. A failure is logged and never stops the new
// workspace: it then sits in the first context.
export async function placeInContextOf(
    newWorkspaceId: string,
    fromWorkspaceId: string,
    backend: ContextsBackend = RealBackend
): Promise<void> {
    if (!newWorkspaceId || !fromWorkspaceId) {
        return;
    }
    try {
        const contexts = readContexts(await backend.clientMeta());
        const from = contextIdOf(contexts, await backend.workspaceMeta(fromWorkspaceId));
        if (from === contexts[0]?.id) {
            return;
        }
        await backend.assign(newWorkspaceId, from);
    } catch (e) {
        console.log("placeInContextOf: the new workspace stays in the first context", newWorkspaceId, e);
    }
}
