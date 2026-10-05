// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Every web page Moltenterm opens inside the app goes through openInBrowserPanel (#140): it becomes a new tab of the
// browser panel the user last focused in the current tab, and only gets a panel of its own when the tab has none.
// wsh does the same from the backend (cmd/wsh/cmd/wshcmd-molten-browser.go) through a queue in the block meta (BrowserOpenKeyPrefix).

import { atoms, createBlock, getBlockComponentModel } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { BrowserEngineModel, browserOpen, BrowserRoute, EngineApp, fallbackNotice } from "./browser-engine";
import {
    browserBlockDef,
    BrowserRecentMetaKey,
    MoltentermBrowserView,
    noteBrowserFocus,
    pickBrowserPanel,
} from "./browser-model";

// What BrowserViewModel offers here, without importing the view (which imports the global store).
type BrowserPanelModel = ViewModel & {
    openUrlInNewTab: (url: string) => void;
    addHandoffEntry: (url: string, engine: string) => void;
    showNotice: (text: string) => void;
};

function currentTab(): Tab {
    const tabId = globalStore.get(atoms.staticTabId);
    return tabId ? WOS.getObjectValue<Tab>(WOS.makeORef("tab", tabId)) : null;
}

function browserPanelsOfTab(tab: Tab): string[] {
    return (tab?.blockids ?? []).filter((blockId) => {
        const block = WOS.getObjectValue<Block>(WOS.makeORef("block", blockId));
        return block?.meta?.view === MoltentermBrowserView;
    });
}

function browserPanelModel(blockId: string): BrowserPanelModel {
    const viewModel = getBlockComponentModel(blockId)?.viewModel as BrowserPanelModel;
    if (viewModel?.viewType !== MoltentermBrowserView || typeof viewModel.openUrlInNewTab !== "function") {
        return null;
    }
    return viewModel;
}

// A page whose site (or the default engine) is set to the installed browser opens there (FR-BRW-002); wavesrv routes
// it. Null when the page stays here, with the reason when it was meant for a browser that could not take it.
async function routeToInstalledBrowser(url: string): Promise<{ route: BrowserRoute; notice: string }> {
    if (!BrowserEngineModel.getInstance().needsRouting(url)) {
        return { route: null, notice: null };
    }
    try {
        const route = await browserOpen(url);
        return { route, notice: fallbackNotice(route) };
    } catch (e) {
        console.log("molten browser: routing failed, the page opens here", e);
        return { route: null, notice: null };
    }
}

export async function openInBrowserPanel(url: string): Promise<void> {
    const tab = currentTab();
    const targetId = pickBrowserPanel(browserPanelsOfTab(tab), tab?.meta?.[BrowserRecentMetaKey]);
    const model = targetId ? browserPanelModel(targetId) : null;
    const { route, notice } = await routeToInstalledBrowser(url);
    if (route != null && route.engine !== EngineApp) {
        // The handed-off entry goes to the tab's panel; no panel opens just for it.
        model?.addHandoffEntry(url, route.engine);
        return;
    }
    if (model != null) {
        model.openUrlInNewTab(url);
        if (notice) {
            model.showNotice(notice);
        }
        return;
    }
    await createBlock(browserBlockDef(url, notice));
}

// The browser panel a palette action applies to: the pane it was opened from when that is a browser panel, else the
// one links go to.
export function browserPanelForAction(originBlockId: string): string {
    const tab = currentTab();
    const panels = browserPanelsOfTab(tab);
    if (originBlockId && panels.includes(originBlockId)) {
        return originBlockId;
    }
    return pickBrowserPanel(panels, tab?.meta?.[BrowserRecentMetaKey]);
}

// The palette's "Open in <browser>" (FR-BRW-002): hands the panel's active page off.
export async function handOffActivePage(originBlockId: string): Promise<void> {
    const panelId = browserPanelForAction(originBlockId);
    const model = panelId ? (browserPanelModel(panelId) as BrowserPanelModel & HandOffModel) : null;
    if (model == null || typeof model.handOffActiveTab !== "function") {
        return;
    }
    await model.handOffActiveTab();
}

type HandOffModel = { handOffActiveTab: () => Promise<void> };

// Called by a browser panel when it gains focus: the tab remembers it as the target of the next link.
export function noteBrowserPanelFocus(blockId: string): void {
    const tab = currentTab();
    if (tab == null) {
        return;
    }
    const recent = noteBrowserFocus(tab.meta?.[BrowserRecentMetaKey], blockId);
    if (recent == null) {
        return;
    }
    fireAndForget(() =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("tab", tab.oid),
            meta: { [BrowserRecentMetaKey]: recent } as MetaType,
        })
    );
}
