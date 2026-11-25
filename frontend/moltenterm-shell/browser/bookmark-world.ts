// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the bookmark surfaces (the popover, the column panel, Settings) read of the app (#2531): the bookmarks in the
// client's meta, where the developer stands (context, workspace, project of the panel's tab) and the places a bookmark
// can be at, from the contexts and every saved workspace. Hooks only; the rules are in bookmarks.ts and bookmark-places.ts.

import { ClientModel } from "@/app/store/client-model";
import { atoms } from "@/app/store/global";
import { atom, Atom, useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";
import { contextShownName, type ContextInfo } from "../contexts/context-model";
import { useContexts } from "../contexts/context-store";
import { useT, type TFunction } from "../i18n/i18n";
import { projectLabel, readProjects } from "../sidebar/workspace-projects";
import { subscribeWorkspaceSources } from "../workspace-sources";
import { makeWorkspaceRailEntries, type WorkspaceRailSource } from "../workspace-rail-model";
import { BookmarkStore, Here, hereOf, readStore } from "./bookmarks";
import { buildCatalog, type PlaceCatalog } from "./bookmark-places";

const NoClientAtom = atom(null) as Atom<Client>;

export function useBookmarkStore(): BookmarkStore {
    const client = useAtomValue(ClientModel.getInstance().clientAtom ?? NoClientAtom);
    return useMemo(() => readStore(client?.meta), [client?.meta]);
}

export function useHere(tabId: string): Here {
    const ws = useAtomValue(atoms.workspace);
    const contexts = useContexts();
    return useMemo(() => hereOf(ws, contexts, tabId), [ws, contexts, tabId]);
}

// The places of the app, as every window knows them: the workspaces the rail lists (saved ones and the one on screen,
// the latter read from the window's own object, which is the freshest) and each one's projects.
export function catalogFromWorkspaces(
    sources: readonly WorkspaceRailSource[],
    active: Workspace,
    contexts: readonly ContextInfo[],
    t: TFunction
): PlaceCatalog {
    const entries = makeWorkspaceRailEntries([...(sources ?? [])], active, contexts).filter((e) => e.saved || e.active);
    const workspaces = new Map<string, Workspace>();
    for (const s of sources ?? []) {
        workspaces.set(s.workspace.oid, s.workspace);
    }
    if (active != null) {
        workspaces.set(active.oid, active);
    }
    return buildCatalog({
        appName: t("browser.bookmarks.place.app"),
        contexts: contexts.map((context) => ({ context, name: contextShownName(context, t) })),
        workspaces: entries.map((e) => ({
            id: e.id,
            name: e.name,
            color: e.color,
            contextId: e.contextId,
            projects: readProjects(workspaces.get(e.id)).map((p) => ({ id: p.id, name: projectLabel(p) || p.id })),
        })),
    });
}

export function useCatalog(): PlaceCatalog {
    const t = useT();
    const ws = useAtomValue(atoms.workspace);
    const contexts = useContexts();
    const [sources, setSources] = useState<WorkspaceRailSource[]>([]);
    useEffect(() => subscribeWorkspaceSources(setSources), []);
    return useMemo(() => catalogFromWorkspaces(sources, ws, contexts, t), [sources, ws, contexts, t]);
}
