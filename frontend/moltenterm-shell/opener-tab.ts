// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Opener tabs (#892, pkg/molten/openertab.go): a tab MoltenTerm shows on the developer's behalf from this tab (a PR's
// Review tab from the PR list, an agent's tab...) keeps this tab's id in its meta, and closing it comes back here
// instead of landing on its neighbour. Tabs the developer makes by hand never carry it.

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";

// must match pkg/molten/openertab.go
export const OpenerTabMetaKey = "molten:openertab";

export type OpenerTabDeps = {
    currentTabId: () => string;
    setOpener: (tabId: string, openerTabId: string) => Promise<void>;
    activate: (tabId: string) => void;
};

const DefaultDeps: OpenerTabDeps = {
    currentTabId: () => globalStore.get(atoms.staticTabId),
    setOpener: (tabId, openerTabId) =>
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: makeORef("tab", tabId),
            meta: { [OpenerTabMetaKey]: openerTabId } as MetaType,
        }),
    activate: (tabId) => getApi().setActiveTab(tabId),
};

// showTabFromHere activates tabId and records this window's tab as its opener. The opener is written without holding
// the switch back: closing the tab comes much later, and a failed write only keeps Wave's neighbour rule.
export function showTabFromHere(tabId: string, deps: OpenerTabDeps = DefaultDeps) {
    if (!tabId) {
        return;
    }
    deps.activate(tabId);
    // The window's own tab is static: reading it after the switch still names the tab the developer was in.
    const record = async () => {
        const opener = deps.currentTabId();
        if (!opener || opener === tabId) {
            return;
        }
        await deps.setOpener(tabId, opener);
    };
    record().catch((e) => console.log("[#892] could not record the opener tab", tabId, e));
}
