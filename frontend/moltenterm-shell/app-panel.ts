// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The one door for a panel an app action opens (FR-SHELL-094): the active view's own panel gets the focus, a temporary
// view takes the panel, and a pinned view stays as the developer pinned it: the view that already shows the panel
// comes forward, else a new temporary view holds it. Panels the developer adds by hand (the launcher, a split, the
// Library's Add to) do not come here.

import { ClientModel } from "@/app/store/client-model";
import { atoms, createBlock, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { appPanelStep, PanelMatch, sameViewMatch, viewIsPinned } from "./app-panel-model";
import { showTabFromHere } from "./opener-tab";
import { readGlobalPins } from "./sidebar/view-pins-model";

export type AppPanelOptions = {
    // Which open panel counts as this one; the same view by default.
    match?: PanelMatch;
    // Written to the panel found open, so it shows what was asked (the settings section).
    patch?: Record<string, any>;
    // In a temporary view, the panel floats over the layout instead of joining it (Preferences).
    ephemeral?: boolean;
};

function globalPinIds(): Set<string> {
    const clientAtom = ClientModel.getInstance().clientAtom;
    const client = clientAtom == null ? null : globalStore.get(clientAtom);
    return new Set(readGlobalPins(client?.meta).map((p) => p.id));
}

async function tabOf(tabId: string): Promise<Tab> {
    const cached = WOS.getObjectValue<Tab>(WOS.makeORef("tab", tabId));
    if (cached != null) {
        return cached;
    }
    return WOS.reloadWaveObject<Tab>(WOS.makeORef("tab", tabId));
}

async function panelIn(tab: Tab, match: PanelMatch): Promise<string> {
    for (const blockId of tab?.blockids ?? []) {
        const meta = await RpcApi.GetMetaCommand(TabRpcClient, { oref: WOS.makeORef("block", blockId) });
        if (meta != null && match(meta)) {
            return blockId;
        }
    }
    return null;
}

async function panelElsewhere(activeTabId: string, match: PanelMatch): Promise<{ tabId: string; blockId: string }> {
    const ws = globalStore.get(atoms.workspace);
    for (const tabId of ws?.tabids ?? []) {
        if (tabId === activeTabId) {
            continue;
        }
        const blockId = await panelIn(await tabOf(tabId), match);
        if (blockId) {
            return { tabId, blockId };
        }
    }
    return null;
}

async function patchPanel(blockId: string, patch: Record<string, any>): Promise<void> {
    if (patch == null) {
        return;
    }
    await RpcApi.SetMetaCommand(TabRpcClient, { oref: WOS.makeORef("block", blockId), meta: patch as MetaType });
}

export async function openAppPanel(blockDef: BlockDef, opts: AppPanelOptions = {}): Promise<void> {
    const match = opts.match ?? sameViewMatch(blockDef);
    const activeTabId = globalStore.get(atoms.staticTabId);
    const active = activeTabId ? await tabOf(activeTabId) : null;
    const activePinned = viewIsPinned(active, globalPinIds());
    const inActive = await panelIn(active, match);
    const step = appPanelStep({
        activePinned,
        inActive,
        elsewhere: inActive || !activePinned ? null : await panelElsewhere(activeTabId, match),
    });
    switch (step.kind) {
        case "focus": {
            await patchPanel(step.blockId, opts.patch);
            const layoutModel = getLayoutModelForStaticTab();
            const node = layoutModel?.getNodeByBlockId(step.blockId);
            if (node != null) {
                layoutModel.focusNode(node.id);
            }
            return;
        }
        case "show":
            await patchPanel(step.blockId, opts.patch);
            showTabFromHere(step.tabId);
            return;
        case "add":
            await createBlock(blockDef, false, !!opts.ephemeral);
            return;
        case "newview":
            getApi().createTab(blockDef);
            return;
    }
}
