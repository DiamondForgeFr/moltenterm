// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The top row of the sidebar belongs to the context (FR-SHELL-080, #2526): the views pinned everywhere are kept in the
// client's meta, one row per context under its own key, so two windows that pin in different contexts never overwrite
// each other. A workspace shows the row of the context it is in. Their Go twin is pkg/molten/contextpins, which copies
// the one row of earlier versions into every context, once.

import { contextIdOf, readContexts } from "../contexts/context-model";
import { GlobalPin, readPinList } from "./view-pins-model";

// must match pkg/molten/contextpins/contextpins.go
export const ContextPinsKeyPrefix = "molten:contextpins:";

export function contextPinsKey(contextId: string): string {
    return `${ContextPinsKeyPrefix}${contextId}`;
}

// A context holds a row of its own once it has one, empty or not.
export function hasContextPins(clientMeta: Record<string, any>, contextId: string): boolean {
    return Array.isArray(clientMeta?.[contextPinsKey(contextId)]);
}

export function readContextPins(clientMeta: Record<string, any>, contextId: string): GlobalPin[] {
    return readPinList(clientMeta?.[contextPinsKey(contextId)]);
}

// The pins of every context's row, for what looks at all the views the developer pinned (the lookalike warning knows
// every pinned page, whichever context pinned it).
export function readAllContextPins(clientMeta: Record<string, any>): GlobalPin[] {
    return Object.keys(clientMeta ?? {})
        .filter((key) => key.startsWith(ContextPinsKeyPrefix))
        .flatMap((key) => readPinList(clientMeta[key]));
}

// The id of the context a window shows: the one of its workspace.
export function windowContextIdOf(clientMeta: Record<string, any>, workspaceMeta: Record<string, any>): string {
    return contextIdOf(readContexts(clientMeta), workspaceMeta);
}

// The row a window shows, read from the client's and the workspace's meta alone.
export function windowContextPins(clientMeta: Record<string, any>, workspaceMeta: Record<string, any>): GlobalPin[] {
    return readContextPins(clientMeta, windowContextIdOf(clientMeta, workspaceMeta));
}

// The client meta that gives a new context its starting row: a copy of the row of the context the developer made it
// from, which the two then change on their own. MoltenTerm pins nothing on its own (#1709), so a context never starts
// with views it chose. null when the context already holds a row, so a start is written once.
export function startingPinsPatch(
    clientMeta: Record<string, any>,
    contextId: string,
    fromContextId: string
): Record<string, any> {
    if (!contextId || hasContextPins(clientMeta, contextId)) {
        return null;
    }
    return { [contextPinsKey(contextId)]: readContextPins(clientMeta, fromContextId) };
}
