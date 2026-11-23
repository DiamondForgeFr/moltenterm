// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The windows' side of the contexts (FR-SHELL-158, DS-SHELL-157, #2476). The list is read from the client object and a
// workspace's context from its own meta, both already on every window, so a read needs no call; every write is one call
// to wavesrv's route "molten:contexts" (pkg/molten/contexts/route.go), which validates it and writes the list and the
// moved workspaces in one transaction.

import { ClientModel } from "@/app/store/client-model";
import { atoms, globalStore } from "@/app/store/global";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useAtomValue } from "jotai";
import { useMemo } from "react";
import {
    ContextAssignCommand,
    ContextCreateCommand,
    ContextDeleteCommand,
    ContextInfo,
    ContextsRoute,
    ContextTouchCommand,
    ContextUpdateCommand,
    contextIdOf,
    readContexts,
} from "./context-model";

const ContextsCallTimeoutMs = 10000;

type ContextsResult = { contexts: ContextInfo[]; id?: string };

export type ContextCreateRequest = {
    name: string;
    description?: string;
    emblem?: string;
    workspaces?: string[];
};

export type ContextUpdateRequest = {
    id: string;
    name?: string;
    description?: string;
    emblem?: string;
    // The whole list of workspaces the context holds afterwards.
    workspaces?: string[];
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

// Resolves the new context's id.
export async function createContext(req: ContextCreateRequest): Promise<string> {
    const result = await callContexts(ContextCreateCommand, req);
    return result?.id ?? "";
}

export async function updateContext(req: ContextUpdateRequest): Promise<void> {
    await callContexts(ContextUpdateCommand, req);
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
