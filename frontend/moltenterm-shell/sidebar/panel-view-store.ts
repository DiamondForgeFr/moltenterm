// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// A view made from a panel (FR-SHELL-080, #2548), from the panel's menu or by dropping it on the sidebar: the view holds
// a copy of that panel, at the place chosen, and the panel stays where it is. A panel that holds an agent asks first,
// because an agent cannot live in two places. The rules are in panel-view-model.ts, the drop in panel-view-drop.tsx.

import { atoms, getApi, globalStore, WOS } from "@/app/store/global";
import * as jotai from "jotai";
import { agentStatesOfBlocks } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { contextShownName } from "../contexts/context-model";
import { getContexts, getWindowContextId } from "../contexts/context-store";
import { hiddenTabIds, tabProjectsOf } from "../hidden-tabs";
import { t } from "../i18n/i18n";
import { PanelMeta, panelViewName as tabPanelViewName } from "../tab-identity";
import { getHomeDir } from "../tab-identity-ui";
import { showToast } from "../toast-store";
import { workspaceShownName } from "../workspace-default-name";
import { createViewFromPanel, PanelViewDeps } from "./panel-view-create";
import {
    AgentAnswer,
    captionOf,
    foldersOfViews,
    PanelHit,
    PanelViewDestination,
    PanelViewFolder,
    PanelViewMenuFacts,
    PanelViewNames,
} from "./panel-view-model";
import { currentFolders, listTabs } from "./view-folders-store";
import { isProjectTab, viewStateOf } from "./view-pins-model";
import { ViewPins } from "./view-pins-store";
import { currentProjectId, projectLabel, readProjects } from "./workspace-projects";

// A panel being dragged over the sidebar: which one, and the zone it is over. null when no panel is dragged.
export type PanelViewDrag = { blockId: string; hit: PanelHit };

export const panelViewDragAtom = jotai.atom(null) as jotai.PrimitiveAtom<PanelViewDrag>;

// The tabs and pins a view made from a panel just made: they flow in (FR-SHELL-080, molten-motion).
export const freshViewsAtom = jotai.atom([]) as jotai.PrimitiveAtom<string[]>;
const FreshMs = 1200;

function markFresh(...ids: string[]) {
    const keys = ids.filter((id) => !!id);
    if (keys.length === 0) {
        return;
    }
    globalStore.set(freshViewsAtom, [...globalStore.get(freshViewsAtom), ...keys]);
    setTimeout(() => {
        const left = globalStore.get(freshViewsAtom).filter((id) => !keys.includes(id));
        globalStore.set(freshViewsAtom, left);
    }, FreshMs);
}

function tabOf(tabId: string): Tab {
    return globalStore.get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
}

// The temporary views of a project, in order: the current project's are the list on screen; another's, the workspace's
// tabs its map names, pinned ones left out.
export function viewsOfProject(ws: Workspace, projectId: string): string[] {
    const many = readProjects(ws).length > 1;
    if (!many || !projectId || projectId === currentProjectId(ws)) {
        return listTabs();
    }
    const owners = tabProjectsOf(ws);
    const hidden = hiddenTabIds(ws);
    const ids = new Set(globalStore.get(ViewPins.getInstance().globalPinsAtom).map((p) => p.id));
    return (ws?.tabids ?? []).filter((id) => {
        const tab = tabOf(id);
        return (
            owners[id] === projectId &&
            !hidden.includes(id) &&
            tab != null &&
            !isProjectTab(tab) &&
            viewStateOf(tab, ids) === "temporary"
        );
    });
}

export function folderNameOf(folderId: string): string {
    const folder = currentFolders().find((f) => f.id === folderId);
    return folder?.name || t("sidebar.folders.name.mixed");
}

export function panelViewNames(): PanelViewNames {
    const ws = globalStore.get(atoms.workspace);
    const contexts = getContexts();
    const context = contexts.find((c) => c.id === getWindowContextId());
    const projects = readProjects(ws);
    return {
        context: context != null ? contextShownName(context, t) : "",
        workspace: workspaceShownName(ws?.name, t) || t("rail.unsavedWorkspace"),
        projectOf: (projectId) => {
            const project = projects.find((p) => p.id === (projectId || currentProjectId(ws)));
            return project != null && projects.length > 0 ? projectLabel(project) : "";
        },
        folderName: folderNameOf,
    };
}

