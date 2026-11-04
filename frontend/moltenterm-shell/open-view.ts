// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Opening one of MoltenTerm's views from the shell (the notification center, the status bar): the one already in the
// active tab gets the focus, else a new block opens, in a temporary view when the active one is pinned (FR-SHELL-094).
// A view that was retired opens the one that replaced it.

import { atoms, replaceBlock } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { uxCloseBlock } from "@/app/store/keymodel";
import { getActiveTabModel } from "@/app/store/tab-model";
import * as WOS from "@/app/store/wos";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { atom, Atom } from "jotai";
import { openAppPanel, openFromPanel } from "./app-panel";
import type { PanelOrigin } from "./app-panel-model";
import { currentMissionView } from "./project/project-model";
import { toggleStep } from "./view-toggle-model";

// Focuses the view when the active tab holds it; false when it does not.
export async function focusMoltentermView(requested: string): Promise<boolean> {
    const view = currentMissionView(requested);
    const layoutModel = getLayoutModelForStaticTab();
    const tabAtom = getActiveTabModel()?.tabAtom;
    const tab = tabAtom == null ? null : globalStore.get(tabAtom);
    for (const blockId of tab?.blockids ?? []) {
        const block = await RpcApi.GetMetaCommand(TabRpcClient, { oref: makeORef("block", blockId) });
        if (block?.view !== view) {
            continue;
        }
        const node = layoutModel?.getNodeByBlockId(blockId);
        if (node != null) {
            layoutModel.focusNode(node.id);
            return true;
        }
    }
    return false;
}

// A view opened by an app action (FR-SHELL-094): never added to a pinned view (app-panel.ts). From a call to action
// inside a panel, origin names that panel and the view opens beside it, in the same view (#1844, FR-SHELL-139 AC13).
export async function openMoltentermView(requested: string, origin?: PanelOrigin): Promise<void> {
    const blockDef = { meta: { view: currentMissionView(requested) } };
    if (origin != null) {
        await openFromPanel(origin, blockDef);
        return;
    }
    await openAppPanel(blockDef);
}

// The block of the active tab showing the view, read from the tab's blocks as they are in the store, so a rail button
// can show itself pressed while its view is open (#533, #534).
const ViewInTabAtoms = new Map<string, Atom<string>>();

export function makeViewInActiveTabAtom(requested: string): Atom<string> {
    const view = currentMissionView(requested);
    const cached = ViewInTabAtoms.get(view);
    if (cached != null) {
        return cached;
    }
    const rtn = atom((get) => {
        const tabId = get(atoms.staticTabId);
        if (!tabId) {
            return null;
        }
        const tab = get(WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)));
        for (const blockId of tab?.blockids ?? []) {
            const block = get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
            if (block?.meta?.view === view) {
                return blockId;
            }
        }
        return null;
    });
    ViewInTabAtoms.set(view, rtn);
    return rtn;
}

// The rail's toggle: a second click on a view's button closes the view it opened (#533, #534).
export async function toggleMoltentermView(requested: string, open?: () => Promise<void>): Promise<void> {
    const blockId = globalStore.get(makeViewInActiveTabAtom(requested));
    const tabAtom = getActiveTabModel()?.tabAtom;
    const count = tabAtom == null ? 0 : (globalStore.get(tabAtom)?.blockids?.length ?? 0);
    switch (toggleStep(blockId, count)) {
        case "open":
            await (open ?? (() => openMoltentermView(requested)))();
            return;
        case "replace":
            await replaceBlock(blockId, { meta: { view: "term", controller: "shell" } }, true);
            return;
        case "close":
            uxCloseBlock(blockId);
            return;
    }
}
