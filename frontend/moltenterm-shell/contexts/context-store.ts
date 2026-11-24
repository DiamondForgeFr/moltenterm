// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The windows' side of the contexts (FR-SHELL-158, DS-SHELL-157, #2476). The list is read from the client object and a
// workspace's context from its own meta, both already on every window, so a read needs no call; every write is one call
// to wavesrv's route "molten:contexts" (pkg/molten/contexts/route.go), which validates it and writes the list and the
// moved workspaces in one transaction.

import { ClientModel } from "@/app/store/client-model";
import { atoms, globalStore } from "@/app/store/global";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";
import { isOutsideContextFolder } from "../workspace-project";
import {
    ContextAssignCommand,
    ContextCreateCommand,
    ContextDeleteCommand,
    ContextFolderCheckCommand,
    ContextFolderCommand,
    contextFolderOf,
    contextIdOf,
    ContextInfo,
    ContextsRoute,
    ContextShapesCommand,
    ContextTouchCommand,
    ContextUpdateCommand,
    readContexts,
} from "./context-model";

const ContextsCallTimeoutMs = 10000;

const NoClientAtom = atom(null) as Atom<Client>;

type ContextsResult = { contexts: ContextInfo[]; id?: string };

export type ContextCreateRequest = {
    name: string;
    description?: string;
    emblem?: string;
    shape?: string;
    workspaces?: string[];
};

export type ContextUpdateRequest = {
    id: string;
    name?: string;
    description?: string;
    emblem?: string;
    shape?: string;
    // An absolute folder, or "" to forget it (#2516).
    folder?: string;
    // Only the workspaces the form moved: the ones that come in, and the ones that leave for the first other context. A
    // workspace the form did not show (a blank one of another window, one placed after it opened) is never named.
    addworkspaces?: string[];
    removeworkspaces?: string[];
};

async function callContexts(command: string, data: Record<string, unknown>): Promise<ContextsResult> {
    return await TabRpcClient.wshRpcCall(command, data, { route: ContextsRoute, timeout: ContextsCallTimeoutMs });
}

// The contexts, in order, from the client object.
export function useContexts(): ContextInfo[] {
    const client = useAtomValue(ClientModel.getInstance().clientAtom);
    return useMemo(() => readContexts(client?.meta), [client?.meta]);
}

export function getContexts(): ContextInfo[] {
    return readContexts(globalStore.get(ClientModel.getInstance().clientAtom)?.meta);
}

// The context of the workspace this window shows: the window's own (FR-SHELL-158).
export function useWindowContextId(): string {
    const contexts = useContexts();
    const ws = useAtomValue(atoms.workspace);
    return contextIdOf(contexts, ws?.meta);
}

export function getWindowContextId(): string {
    return contextIdOf(getContexts(), globalStore.get(atoms.workspace)?.meta);
}

// The folder of the context a workspace is in (#2516), the outer bound of its own folder.
// Before the client is known (a preview, a test) there is no context folder.
export function useContextFolder(ws: Workspace): string {
    const client = useAtomValue(ClientModel.getInstance().clientAtom ?? NoClientAtom);
    return contextFolderOf(readContexts(client?.meta), ws?.meta);
}

export function getContextFolder(ws: Workspace): string {
    const clientAtom = ClientModel.getInstance().clientAtom;
    return contextFolderOf(readContexts(clientAtom != null ? globalStore.get(clientAtom)?.meta : null), ws?.meta);
}

// Whether a workspace is in the window's context: what the window lists of the others (the palette, the top field).
export function isInWindowContext(workspaceMeta: Record<string, any>): boolean {
    const contexts = getContexts();
    return contextIdOf(contexts, workspaceMeta) === contextIdOf(contexts, globalStore.get(atoms.workspace)?.meta);
}

// Resolves the new context's id.
export async function createContext(req: ContextCreateRequest): Promise<string> {
    const result = await callContexts(ContextCreateCommand, req);
    return result?.id ?? "";
}

export async function updateContext(req: ContextUpdateRequest): Promise<void> {
    await callContexts(ContextUpdateCommand, req);
}

// Sets a context's folder, the outer bound of its workspaces (#2518). wavesrv takes only an absolute folder.
export async function setContextFolder(id: string, folder: string): Promise<void> {
    await callContexts(ContextFolderCommand, { id, folder });
}

export async function clearContextFolder(id: string): Promise<void> {
    await callContexts(ContextFolderCommand, { id, folder: "" });
}

// must match FolderCheckResult in pkg/molten/contexts/contexts.go
export type WorkspaceFolderCheck = {
    // The folder lies outside its context's folder: the developer is asked before it is kept, never refused.
    outside: boolean;
    contextfolder?: string;
    folder?: string;
    error?: string;
};

// Whether a folder chosen for a workspace lies outside its context's folder (#2518). wavesrv follows symbolic links; when
// it cannot be asked the paths are compared as written, which still catches every folder written outside.
export async function checkWorkspaceFolder(ws: Workspace, folder: string): Promise<WorkspaceFolderCheck> {
    try {
        const result: WorkspaceFolderCheck = await TabRpcClient.wshRpcCall(
            ContextFolderCheckCommand,
            { workspaceid: ws?.oid, folder },
            { route: ContextsRoute, timeout: ContextsCallTimeoutMs }
        );
        return result ?? { outside: false };
    } catch (e) {
        console.log("contexts: checking the workspace folder failed, comparing the paths as written", e);
        return { outside: isOutsideContextFolder(folder, getContextFolder(ws)), error: `${e}` };
    }
}

export async function deleteContext(id: string, moveTo?: string): Promise<void> {
    await callContexts(ContextDeleteCommand, { id, moveto: moveTo ?? "" });
}

export async function assignWorkspaceToContext(workspaceId: string, contextId: string): Promise<void> {
    await callContexts(ContextAssignCommand, { workspaceid: workspaceId, contextid: contextId });
}

export async function touchContext(contextId: string, workspaceId: string): Promise<void> {
    await callContexts(ContextTouchCommand, { contextid: contextId, workspaceid: workspaceId });
}

// Gives shapes, by context id, to the contexts that have none: one that already has one keeps it, so windows that start
// together and each draw theirs agree on the first write.
export async function assignContextShapes(shapes: Record<string, string>): Promise<void> {
    if (Object.keys(shapes).length === 0) {
        return;
    }
    await callContexts(ContextShapesCommand, { shapes });
}

// The context remembers the workspace it showed last, so choosing it lands there. Only a view on screen says so: a
// view kept hidden for a workspace is not a window showing it.
export function useRememberWorkspaceInContext(workspaceId: string, saved: boolean, contextId: string) {
    useEffect(() => {
        if (!workspaceId || !contextId || !saved) {
            return;
        }
        const remember = () => {
            if (document.visibilityState !== "visible") {
                return;
            }
            fireAndForget(async () => {
                try {
                    await touchContext(contextId, workspaceId);
                } catch (e) {
                    console.log("contexts: remembering the workspace", e);
                }
            });
        };
        remember();
        document.addEventListener("visibilitychange", remember);
        return () => document.removeEventListener("visibilitychange", remember);
    }, [workspaceId, saved, contextId]);
}

// A workspace the window just made goes into the window's context (FR-SHELL-158). The first context holds every
// workspace that names none, so nothing is written for it.
export async function placeInWindowContext(workspaceId: string): Promise<void> {
    const contexts = getContexts();
    const current = contextIdOf(contexts, globalStore.get(atoms.workspace)?.meta);
    if (!workspaceId || current === contexts[0]?.id) {
        return;
    }
    await assignWorkspaceToContext(workspaceId, current);
}