// What the panel's menus offer now.
export function panelViewMenuFacts(): PanelViewMenuFacts {
    const ws = globalStore.get(atoms.workspace);
    const names = panelViewNames();
    const projects = readProjects(ws);
    const folders = currentFolders();
    return {
        contextName: names.context,
        workspaceName: names.workspace,
        projects: projects.map((p) => ({ id: p.id, label: projectLabel(p) })),
        currentProjectId: currentProjectId(ws) ?? "",
        foldersOf: (projectId): PanelViewFolder[] =>
            foldersOfViews(viewsOfProject(ws, projectId), folders).map((f) => ({
                id: f.id,
                name: f.name || t("sidebar.folders.name.mixed"),
            })),
    };
}

// The sentence a zone shows while a panel is dragged over it.
export function captionText(dest: PanelViewDestination): string {
    const phrase = captionOf(dest, panelViewNames());
    return t(phrase.key, phrase.vars);
}

export function isAgentPanel(blockId: string): boolean {
    const data = globalStore.get(AgentStates.getInstance().dataAtom);
    return agentStatesOfBlocks(data, [blockId]).length > 0;
}

// The question an agent's panel asks: no answer (the toast dismissed) is none.
export function askAgentMove(): Promise<AgentAnswer> {
    return new Promise((resolve) => {
        let answered = false;
        const answer = (value: AgentAnswer) => {
            answered = true;
            resolve(value);
        };
        showToast({
            id: "panel-view-agent",
            kind: "warning",
            title: t("sidebar.panelView.agentAsk"),
            message: t("sidebar.panelView.agentAskHint"),
            question: true,
            stays: true,
            actions: [
                { id: "move", label: t("sidebar.panelView.agentMove"), run: () => answer("move") },
                { id: "stay", label: t("sidebar.panelView.agentStay"), run: () => answer("stay") },
            ],
            onDismiss: () => {
                if (!answered) {
                    resolve(null);
                }
            },
        });
    });
}

// The name the app gives a view made of that one panel (a web page by its site, a terminal by its folder), so the new
// view reads as any other of the list.
export function panelViewName(blockId: string): string {
    const meta = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)))?.meta;
    const name = tabPanelViewName(meta as PanelMeta, getHomeDir());
    return name || t("sidebar.panelView.unnamed");
}

function liveDeps(): PanelViewDeps {
    const pins = ViewPins.getInstance();
    return {
        sourceTabId: () => globalStore.get(atoms.staticTabId),
        holds: (tabId, blockId) => (tabOf(tabId)?.blockids ?? []).includes(blockId),
        isAgent: isAgentPanel,
        askAgent: askAgentMove,
        capture: (tabId, blockId, copy) => pins.capturePanel(tabId, blockId, copy),
        blockName: panelViewName,
        names: panelViewNames,
        createView: (req) => pins.createView(req),
        placeBefore: (tabId, beforeId) => pins.placeBefore(tabId, beforeId),
        addToFolder: async (folderId, tabId) => (await import("./view-folders-ops")).addViewToFolder(folderId, tabId),
        notice: (text, tabId) =>
            showToast({
                id: `panel-view:${tabId}`,
                title: text,
                actions: [{ id: "open", label: t("sidebar.panelView.open"), run: () => getApi().setActiveTab(tabId) }],
            }),
        fresh: markFresh,
        failed: (e: any) =>
            showToast({ kind: "error", title: t("sidebar.panelView.failed"), message: String(e?.message ?? e) }),
        translate: t,
    };
}

// The one way to make a view from a panel in the window: the panel's menus and the sidebar's drop.
export function makeViewFromPanel(blockId: string, destination: PanelViewDestination): Promise<string> {
    return createViewFromPanel({ blockId, destination }, liveDeps());
}
