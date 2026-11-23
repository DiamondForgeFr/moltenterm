// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a view's row, tile or folder cell reads and does the same way (FR-SHELL-081): its pin facts, its menu and its
// close. Kept apart from the sidebar's component file so that the folders' grid shares them (FR-SHELL-080, #2484).

import { atoms, getApi } from "@/app/store/global";
import { getTabModelByTabId } from "@/app/store/tab-model";
import type { TabEnv } from "@/app/tab/tab";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import type { WidgetsEnv } from "@/app/workspace/widgets";
import { deleteLayoutModelForTab } from "@/layout/index";
import { useAtomValue } from "jotai";
import { useCallback, useEffect } from "react";
import { useT } from "../i18n/i18n";
import { closeTabAskingFirst } from "../worktree-close";
import { ViewMenuFolderHooks, viewMenuItems, ViewMenuTarget } from "./view-menu";
import { readViewIcon, ViewIconMetaKey } from "./view-menu-model";
import { GlobalPinMetaKey, isProjectTab, shownViewState, ViewState } from "./view-pins-model";
import { announceClosedViews, ClosedKindCleared, ClosedKindView, ViewPins } from "./view-pins-store";
import { setAsideView } from "./view-set-aside";

export type SidebarEnv = TabEnv & WidgetsEnv;

// What the view menu needs of a view (FR-SHELL-080, FR-SHELL-081): its state, whether it changed since pinned, its
// shown name and the icon the developer chose (its pin's for a view pinned everywhere).
export type ViewPinFacts = { state: ViewState; modified: boolean; name: string; icon: string };

export function useViewPin(tabId: string, tab: Tab, name: string): ViewPinFacts {
    const pins = ViewPins.getInstance();
    const state = shownViewState(useAtomValue(pins.stateAtom(tabId)), isProjectTab(tab));
    const modified = useAtomValue(pins.modifiedAtom(tabId));
    const globalPins = useAtomValue(pins.globalPinsAtom);
    const meta = (tab?.meta ?? {}) as Record<string, any>;
    const pin = state === "everywhere" ? globalPins.find((p) => p.id === meta[GlobalPinMetaKey]) : null;
    const icon = readViewIcon(pin != null ? pin.icon : meta[ViewIconMetaKey]);
    return { state, modified, name: pin?.name ?? name, icon };
}

// The view's menu (FR-SHELL-081) and its close. startRename: the view's own field (a row's or a tile's). folders: what
// the menu offers about folders, for a view of the Views list or of a folder (FR-SHELL-080, #2484).
export function useViewActions(
    tabId: string,
    active: boolean,
    pin: ViewPinFacts,
    startRename: () => void,
    projectTab?: boolean,
    temporary?: boolean,
    folders?: () => ViewMenuFolderHooks
) {
    const env = useWaveEnv<SidebarEnv>();
    const t = useT();
    const ws = useAtomValue(atoms.workspace);
    const confirmClose = useAtomValue(env.getSettingsKeyAtom("tab:confirmclose")) ?? false;
    const close = useCallback(() => {
        // A temporary view closes in one click and goes aside for its toast's Undo (#1656); one that really closes
        // (a worktree answered for, the last view on screen) says so with Undo too, through Put-away views.
        let setAside = false;
        // A pinned view closes in every project of the workspace (#1760): the toast counts what closed.
        let closedCount = 1;
        const opts = {
            ...(temporary
                ? {
                      setAside: async (wsId: string, id: string) => {
                          setAside = await setAsideView(wsId, id);
                          return setAside;
                      },
                  }
                : {}),
            closed: (count: number) => {
                closedCount = count;
            },
        };
        closeTabAskingFirst(getApi().closeTab, ws?.oid, tabId, confirmClose, opts)
            .then((closed) => {
                if (!closed || setAside) {
                    return;
                }
                deleteLayoutModelForTab(tabId);
                return announceClosedViews(ws?.oid, closedCount, closedCount > 1 ? ClosedKindCleared : ClosedKindView);
            })
            .catch((e) => console.log("closing a view from the sidebar", e));
    }, [ws?.oid, tabId, confirmClose, temporary]);
    const onContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const target: ViewMenuTarget = { ref: { tabId }, ...pin, active, projectTab };
        env.showContextMenu(
            viewMenuItems(
                target,
                { startRename, onClose: close, env, at: { x: e.clientX, y: e.clientY }, folders: folders?.() },
                t
            ),
            e
        );
    };
    return { env, close, onContextMenu };
}

// The rename-tab shortcut (and the tab model's rename) opens the view's own field.
export function useRenameCallback(tabId: string, env: SidebarEnv, start: () => void) {
    const tabModel = getTabModelByTabId(tabId, env);
    useEffect(() => {
        tabModel.startRenameCallback = start;
        return () => {
            if (tabModel.startRenameCallback === start) {
                tabModel.startRenameCallback = null;
            }
        };
    }, [tabModel, start]);
}
