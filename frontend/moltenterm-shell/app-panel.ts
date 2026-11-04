// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The one door for a panel an app action opens (FR-SHELL-094): the active view's own panel gets the focus, a temporary
// view takes the panel, and a pinned view stays as the developer pinned it: the view that already shows the panel
// comes forward, else a new temporary view holds it. Panels the developer adds by hand (the launcher, a split, the
// Library's Add to) do not come here.

import { ClientModel } from "@/app/store/client-model";
import { atoms, createBlock, createBlockSplitHorizontally, getApi, getFocusedBlockId } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { appPanelStep, panelCtaStep, PanelMatch, PanelOrigin, sameViewMatch, viewIsPinned } from "./app-panel-model";
import { projectTabIds } from "./hidden-tabs";
import { showTabFromHere } from "./opener-tab";
import { readGlobalPins } from "./sidebar/view-pins-model";
import { openPanelBeside } from "./split/add-beside";
import { revealPanelOnCarpet } from "./view360/carpet-reveal";

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
    // The panel of another project's view would switch the project: only the current project's views are searched (#1760).
    for (const tabId of projectTabIds(ws)) {
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

async function focusPanel(blockId: string, patch: Record<string, any>): Promise<void> {
    await patchPanel(blockId, patch);
    const layoutModel = getLayoutModelForStaticTab();
    const node = layoutModel?.getNodeByBlockId(blockId);
    if (node == null) {
        return;
    }
    // A magnified panel hides the others: the one asked for would stay out of sight.
    if (layoutModel.magnifiedNodeId != null && layoutModel.magnifiedNodeId !== node.id) {
        layoutModel.magnifyNodeToggle(layoutModel.magnifiedNodeId, false);
    }
    layoutModel.focusNode(node.id);
    revealPanelOnCarpet(blockId);
}

// The one door for a call to action inside a panel that opens another panel (#1844, FR-SHELL-139 AC13): the view's own
// panel of that kind gets the focus and what was asked, else the panel opens to the right of the panel the call to
// action is in, in the same view and pinned or not (in 360 view right after that panel's column, the carpet turning to
// it). A new view only when origin asks for one. Without a panel to open beside, it is an app action (openAppPanel).
export async function openFromPanel(
    origin: PanelOrigin,
    blockDef: BlockDef,
    opts: AppPanelOptions = {}
): Promise<void> {
    const sourceBlockId = origin?.blockId ?? null;
    const layoutModel = getLayoutModelForStaticTab();
    const match = opts.match ?? sameViewMatch(blockDef);
    const activeTabId = globalStore.get(atoms.staticTabId);
    const active = activeTabId ? await tabOf(activeTabId) : null;
    const step = panelCtaStep({
        newView: !!origin?.newView,
        inActive: origin?.newView ? null : await panelIn(active, match),
        sourceBlockId,
        sourceLaidOut: sourceBlockId != null && layoutModel?.getNodeByBlockId(sourceBlockId) != null,
    });
    // What was asked is in the panel from the start, as the panel found open gets it written.
    const def = opts.patch == null ? blockDef : { ...blockDef, meta: { ...blockDef.meta, ...opts.patch } };
    switch (step.kind) {
        case "focus":
            await focusPanel(step.blockId, opts.patch);
            return;
        case "beside":
            if ((await openPanelBeside(step.sourceBlockId, def)) == null) {
                await createBlockSplitHorizontally(def, step.sourceBlockId, "after");
            }
            return;
        case "newview":
            getApi().createTab(def);
            return;
        case "door":
            await openAppPanel(blockDef, opts);
            return;
    }
}

// A panel a link needs and the view lacks (a page when no browser panel is open): to the right of the focused panel,
// which is the one the link was clicked in, else where Wave inserts. Never a new view (#1844, FR-SHELL-139 AC13).
export async function createBesideFocused(blockDef: BlockDef): Promise<void> {
    const focused = getFocusedBlockId();
    if (focused != null && (await openPanelBeside(focused, blockDef)) != null) {
        return;
    }
    await createBlock(blockDef);
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
