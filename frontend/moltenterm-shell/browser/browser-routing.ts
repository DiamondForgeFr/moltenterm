// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Every web page Moltenterm opens inside the app goes through openInBrowserPanel (#140): it becomes a new tab of the
// browser panel the user last focused in the current tab, and only gets a panel of its own when the tab has none.
// wsh does the same from the backend (cmd/wsh/cmd/wshcmd-molten-browser.go) through the block meta BrowserOpenMetaKey.

import { atoms, createBlock, getBlockComponentModel } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import {
    browserBlockDef,
    BrowserRecentMetaKey,
    MoltentermBrowserView,
    noteBrowserFocus,
    pickBrowserPanel,
} from "./browser-model";

// What BrowserViewModel offers here, without importing the view (which imports the global store).
type BrowserPanelModel = ViewModel & { openUrlInNewTab: (url: string) => void };

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

export async function openInBrowserPanel(url: string): Promise<void> {
    const tab = currentTab();
    const targetId = pickBrowserPanel(browserPanelsOfTab(tab), tab?.meta?.[BrowserRecentMetaKey]);
    const model = targetId ? browserPanelModel(targetId) : null;
    if (model != null) {
        model.openUrlInNewTab(url);
        return;
    }
    await createBlock(browserBlockDef(url));
}

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
